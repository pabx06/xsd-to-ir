import type { EntityIdentityPolicy } from "./entity-change-preparation.types";
export const organizationIdentityPolicyV11: EntityIdentityPolicy = {
  root: { identityType: "organization", uid: { prefix: "org", maxLength: 255, pattern: /^org[A-Za-z0-9._-]+$/ } },
  nested: [{ identityType: "organizationDocumentAssignment", path: ["docs", "doc"],
    uid: { prefix: "docasg", maxLength: 255, pattern: /^docasg[A-Za-z0-9._-]+$/ } }],
};
