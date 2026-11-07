import type { ApiEntityRecord, OrganizationValue, JsonObject } from '../../src/app/models';
// Fictional API contract data. Never imported by production code.
export const TEST_PROJECT = 'contract-project';
export const TEST_CONFIG = {
  apiBasePath: '/api',
  projectId: TEST_PROJECT,
  projectLabel: 'Contract test project',
  schemaIssue: '1.1' as const,
};
const values: OrganizationValue[] = [
  {
    orgId: [
      { id: '001234', class: 'CAGE', applic: { applicRef: { uidRef: 'applst1' } } },
      { id: 'AURORA-DESIGN' },
    ],
    name: { descr: 'Aurora Aerospace', lang: 'en' },
    docs: { doc: [{ docRef: { uidRef: 'doc1' }, uid: 'docasg101', crud: 'R' }] },
    rmks: {
      rmk: [
        {
          text: {
            descr: 'Design authority for the demonstration fleet.',
            lang: 'en',
            providedBy: { uidRef: 'org2' },
          },
          uid: 'rmk102',
          crud: 'R',
        },
      ],
    },
  },
  {
    orgId: [{ id: '000042', class: 'CAGE' }],
    name: {
      descr: 'Northstar Engineering',
      lang: 'en',
      applic: { applicRef: { uidRef: 'applst2' } },
    },
    docs: { doc: [{ docIssRef: { uidRef: 'dociss1' }, uid: 'docasg103', crud: 'R' }] },
  },
  {
    orgId: [{ id: '003817' }],
    name: { descr: 'Meridian Component Works', lang: 'en' },
    rmks: {
      rmk: [
        {
          text: { descr: 'Component support partner.' },
          docs: { doc: [{ docRef: { docId: { id: 'DOC-002' } }, uid: 'docasg104', crud: 'R' }] },
          uid: 'rmk105',
          crud: 'R',
        },
      ],
    },
  },
  {
    orgId: [{ id: 'SKYLARK-OPS' }, { id: '000018', class: 'CAGE' }],
    name: { descr: 'Skylark Flight Services' },
    docs: null,
  },
  {
    orgId: [{ id: '004200' }],
    name: { descr: 'Boreal Maintenance', lang: 'en' },
    docs: { doc: [{ docRef: { uidRef: 'doc2' }, uid: 'docasg106', crud: 'R' }] },
    rmks: {
      rmk: [
        {
          text: {
            descr: 'Cold weather inspections.',
            applic: { applicRef: { uidRef: 'applst2' } },
          },
          uid: 'rmk107',
          crud: 'R',
        },
      ],
    },
  },
  { orgId: [{ id: '007301' }], name: { descr: 'Aster Training Centre', lang: 'en' }, rmks: null },
  { orgId: [{ id: '009906' }], name: null },
  { orgId: [{ id: '000007' }] },
];

export function fixtureRecords(): ApiEntityRecord<OrganizationValue>[] {
  return structuredClone(values).map((value, index) => ({
    id: String(index + 1),
    uid: 'org' + (index + 1),
    crud: 'R',
    pendingExport: false,
    _createdAt: '2026-09-01T09:00:00.000Z',
    _updatedAt: '2026-10-' + String(15 - index).padStart(2, '0') + 'T09:00:00.000Z',
    _deletedAt: null,
    value,
  }));
}
function reference(uid: string, value: JsonObject): ApiEntityRecord<JsonObject> {
  return { ...fixtureRecords()[0], id: uid, uid, value };
}
export function fixtureCatalogs(): Record<string, ApiEntityRecord<JsonObject>[]> {
  return {
    externalDocument: [
      reference('doc1', {
        docId: [{ id: 'DOC-001' }],
        docTitle: { descr: 'Supplier quality guide' },
      }),
      reference('doc2', {
        docId: [{ id: 'DOC-002' }],
        docTitle: { descr: 'Workshop capability register' },
      }),
    ],
    externalDocumentIssue: [
      reference('dociss1', { docIssId: { id: 'DOC-001 · Issue 02' } }),
      reference('dociss2', { docIssId: { id: 'DOC-002 · Issue 01' } }),
    ],
    applicabilityStatement: [
      reference('applst1', {
        applicId: { id: 'ALL-AURORA' },
        applicDescr: { descr: 'All demonstration variants' },
      }),
      reference('applst2', {
        applicId: { id: 'COLD-WEATHER' },
        applicDescr: { descr: 'Cold weather configuration' },
      }),
    ],
  };
}
