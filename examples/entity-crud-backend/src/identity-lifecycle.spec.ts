import type { Knex } from "knex";
import { describe, expect, it, vi } from "vitest";
import { organization, tracked } from "../test-support/fixtures";
import { CrudError, CrudValidationError } from "./entity-crud.errors";
import { reconcileImportedRemovals } from "./identity-lifecycle";
import { MariaDbEntityIdentityHistory } from "./mariadb-entity-identity-history";
import type { Value } from "./xsd-runtime";

const trx = {} as Knex.Transaction;
function sqlRow(value = tracked(), extra: Value = {}): Value {
  return {
    ...organization.createAdapter().encodeRow(organization.name, value),
    id: "10",
    _deleted_at: null,
    ...extra,
  };
}
function historySpies() {
  const history = new MariaDbEntityIdentityHistory();
  const ownership = vi.spyOn(history, "isEstablished").mockResolvedValue(true);
  const deletion = vi
    .spyOn(history, "recordNestedDeletion")
    .mockResolvedValue(undefined);
  return { history, ownership, deletion };
}

describe("imported removal reconciliation", () => {
  it("queues a removed assignment and its nested remark with original XML attributes and paths", async () => {
    const value = tracked();
    value.docs = {
      doc: [
        {
          uid: "docasg30",
          crud: "R",
          docRef: { uidRef: "doc1" },
          rmks: {
            rmk: [{ uid: "rmk21", crud: "I", text: { descr: "Nested" } }],
          },
        },
      ],
    };
    const before = sqlRow(value);
    const after = { ...before, docs: null };
    const original = structuredClone({ before, after });
    const { history, deletion } = historySpies();

    await reconcileImportedRemovals({
      trx,
      entity: organization,
      before,
      after,
      history,
    });

    expect(deletion).toHaveBeenCalledTimes(2);
    expect(deletion.mock.calls.map(([, input]) => input)).toMatchObject([
      {
        entityName: "organization",
        rootUid: "org50",
        uid: "docasg30",
        path: "/docs/doc/0",
        previousValue: {
          "@_uid": "docasg30",
          "@_crud": "R",
          docRef: { "@_uidRef": "doc1" },
        },
      },
      {
        uid: "rmk21",
        path: "/docs/doc/0/rmks/rmk/0",
        previousValue: {
          "@_uid": "rmk21",
          "@_crud": "I",
          text: { descr: "Nested" },
        },
      },
    ]);
    expect({ before, after }).toEqual(original);
  });

  it("retains reordered identities and leaves imported CRUD markers unchanged", async () => {
    const value = tracked();
    (value.rmks as { rmk: Value[] }).rmk.push({
      uid: "rmk21",
      crud: "I",
      text: { descr: "Second" },
    });
    const before = sqlRow(value);
    const remarks = (value.rmks as { rmk: Value[] }).rmk;
    remarks.reverse();
    remarks[1].crud = "U";
    remarks[1].text = { descr: "Imported update" };
    const after = sqlRow(value);
    const original = structuredClone(after);
    const { history, ownership, deletion } = historySpies();

    await reconcileImportedRemovals({
      trx,
      entity: organization,
      before,
      after,
      history,
    });

    expect(ownership).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect(after).toEqual(original);
  });

  it("retains identities hidden by UI null and snapshots them when actually removed", async () => {
    const nil = {
      "@_uid": "applst2",
      "@_crud": "R",
      "@_xsi:nil": "true",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
    };
    const before = sqlRow(tracked(), {
      org_id: JSON.stringify([{ id: "NIL", applic: { applicDef: nil } }]),
    });
    const after = { ...before, name: JSON.stringify({ descr: "Changed" }) };
    const { history, deletion } = historySpies();
    const clean = organization
      .createAdapter()
      .decodeRow("organization", before).value;
    expect((clean.orgId as Value[])[0].applic).toEqual({ applicDef: null });

    await reconcileImportedRemovals({
      trx,
      entity: organization,
      before,
      after,
      history,
    });
    expect(deletion).not.toHaveBeenCalled();

    await reconcileImportedRemovals({
      trx,
      entity: organization,
      before: after,
      after: { ...after, org_id: JSON.stringify([{ id: "NIL" }]) },
      history,
    });
    expect(deletion).toHaveBeenCalledExactlyOnceWith(
      trx,
      expect.objectContaining({
        uid: "applst2",
        path: "/orgId/0/applic/applicDef",
        previousValue: nil,
      }),
    );
  });

  it("queues the root and every original nested identity on a soft delete", async () => {
    const before = sqlRow();
    const after = { ...before, _deleted_at: new Date(), crud: "D" };
    const { history, deletion } = historySpies();

    await reconcileImportedRemovals({
      trx,
      entity: organization,
      before,
      after,
      history,
    });

    const removals = deletion.mock.calls.map(([, input]) => input);
    expect(removals.map((input) => input.uid).sort()).toEqual([
      "docasg30",
      "org50",
      "rmk20",
    ]);
    expect(removals.find((input) => input.uid === "org50")).toMatchObject({
      path: "",
      previousValue: { uid: "org50", crud: "R" },
    });
    expect(after.crud).toBe("D");
  });

  it.each(["insert", "already deleted"])(
    "does not queue removals for an %s snapshot",
    async (scenario) => {
      const before =
        scenario === "insert"
          ? null
          : sqlRow(tracked(), { _deleted_at: new Date() });
      const { history, ownership, deletion } = historySpies();

      await reconcileImportedRemovals({
        trx,
        entity: organization,
        before,
        after: sqlRow(),
        history,
      });

      expect(ownership).not.toHaveBeenCalled();
      expect(deletion).not.toHaveBeenCalled();
    },
  );

  it("rejects root UID replacement before recording removals", async () => {
    const before = sqlRow();
    const { history, deletion } = historySpies();

    const result = reconcileImportedRemovals({
      trx,
      entity: organization,
      before,
      after: { ...before, uid: "org51" },
      history,
    });
    await expect(result).rejects.toBeInstanceOf(CrudValidationError);
    await expect(result).rejects.toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: "/uid",
            message: "An import must preserve the stored root UID.",
          },
        ],
      },
    });
    expect(deletion).not.toHaveBeenCalled();
  });

  it("validates all removed identities before recording any deletion", async () => {
    const before = sqlRow();
    const { history, ownership, deletion } = historySpies();
    const error = new CrudError(
      "identity_history_missing",
      "Missing owner",
      409,
    );
    ownership.mockResolvedValueOnce(true).mockRejectedValueOnce(error);

    await expect(
      reconcileImportedRemovals({
        trx,
        entity: organization,
        before,
        after: { ...before, docs: null, rmks: null },
        history,
      }),
    ).rejects.toBe(error);
    expect(deletion).not.toHaveBeenCalled();
  });
});
