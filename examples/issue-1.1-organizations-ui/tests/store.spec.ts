import { beforeEach, describe, expect, it } from 'vitest';
import { firstValueFrom as result } from 'rxjs';
import { OrganizationStore, makePatch } from '../src/app/organization-store';
import {
  ENTITY as E,
  PROJECT as P,
  STORAGE_KEY,
  type KeyValueStorage,
  type OrganizationValue,
} from '../src/app/models';
import { seedSnapshot } from '../src/app/seeds';
import { validateOrganization } from '../src/app/validation';

class MemoryStorage implements KeyValueStorage {
  values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  getItem(key: string) {
    if (this.failRead) throw Error();
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw Error();
    this.values.set(key, value);
  }
}
let storage: MemoryStorage;
let store: OrganizationStore;
beforeEach(() => {
  storage = new MemoryStorage();
  store = new OrganizationStore(storage, () => '2026-10-17T10:00:00.000Z');
});
const minimal = (): OrganizationValue => ({
  orgId: [{ id: '000123' }],
  name: { descr: 'Test partner' },
});

describe('Issue 1.1 schema', () => {
  it('accepts all eight fictional seeds', () => {
    for (const row of seedSnapshot().records)
      expect(validateOrganization(row.value, row.uid, row.crud), `seed ${row.id}`).toEqual([]);
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
describe('offline CRUD', () => {
  it('searches, sorts, pages, and keeps leading zeroes', async () => {
    expect((await result(store.list(P, E))).metadata.total).toBe(8);
    expect(
      (await result(store.list(P, E, { filters: { search: '000042' } }))).data[0].value.orgId[0].id,
    ).toBe('000042');
    const page = await result(store.list(P, E, { sortBy: 'identifiers', pageSize: 2, page: 2 }));
    expect(page.metadata).toEqual({ page: 2, pageSize: 2, total: 8, pageCount: 4 });
    expect(
      (await result(store.list(P, E, { sortBy: 'name', sortDirection: 'desc' }))).data[0].value
        .name,
    ).toBeFalsy();
  });
  it('creates, updates, reloads, soft deletes, and resets', async () => {
    let row = await result(store.create(P, E, minimal()));
    expect(row.id).toBe(9);
    expect(row.uid).toMatch(/^org[1-9][0-9]*$/);
    expect(row.crud).toBe('I');
    const value = { ...row.value, name: { descr: 'Updated' } };
    row = await result(store.update(P, E, row.id, makePatch(row.value, value, row.revision)));
    expect(row.crud).toBe('I');
    expect(row.pendingExport).toBe(true);
    const reload = new OrganizationStore(storage);
    expect((await result(reload.findById(P, E, row.id))).value.name?.descr).toBe('Updated');
    await result(reload.delete(P, E, row.id, row.revision));
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).records.at(-1).crud).toBe('D');
    await result(store.reset());
    expect((await result(store.list(P, E))).metadata.total).toBe(8);
  });
  it('tracks effective baseline changes, nested changes, reorders, and deletions', async () => {
    const row = await result(store.findById(P, E, 1));
    const noChange = await result(
      store.update(P, E, 1, makePatch(row.value, row.value, row.revision)),
    );
    expect(noChange.revision).toBe(row.revision);
    const edited = structuredClone(row.value);
    edited.rmks!.rmk[0].text.descr = 'Updated remark';
    edited.docs!.doc.push({ docRef: { uidRef: 'doc2' } });
    let changed = await result(store.update(P, E, 1, makePatch(row.value, edited, row.revision)));
    expect(changed.crud).toBe('U');
    expect(changed.value.rmks!.rmk[0].crud).toBe('U');
    expect(changed.value.docs!.doc[0]).toEqual(row.value.docs!.doc[0]);
    expect(changed.value.docs!.doc[1].uid).toMatch(/^docasg[1-9][0-9]*$/);
    expect(changed.value.docs!.doc[1].crud).toBe('I');
    const reordered = structuredClone(changed.value);
    reordered.docs!.doc.reverse();
    changed = await result(
      store.update(P, E, 1, makePatch(changed.value, reordered, changed.revision)),
    );
    expect(changed.value.docs!.doc[1].uid).toBe('docasg101');
    const removed = structuredClone(changed.value);
    removed.docs!.doc.splice(1, 1);
    changed = await result(
      store.update(P, E, 1, makePatch(changed.value, removed, changed.revision)),
    );
    expect(changed.deletedNested).toEqual([
      expect.objectContaining({ uid: 'docasg101', crud: 'D' }),
    ]);
  });
  it('rejects stale revisions, forged system fields, and incomplete values', async () => {
    const row = await result(store.findById(P, E, 1));
    await expect(
      result(store.update(P, E, 1, { revision: 0, changes: {}, remove: [] })),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      result(store.create(P, E, { ...minimal(), uid: 'org123' } as OrganizationValue)),
    ).rejects.toMatchObject({ code: 'validation' });
    const edited = structuredClone(row.value);
    edited.docs!.doc[0].crud = 'D';
    await expect(
      result(store.update(P, E, 1, makePatch(row.value, edited, row.revision))),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      result(store.update(P, E, 1, { revision: row.revision, changes: {}, remove: ['orgId'] })),
    ).rejects.toMatchObject({ code: 'validation' });
  });
  it('keeps absence, null, and empty text distinct', async () => {
    const row = await result(store.create(P, E, minimal()));
    const nil = await result(
      store.update(P, E, row.id, { revision: row.revision, changes: { name: null }, remove: [] }),
    );
    expect(nil.value.name).toBeNull();
    const absent = await result(
      store.update(P, E, row.id, { revision: nil.revision, changes: {}, remove: ['name'] }),
    );
    expect(Object.hasOwn(absent.value, 'name')).toBe(false);
    await expect(
      result(
        store.update(P, E, row.id, {
          revision: absent.revision,
          changes: { name: undefined },
          remove: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      result(
        store.update(P, E, row.id, {
          revision: absent.revision,
          changes: { name: { descr: '' } },
          remove: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation' });
  });
  it('checks incoming UID and natural Organization references before delete or identifier changes', async () => {
    await expect(result(store.delete(P, E, 2, 2))).rejects.toMatchObject({ code: 'reference' });
    const created = await result(
      store.create(P, E, {
        ...minimal(),
        rmks: { rmk: [{ text: { descr: 'ref', providedBy: { orgId: { id: '003817' } } } }] },
      }),
    );
    await expect(result(store.delete(P, E, 3, 3))).rejects.toMatchObject({ code: 'reference' });
    await expect(
      result(
        store.update(P, E, 3, { revision: 3, changes: { orgId: [{ id: 'CHANGED' }] }, remove: [] }),
      ),
    ).rejects.toMatchObject({ code: 'reference' });
    expect(created.value.rmks!.rmk[0].uid).toBeTruthy();
    expect((await result(store.references()))['organizationReference']).toHaveLength(9);
  });
  it('does not reseed an empty collection and isolates the storage key', async () => {
    storage.setItem('another-project', 'keep');
    const rows = (await result(store.list(P, E, { pageSize: 100 }))).data;
    for (const row of rows.sort((a, b) => a.id - b.id))
      await result(store.delete(P, E, row.id, row.revision));
    expect((await result(new OrganizationStore(storage).list(P, E))).metadata.total).toBe(0);
    await result(store.reset());
    expect(storage.getItem('another-project')).toBe('keep');
  });
  it('reports storage failures and never overwrites corrupt data', async () => {
    storage.failRead = true;
    await expect(result(store.list(P, E))).rejects.toMatchObject({ code: 'storage' });
    storage.failRead = false;
    await result(store.list(P, E));
    const before = storage.getItem(STORAGE_KEY);
    storage.failWrite = true;
    await expect(result(store.create(P, E, minimal()))).rejects.toMatchObject({ code: 'storage' });
    expect(storage.getItem(STORAGE_KEY)).toBe(before);
    storage.failWrite = false;
    storage.setItem(STORAGE_KEY, '{bad');
    await expect(result(store.list(P, E))).rejects.toMatchObject({ code: 'corrupt' });
    expect(storage.getItem(STORAGE_KEY)).toBe('{bad');
    await result(store.reset());
    expect((await result(store.list(P, E))).metadata.total).toBe(8);
  });
  it('rejects malformed snapshots before they can allocate duplicate UIDs', async () => {
    const snapshot = seedSnapshot();
    snapshot.nextUid = 1;
    const raw = JSON.stringify(snapshot);
    storage.setItem(STORAGE_KEY, raw);
    await expect(result(store.create(P, E, minimal()))).rejects.toMatchObject({ code: 'corrupt' });
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
  });
  it('keeps new nested records at I, detects real stale saves, and returns detached values', async () => {
    let row = await result(
      store.create(P, E, { ...minimal(), rmks: { rmk: [{ text: { descr: 'Initial' } }] } }),
    );
    const stale = row.revision;
    const edited = structuredClone(row.value);
    edited.rmks!.rmk[0].text.descr = 'Changed';
    row = await result(store.update(P, E, row.id, makePatch(row.value, edited, row.revision)));
    expect(row.value.rmks!.rmk[0].crud).toBe('I');
    await expect(
      result(store.update(P, E, row.id, { revision: stale, changes: {}, remove: [] })),
    ).rejects.toMatchObject({ code: 'conflict' });
    row.value.orgId[0].id = 'MUTATED';
    expect((await result(store.findById(P, E, row.id))).value.orgId[0].id).toBe('000123');
  });
  it('preserves explicit null in natural-reference identifier classes', async () => {
    await result(store.create(P, E, { orgId: [{ id: 'NIL-CLASS', class: null }] }));
    await expect(
      result(
        store.create(P, E, {
          ...minimal(),
          rmks: {
            rmk: [
              {
                text: { descr: 'Source', providedBy: { orgId: { id: 'NIL-CLASS', class: null } } },
              },
            ],
          },
        }),
      ),
    ).resolves.toBeTruthy();
  });
});
