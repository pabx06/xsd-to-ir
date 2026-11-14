import { describe, expect, it } from 'vitest';
import type { OrganizationValue } from '../src/app/models';
import { validateOrganization } from '../src/app/validation';
import { fixtureRecords } from './fixtures/records';
const minimal = (): OrganizationValue => ({
  orgId: [{ id: '000123' }],
  name: { descr: 'Test partner' },
});

describe('Issue 1.1 schema', () => {
  it('accepts all eight fictional HTTP records', () => {
    for (const row of fixtureRecords())
      expect(validateOrganization(row.value, row.uid, row.crud), `record ${row.id}`).toEqual([]);
  });
  it('requires identifiers and excludes prohibited fields', () => {
    expect(validateOrganization({ orgId: [] })).not.toEqual([]);
    expect(validateOrganization({ orgId: [{ id: '' }] })).not.toEqual([]);
    expect(validateOrganization({ orgId: [{ id: 'a', setBy: { uidRef: 'org1' } }] })).not.toEqual(
      [],
    );
    expect(
      validateOrganization({
        orgId: [{ id: 'a' }],
        name: { descr: 'A', providedBy: { uidRef: 'org1' } },
      }),
    ).not.toEqual([]);
  });
  it('supports UID and natural references and document versus document issue', () => {
    const base = minimal();
    for (const doc of [
      { docRef: { uidRef: 'doc1' } },
      { docRef: { docId: { id: '000123' } } },
      { docIssRef: { uidRef: 'dociss1' } },
      { docIssRef: { docId: { id: 'DOC1' }, docIssId: { id: '02' } } },
    ]) {
      expect(validateOrganization({ ...base, docs: { doc: [doc] } }), JSON.stringify(doc)).toEqual(
        [],
      );
    }
    expect(
      validateOrganization({
        ...base,
        docs: { doc: [{ docRef: { uidRef: 'doc1' }, docIssRef: { uidRef: 'dociss1' } }] },
      }),
    ).not.toEqual([]);
    expect(
      validateOrganization({
        ...base,
        docs: { doc: [{ docRef: { uidRef: 'doc1', docId: { id: '1' } } }] },
      }),
    ).not.toEqual([]);
  });
  it('supports nested remarks and applicability choices', () => {
    const base = minimal();
    expect(
      validateOrganization({
        ...base,
        rmks: {
          rmk: [
            {
              text: {
                descr: 'Check',
                providedBy: { orgId: { id: '001234' } },
                applic: { applicRef: { uidRef: 'applst1' } },
              },
              docs: {
                doc: [
                  { docRef: { uidRef: 'doc1' }, rmks: { rmk: [{ text: { descr: 'Nested' } }] } },
                ],
              },
            },
          ],
        },
      }),
    ).toEqual([]);
    for (const applic of [
      { applicDef: { applicId: { id: 'ALL' } } },
      { datedApplicDef: { applicId: { id: 'DATED' } } },
      { applicRef: { applicId: { id: 'ALL' } } },
    ]) {
      expect(validateOrganization({ ...base, orgId: [{ id: '1', applic }] })).toEqual([]);
    }
  });
});
