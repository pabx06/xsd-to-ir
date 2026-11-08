import { dirname, resolve } from "node:path";
import type { Knex } from "knex";
import { EntityCrudRegistry } from "../src/entity-crud.registry";
import { IRBuilder, parseXSD, type Value } from "../src/xsd-runtime";
import type {
  EntityIdentityHistory,
  EntityUidAllocator,
  IdentityInput,
  IdentityOwner,
} from "../src/entity-change-preparation.types";
import { EntityChangePreparationService } from "../src/entity-change-preparation.service";
const schema = resolve(
  dirname(require.resolve("xsd-to-ir")),
  "s3000l/1_1/s3000l_1-1_lsa_dataset.xsd",
);
export const ir = new IRBuilder(parseXSD(schema)).build();
export const registry = new EntityCrudRegistry({ getIRRAW: () => ir });
export const organization = registry.getEntityDefinition("1.1", "organization");
export const business = (id = "001234"): Value => ({
  orgId: [{ id }],
  name: { descr: "Example supplier", lang: "en" },
});
export const recursiveApplicability = () => ({
  applicDef: {
    not: { not: { nestedApplic: { applicRef: { uidRef: "applst1" } } } },
  },
});
export const tracked = (): Value => ({
  ...business(),
  uid: "org50",
  crud: "R",
  docs: { doc: [{ docRef: { uidRef: "doc1" }, uid: "docasg30", crud: "R" }] },
  rmks: {
    rmk: [{ text: { descr: "Original remark" }, uid: "rmk20", crud: "R" }],
  },
});
export function editable(value: Value): Value {
  const { uid: _uid, crud: _crud, ...rest } = structuredClone(value);
  return rest;
}
export function memoryPreparation(previous?: Value, established = true) {
  const owners = new Map<string, IdentityOwner>();
  const deletions: unknown[] = [];
  let sequence = 100;
  const history: EntityIdentityHistory = {
    findOwner: async (_trx, uid) => owners.get(uid),
    register: async (_trx, input, known, active = true) => {
      owners.set(input.uid, {
        uid: input.uid,
        root_uid: input.rootUid,
        entity_name: input.entityName,
        identity_type: input.identityType,
        established: known,
        active,
      });
    },
    isEstablished: async (_trx, input) => {
      const owner = owners.get(input.uid);
      if (!owner) throw new Error("History missing");
      return Boolean(owner.established);
    },
    recordNestedDeletion: async (_trx, input) => {
      deletions.push(input);
    },
  };
  if (previous)
    for (const node of organization.metadata.identities(
      "organization",
      previous,
    ))
      if (typeof node.value.uid === "string") {
        owners.set(node.value.uid, {
          uid: node.value.uid,
          root_uid: String(previous.uid),
          entity_name: "organization",
          identity_type: node.type,
          established,
          active: true,
        });
      }
  const allocator: EntityUidAllocator = {
    allocate: async (_trx, entity, type) =>
      `${entity.metadata.uidRule(type).prefix}${sequence++}`,
  };
  return {
    service: new EntityChangePreparationService(allocator, history),
    history,
    owners,
    deletions,
    trx: {} as Knex.Transaction,
  };
}
