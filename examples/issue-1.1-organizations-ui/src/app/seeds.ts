import type { OrganizationValue, ReferenceCatalog, Snapshot } from './models';
import { PROJECT } from './models';

export const fixedReferences: ReferenceCatalog = {
  documentReference: [
    { label: 'DOC-001 · Supplier quality guide', value: { uidRef: 'doc1' } },
    { label: 'DOC-002 · Workshop capability register', value: { uidRef: 'doc2' } },
  ],
  documentIssueReference: [
    { label: 'DOC-001 · Issue 02', value: { uidRef: 'dociss1' } },
    { label: 'DOC-002 · Issue 01', value: { uidRef: 'dociss2' } },
  ],
  applicabilityStatementReference: [
    { label: 'ALL-AURORA · All demonstration variants', value: { uidRef: 'applst1' } },
    { label: 'COLD-WEATHER · Cold weather configuration', value: { uidRef: 'applst2' } },
  ],
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
export function seedSnapshot(): Snapshot {
  return {
    version: 1,
    issue: '1.1',
    projectId: PROJECT,
    revision: 8,
    nextId: 9,
    nextUid: 1000,
    establishedUids: [
      'docasg101',
      'rmk102',
      'docasg103',
      'docasg104',
      'rmk105',
      'docasg106',
      'rmk107',
    ],
    records: structuredClone(values).map((value, index) => ({
      id: index + 1,
      revision: index + 1,
      uid: `org${index + 1}`,
      crud: 'R',
      baseline: true,
      pendingExport: false,
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: `2026-10-${String(8 + index).padStart(2, '0')}T09:00:00.000Z`,
      deletedAt: null,
      value,
      deletedNested: [],
    })),
  };
}
