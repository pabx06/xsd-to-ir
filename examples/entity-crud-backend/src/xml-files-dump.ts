import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Knex } from "knex";
import { Router, type Request } from "express";
import { z } from "zod";
import { CrudError } from "./entity-crud.errors";
import type { EntityCrudRegistry } from "./entity-crud.registry";
import {
  acknowledgeExport,
  allocateExportSequence,
} from "./identity-lifecycle";
import { MariaDbEntityIdentityHistory } from "./mariadb-entity-identity-history";
import {
  DBAdapter,
  getAssetPath,
  getS3000LSchemaPath,
  serializeToXML,
} from "./xsd-runtime";

const fileNameSchema = z
  .string()
  .min(5)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.xml$/i);
const requestSchema = z
  .object({ id: z.string().trim().min(1).max(10), fileName: fileNameSchema })
  .strict();

async function validateFile(file: string, issue: string) {
  try {
    await promisify(execFile)(process.execPath, [
      getAssetPath("scripts", "validate-xsd11.js"),
      "--skip-self-test",
      "--xsd",
      getS3000LSchemaPath(issue),
      "--xml",
      file,
    ]);
  } catch (error) {
    // Xerces reports document constraints with a cvc-* code. Report its first
    // diagnostic without returning host filesystem paths or command arguments.
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const diagnostic =
      /^(?:error|fatal): .*?:(\d+):(\d+): (cvc-[^\r\n]+)/m.exec(stderr);
    if (diagnostic)
      throw new CrudError(
        "invalid_export_xml",
        `Issue ${issue}, line ${diagnostic[1]}, column ${diagnostic[2]}. ${diagnostic[3]}`,
        422,
      );
    throw error;
  }
}

async function statIfPresent(file: string) {
  try {
    return await lstat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const conflict = () =>
  new CrudError(
    "export_file_conflict",
    "This export filename is already in use.",
    409,
  );

// An uncommitted publication has two links to the same inode. The hidden
// link is retained across COMMIT so a retry can distinguish it from a stranger's file.
async function recoverUncommitted(stage: string, target: string) {
  const staged = await statIfPresent(stage);
  if (!staged) return;
  if (!staged.isFile()) throw conflict();
  const published = await statIfPresent(target);
  if (published && published.dev === staged.dev && published.ino === staged.ino)
    await rm(target);
  await rm(stage);
}

async function matchesReceipt(file: string, digest: string) {
  if (!(await statIfPresent(file))?.isFile()) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex") === digest;
}

export interface DumpOptions {
  projectDb: Knex;
  registry: EntityCrudRegistry;
  projectId: string;
  issue: string;
  directory: string;
  fileName: string;
  /** Must reject invalid XML against the selected issue's XSD 1.1 schema. */
  validate?: (stage: string, issue: string) => Promise<void>;
}

export async function dumpProjectXml(options: DumpOptions) {
  const {
    projectDb,
    registry,
    projectId,
    issue,
    directory,
    fileName,
    validate = validateFile,
  } = options;
  if (!fileNameSchema.safeParse(fileName).success)
    throw new CrudError("invalid_request", "Invalid XML filename.");
  if (issue !== "1.1" && issue !== "2.0")
    throw new CrudError(
      "unsupported_issue",
      "Unsupported project schema issue.",
    );
  const target = path.resolve(directory, fileName);
  const key = createHash("sha256")
    .update(JSON.stringify([projectId, fileName]))
    .digest("hex");
  const stage = path.resolve(directory, `.xml-export-${key}.pending`);
  const result = await projectDb.transaction(async (trx) => {
    await new MariaDbEntityIdentityHistory().lock(trx);
    const receipt = await trx("_entity_xml_export")
      .where({ file_name: fileName })
      .select("sha256", trx.raw("CAST(?? AS CHAR) AS sequence", ["sequence"]))
      .first();
    if (receipt) {
      if (!(await matchesReceipt(target, receipt.sha256))) throw conflict();
      return { fileName, sequence: String(receipt.sequence), replay: true };
    }

    await recoverUncommitted(stage, target);
    if (await statIfPresent(target)) throw conflict();
    const sequence = await allocateExportSequence(trx);
    const ir = registry.getIR(issue);
    const { xml, exportedRecords } = await serializeToXML(
      ir,
      new DBAdapter(trx, ir),
      {
        version: issue,
        msgType: "B",
        msgId: `MSG-${sequence}`,
        includeExportedRecords: true,
      },
    );
    const staged = await open(stage, "wx");
    try {
      try {
        await staged.writeFile(xml, "utf8");
        await staged.sync();
      } finally {
        await staged.close();
      }
      await validate(stage, issue);
      try {
        await link(stage, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw conflict();
        throw error;
      }
      const directoryHandle = await open(path.dirname(target), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      await acknowledgeExport(
        trx,
        registry,
        issue,
        exportedRecords,
        sequence,
        "baseline",
      );
      await trx("_entity_xml_export").insert({
        file_name: fileName,
        sequence,
        sha256: createHash("sha256").update(xml).digest("hex"),
      });
    } catch (error) {
      await recoverUncommitted(stage, target);
      throw error;
    }
    return { fileName, sequence, replay: false };
  });
  // A failed/unknown SQL COMMIT never reaches this point. Its stage remains
  // available for reconciliation under the project lock on the next request.
  await rm(stage, { force: true });
  return result;
}

interface RouteDependencies {
  directory: string;
  registry: EntityCrudRegistry;
  /** Resolve the authenticated, authorized, ready project, or throw the host HTTP error. */
  resolveProject(
    request: Request,
    id: string,
  ): Promise<{ projectDb: Knex; issue: string; projectId: string }>;
  validate?: DumpOptions["validate"];
}

/** Mount under the host's session and CSRF middleware on Express 4. */
export function createXmlFilesDumpRouter(deps: RouteDependencies) {
  const router = Router();
  router.post("/xml-files-dump", async (req, res, next) => {
    try {
      const input = requestSchema.safeParse(req.body);
      if (!input.success)
        throw new CrudError(
          "invalid_request",
          "Supply a project ID and a valid XML filename.",
        );
      const { id, fileName } = input.data;
      const project = await deps.resolveProject(req, id);
      const result = await dumpProjectXml({
        ...project,
        registry: deps.registry,
        directory: deps.directory,
        fileName,
        validate: deps.validate,
      });
      res.status(result.replay ? 200 : 201).json({
        fileName,
        sequence: result.sequence,
        message: "XML file exported successfully",
      });
    } catch (error) {
      if (error instanceof CrudError)
        res
          .status(error.httpStatus)
          .json({ error: error.code, message: error.message });
      else next(error);
    }
  });
  return router;
}
