import { defer, of, type Observable } from 'rxjs';
import {
  CrudError,
  ENTITY,
  PROJECT,
  STORAGE_KEY,
  displayName,
  type EntityCrudService,
  type JsonObject,
  type KeyValueStorage,
  type ListQuery,
  type ListResponse,
  type OrganizationRecord,
  type OrganizationValue,
  type ReferenceCatalog,
  type Snapshot,
  type Update,
} from './models';
import { isObject, metadata, organizationFields, same, shapeOf } from './metadata';
import { fixedReferences, seedSnapshot } from './seeds';
import { validateOrganization } from './validation';

const editable = new Set(organizationFields.map((field) => field.name));
const copy = <T>(value: T): T => structuredClone(value);
function checkJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (
    typeof value !== 'object' ||
    !value ||
    ancestors.has(value) ||
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  ) {
    throw new CrudError(
      'validation',
      'Supply JSON values. Use the remove list for absence and null for an explicitly empty value.',
    );
  }
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value))
    checkJson(child, ancestors);
  ancestors.delete(value);
}
type Visitor = (object: JsonObject, type: string, path: string) => void;
function walk(value: unknown, type: string, visit: Visitor, path = ''): void {
  if (!isObject(value)) return;
  visit(value, type, path);
  for (const field of shapeOf(type).fields) {
    if (!field.ref || value[field.name] == null) continue;
    const child = value[field.name];
    if (Array.isArray(child))
      child.forEach((item, index) =>
        walk(item, field.ref!, visit, `${path}/${field.name}/${index}`),
      );
    else walk(child, field.ref, visit, `${path}/${field.name}`);
  }
}
function tracked(value: OrganizationValue): Map<string, { value: JsonObject; type: string }> {
  const found = new Map<string, { value: JsonObject; type: string }>();
  walk(value, 'organization', (object, type) => {
    if (typeof object['uid'] === 'string') found.set(object['uid'], { value: object, type });
  });
  return found;
}
function business(object: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !['uid', 'crud'].includes(key)),
  );
}
export function makePatch(
  before: OrganizationValue,
  after: OrganizationValue,
  revision: number,
): Update<OrganizationValue> {
  const changes: JsonObject = {};
  const remove: (keyof OrganizationValue)[] = [];
  for (const name of editable) {
    if (!Object.hasOwn(after, name) && Object.hasOwn(before, name))
      remove.push(name as keyof OrganizationValue);
    else if (!same(before[name as keyof OrganizationValue], after[name as keyof OrganizationValue]))
      changes[name] = after[name as keyof OrganizationValue];
  }
  return { revision, changes, remove };
}

/** One snapshot is the commit boundary. There is no optimistic success before setItem. */
export class OrganizationStore implements EntityCrudService {
  constructor(
    private storage: KeyValueStorage,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  private scope(project: string, entity: string): void {
    if (project !== PROJECT || entity !== ENTITY)
      throw new CrudError(
        'scope',
        'This example supports the Aurora Issue 1.1 Organizations collection.',
      );
  }
  private write(snapshot: Snapshot): void {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      throw new CrudError(
        'storage',
        'Browser storage is unavailable or full. Your changes were not saved.',
      );
    }
  }
  private read(): Snapshot {
    let raw: string | null;
    try {
      raw = this.storage.getItem(STORAGE_KEY);
    } catch {
      throw new CrudError(
        'storage',
        'Browser storage cannot be read. Check your browser storage settings.',
      );
    }
    if (raw === null) {
      const snapshot = seedSnapshot();
      this.write(snapshot);
      return snapshot;
    }
    try {
      const snapshot = JSON.parse(raw) as Snapshot;
      if (
        snapshot.version !== 1 ||
        snapshot.issue !== '1.1' ||
        snapshot.projectId !== PROJECT ||
        !Array.isArray(snapshot.records) ||
        !Array.isArray(snapshot.establishedUids) ||
        ![snapshot.nextId, snapshot.nextUid, snapshot.revision].every(Number.isSafeInteger) ||
        snapshot.nextId < 1 ||
        snapshot.nextUid < 1 ||
        snapshot.revision < 0
      )
        throw new Error();
      const ids = new Set<number>();
      const uids = new Set<string>();
      const checkUid = (uid: unknown, type: string): void => {
        const pattern = metadata.types[type]?.fields.find((field) => field.name === 'uid')
          ?.constraints.patterns?.[0];
        const suffix = typeof uid === 'string' ? Number(uid.match(/[0-9]+$/)?.[0]) : NaN;
        if (
          typeof uid !== 'string' ||
          !pattern ||
          !new RegExp(`^(?:${pattern})$`).test(uid) ||
          uids.has(uid) ||
          !Number.isSafeInteger(suffix) ||
          suffix >= snapshot.nextUid
        )
          throw new Error();
        uids.add(uid);
      };
      for (const row of snapshot.records) {
        if (
          !Number.isSafeInteger(row.id) ||
          row.id < 1 ||
          row.id >= snapshot.nextId ||
          ids.has(row.id) ||
          !Number.isSafeInteger(row.revision) ||
          row.revision < 1 ||
          row.revision > snapshot.revision ||
          !/^org[1-9][0-9]*$/.test(row.uid) ||
          uids.has(row.uid) ||
          !['I', 'U', 'R', 'D'].includes(row.crud) ||
          typeof row.baseline !== 'boolean' ||
          typeof row.pendingExport !== 'boolean' ||
          !Array.isArray(row.deletedNested) ||
          !Number.isFinite(Date.parse(row.createdAt)) ||
          !Number.isFinite(Date.parse(row.updatedAt)) ||
          !(row.deletedAt === null || Number.isFinite(Date.parse(row.deletedAt))) ||
          (row.crud === 'D') !== (row.deletedAt !== null) ||
          validateOrganization(row.value, row.uid, row.crud).length
        )
          throw new Error();
        this.checkFields(row.value);
        ids.add(row.id);
        checkUid(row.uid, 'organization');
        walk(row.value, 'organization', (object, type, path) => {
          if (path && object['uid'] !== undefined) checkUid(object['uid'], type);
        });
        for (const removed of row.deletedNested) {
          if (!removed || removed.crud !== 'D' || !Number.isFinite(Date.parse(removed.deletedAt)))
            throw new Error();
          // A root soft delete retains its source value as well as nested deletion information.
          if (row.deletedAt && tracked(row.value).has(removed.uid)) continue;
          checkUid(removed.uid, removed.type);
        }
      }
      if (
        snapshot.establishedUids.some((uid) => typeof uid !== 'string' || !uids.has(uid)) ||
        new Set(snapshot.establishedUids).size !== snapshot.establishedUids.length
      )
        throw new Error();
      this.checkReferences(snapshot);
      return snapshot;
    } catch {
      throw new CrudError(
        'corrupt',
        'Stored demo data cannot be read with this version. It has not been replaced. Use Reset demo data to start again.',
      );
    }
  }
  private record(snapshot: Snapshot, id: number, revision?: number): OrganizationRecord {
    const row = snapshot.records.find((item) => item.id === id && item.deletedAt === null);
    if (!row)
      throw new CrudError('not_found', 'This organization no longer exists. Reload the list.');
    if (revision !== undefined && revision !== row.revision)
      throw new CrudError(
        'conflict',
        'This record changed after you opened it. Close the editor and reload it before saving.',
      );
    return row;
  }
  private checkFields(value: unknown): asserts value is JsonObject {
    if (!isObject(value) || Object.keys(value).some((name) => !editable.has(name))) {
      throw new CrudError(
        'validation',
        'Only Organization business fields can be edited. IDs and change tracking are managed by the service.',
      );
    }
    checkJson(value);
  }
  private prepare(
    value: OrganizationValue,
    before: OrganizationValue | undefined,
    snapshot: Snapshot,
  ): OrganizationValue {
    this.checkFields(value);
    const next = copy(value);
    const old = before ? tracked(before) : new Map<string, { value: JsonObject; type: string }>();
    const seen = new Set<string>();
    // Validate immutable fields before any service-managed changes.
    walk(next, 'organization', (object, type, path) => {
      if (!path) return;
      const shape = shapeOf(type);
      if (!shape.fields.some((field) => field.system)) return;
      const uid = object['uid'];
      if (uid !== undefined) {
        const previous = typeof uid === 'string' ? old.get(uid) : undefined;
        if (
          !previous ||
          previous.type !== type ||
          seen.has(uid as string) ||
          !same(object['crud'], previous.value['crud'])
        ) {
          throw new CrudError(
            'validation',
            'Nested XML UIDs and change actions cannot be assigned or changed in the form.',
            [
              {
                path,
                message:
                  'Use the existing UID and change action, or add a new value without these fields.',
              },
            ],
          );
        }
        seen.add(uid as string);
      } else if (object['crud'] !== undefined) {
        throw new CrudError('validation', 'New nested records must not supply a change action.', [
          { path: `${path}/crud`, message: 'This field is managed by the service.' },
        ]);
      }
    });
    // Post-order tracking means a changed child also marks its owning record.
    const objects: { object: JsonObject; type: string }[] = [];
    walk(next, 'organization', (object, type, path) => {
      if (path) objects.push({ object, type });
    });
    for (const { object, type } of objects.reverse()) {
      const uidField = shapeOf(type).fields.find((field) => field.name === 'uid' && field.system);
      if (!uidField) continue;
      if (!object['uid']) {
        const prefix = uidField.constraints.patterns?.[0]?.match(/^([a-zA-Z]+)\[1-9\]/)?.[1];
        if (!prefix) throw new CrudError('validation', `No UID allocation rule for ${type}.`);
        object['uid'] = `${prefix}${snapshot.nextUid++}`;
        object['crud'] = 'I';
      } else {
        const previous = old.get(object['uid'] as string)!;
        if (!same(business(object), business(previous.value))) {
          object['crud'] = snapshot.establishedUids.includes(object['uid'] as string) ? 'U' : 'I';
        }
      }
    }
    const issues = validateOrganization(next);
    if (issues.length)
      throw new CrudError('validation', 'Check the marked fields before saving.', issues);
    return next;
  }
  private checkReferences(snapshot: Snapshot): void {
    const active = snapshot.records.filter((row) => row.deletedAt === null);
    for (const owner of active)
      walk(owner.value, 'organization', (object, type, path) => {
        if (type !== 'organizationReference') return;
        const matches = active.filter((target) => {
          if (object['uidRef'] !== undefined) return target.uid === object['uidRef'];
          const identifier = object['orgId'];
          return (
            isObject(identifier) &&
            target.value.orgId.some(
              (id) =>
                id.id === identifier['id'] &&
                (identifier['class'] === undefined ||
                  same(id.class === undefined ? 'CAGE' : id.class, identifier['class'])),
            )
          );
        });
        if (matches.length !== 1)
          throw new CrudError(
            'reference',
            `An Organization reference in ${displayName(owner.value)} must resolve to one active record.`,
            [{ path, message: 'Select an active Organization or use a unique identifier.' }],
          );
      });
  }
  list(
    project: string,
    entity: string,
    query: ListQuery = {},
  ): Observable<ListResponse<OrganizationValue>> {
    return defer(() => {
      this.scope(project, entity);
      const search = query.filters?.search?.toLocaleLowerCase().trim() || '';
      const snapshot = this.read();
      const data = snapshot.records.filter(
        (row) =>
          !row.deletedAt &&
          (!query.filters?.status ||
            (query.filters.status === 'pending'
              ? row.pendingExport
              : row.crud === query.filters.status)) &&
          `${displayName(row.value)} ${row.value.orgId.map((id) => id.id).join(' ')}`
            .toLocaleLowerCase()
            .includes(search),
      );
      const sortBy = query.sortBy || 'name';
      const sortValue = (row: OrganizationRecord): string | number => {
        switch (sortBy) {
          case 'identifiers':
            return row.value.orgId.map((id) => id.id).join(' ');
          case 'documents':
            return row.value.docs?.doc.length || 0;
          case 'crud':
            return row.crud;
          case 'updatedAt':
            return row.updatedAt;
          default:
            return displayName(row.value);
        }
      };
      data.sort((a, b) => {
        const left = sortValue(a);
        const right = sortValue(b);
        const order =
          typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left).localeCompare(String(right));
        return (query.sortDirection === 'desc' ? -order : order) || a.id - b.id;
      });
      const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize || 6)));
      const pageCount = Math.ceil(data.length / pageSize);
      const page = Math.min(Math.max(1, Math.trunc(query.page || 1)), Math.max(1, pageCount));
      return of(
        copy({
          data: data.slice((page - 1) * pageSize, page * pageSize),
          metadata: { page, pageSize, total: data.length, pageCount },
        }),
      );
    });
  }
  findById(project: string, entity: string, id: number): Observable<OrganizationRecord> {
    return defer(() => {
      this.scope(project, entity);
      return of(copy(this.record(this.read(), id)));
    });
  }
  create(
    project: string,
    entity: string,
    value: OrganizationValue,
  ): Observable<OrganizationRecord> {
    return defer(() => {
      this.scope(project, entity);
      const snapshot = this.read();
      const prepared = this.prepare(value, undefined, snapshot);
      const now = this.now();
      const row: OrganizationRecord = {
        id: snapshot.nextId++,
        uid: `org${snapshot.nextUid++}`,
        revision: ++snapshot.revision,
        crud: 'I',
        baseline: false,
        pendingExport: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        deletedNested: [],
        value: prepared,
      };
      snapshot.records.push(row);
      this.checkReferences(snapshot);
      this.write(snapshot);
      return of(copy(row));
    });
  }
  update(
    project: string,
    entity: string,
    id: number,
    patch: Update<OrganizationValue>,
  ): Observable<OrganizationRecord> {
    return defer(() => {
      this.scope(project, entity);
      const snapshot = this.read();
      if (!patch || !Number.isSafeInteger(patch.revision) || !Array.isArray(patch.remove))
        throw new CrudError(
          'validation',
          'Supply a revision, changed fields, and fields to remove.',
        );
      const row = this.record(snapshot, id, patch.revision);
      this.checkFields(patch.changes);
      if (patch.remove.some((name) => !editable.has(name) || Object.hasOwn(patch.changes, name)))
        throw new CrudError(
          'validation',
          'Remove only business fields. A field cannot be changed and removed in the same update.',
        );
      const proposed = { ...row.value, ...copy(patch.changes) };
      patch.remove.forEach((name) => {
        delete proposed[name];
      });
      const value = this.prepare(proposed, row.value, snapshot);
      if (same(value, row.value)) return of(copy(row));
      const current = tracked(value);
      const now = this.now();
      for (const [uid, previous] of tracked(row.value)) {
        if (!current.has(uid))
          row.deletedNested.push({ uid, type: previous.type, crud: 'D', deletedAt: now });
      }
      row.value = value;
      row.crud = row.baseline ? 'U' : 'I';
      row.pendingExport = true;
      row.revision = ++snapshot.revision;
      row.updatedAt = now;
      this.checkReferences(snapshot);
      this.write(snapshot);
      return of(copy(row));
    });
  }
  delete(project: string, entity: string, id: number, revision: number): Observable<void> {
    return defer(() => {
      this.scope(project, entity);
      if (!Number.isSafeInteger(revision))
        throw new CrudError('validation', 'Supply the record revision.');
      const snapshot = this.read();
      const row = this.record(snapshot, id, revision);
      const now = this.now();
      row.deletedAt = now;
      row.updatedAt = now;
      row.crud = 'D';
      row.pendingExport = true;
      row.revision = ++snapshot.revision;
      for (const [uid, previous] of tracked(row.value))
        row.deletedNested.push({ uid, type: previous.type, crud: 'D', deletedAt: now });
      // Deleting a target also invalidates incoming natural-identifier references.
      this.checkReferences(snapshot);
      this.write(snapshot);
      return of(undefined);
    });
  }
  reset(): Observable<void> {
    return defer(() => {
      this.write(seedSnapshot());
      return of(undefined);
    });
  }
  references(): Observable<ReferenceCatalog> {
    return defer(() => {
      const references = copy(fixedReferences);
      references['organizationReference'] = this.read()
        .records.filter((row) => !row.deletedAt)
        .map((row) => ({
          label: `${displayName(row.value)} · ${row.value.orgId[0].id}`,
          value: { uidRef: row.uid },
        }));
      return of(references);
    });
  }
  summary(): Observable<{ total: number; pending: number; documents: number; deleted: number }> {
    return defer(() => {
      const records = this.read().records;
      const active = records.filter((row) => !row.deletedAt);
      return of({
        total: active.length,
        pending: records.filter((row) => row.pendingExport).length,
        documents: active.reduce((count, row) => count + (row.value.docs?.doc.length || 0), 0),
        deleted: records.length - active.length,
      });
    });
  }
}
