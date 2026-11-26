import { test as base, expect, type Page, type Route } from '@playwright/test';
import { fixtureRecords, fixtureCatalogs, TEST_CONFIG } from '../tests/fixtures/records';
import { same, isObject, shapeOf } from '../src/app/metadata';
import { validateOrganization } from '../src/app/validation';
import type { ApiEntityRecord, JsonObject, OrganizationValue } from '../src/app/models';

type Reply = { status: number; body?: unknown };
export interface Call {
  method: string;
  url: URL;
  body?: JsonObject;
}
/** Explicit HTTP contract fixture, not a backend implementation or proof of backend behavior. */
export class BackendFixture {
  records = fixtureRecords();
  catalogs = fixtureCatalogs();
  calls: Call[] = [];
  config: unknown = TEST_CONFIG;
  schemaIssue = '1.1';
  failWrite?: Reply;
  failList?: Reply;
  failSummary?: Reply;
  // Responses can be held after capture to test obsolete reads and overlapping writes.
  hold?: (call: Call) => Promise<void> | undefined;
  private nextIdentity = 900;
  get writes(): Call[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }
  async install(page: Page): Promise<void> {
    await page.route('**/organizations.config.json', (route) =>
      route.fulfill({ json: this.config }),
    );
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const call: Call = { method: request.method(), url: new URL(request.url()) };
      if (request.postData()) call.body = request.postDataJSON();
      this.calls.push(call);
      const response = this.respond(call);
      const wait = this.hold?.(call);
      if (wait) await wait;
      await this.fulfill(route, response);
    });
  }
  private async fulfill(route: Route, reply: Reply): Promise<void> {
    // A cancelled HTTP read may already have closed its browser request.
    try {
      await route.fulfill({
        status: reply.status,
        ...(reply.body === undefined ? {} : { json: reply.body }),
      });
    } catch (error) {
      if (!/closed|cancelled|disposed|Target page/i.test(String(error))) throw error;
    }
  }
  private respond(call: Call): Reply {
    const segments = call.url.pathname.split('/').map(decodeURIComponent);
    const entity = segments[5],
      id = segments[6];
    if (segments[3] !== TEST_CONFIG.projectId)
      return { status: 404, body: { error: 'project_not_found' } };
    if (call.method === 'GET' && id === 'summary') {
      if (this.failSummary) return this.failSummary;
      const active = this.records.filter((row) => !row._deletedAt);
      return {
        status: 200,
        body: {
          data: {
            schemaIssue: this.schemaIssue,
            total: active.length,
            pending: this.records.filter((row) => row.pendingExport).length,
            documents: active.reduce((n, row) => n + (row.value.docs?.doc.length || 0), 0),
            deleted: this.records.length - active.length,
          },
        },
      };
    }
    const records = entity === 'organization' ? this.records : this.catalogs[entity];
    if (!records) return { status: 404, body: { error: 'entity_not_found' } };
    if (call.method === 'GET' && id) {
      const record = records.find((row) => String(row.id) === id && !row._deletedAt);
      return record
        ? { status: 200, body: { data: structuredClone(record) } }
        : { status: 404, body: { error: 'record_not_found' } };
    }
    if (call.method === 'GET') {
      if (this.failList) return this.failList;
      const q = call.url.searchParams,
        search = (q.get('filter.search') || '').toLowerCase(),
        status = q.get('filter.status');
      let rows = records.filter((row) => !row._deletedAt);
      if (entity === 'organization')
        rows = rows.filter((row) => {
          const value = row.value as OrganizationValue;
          return (
            (!search ||
              [value.name?.descr, ...value.orgId.map((item) => item.id)].some((text) =>
                text?.toLowerCase().includes(search),
              )) &&
            (!status || (status === 'pending' ? row.pendingExport : row.crud === status))
          );
        });
      const sort = q.get('sortBy') || 'id',
        direction = q.get('sortDirection') === 'desc' ? -1 : 1;
      if (!['id', 'uid', 'crud', '_updatedAt'].includes(sort))
        return {
          status: 400,
          body: { error: 'invalid_query', message: 'Only scalar column sorting is supported.' },
        };
      const key = (row: ApiEntityRecord<unknown>): string | number =>
        row[sort as 'id' | 'uid' | 'crud' | '_updatedAt'];
      rows.sort((a, b) => {
        const left = key(a),
          right = key(b);
        return (
          (typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left).localeCompare(String(right))) * direction ||
          String(a.id).localeCompare(String(b.id))
        );
      });
      const page = Number(q.get('page') || 1),
        pageSize = Number(q.get('pageSize') || 20),
        total = rows.length;
      return {
        status: 200,
        body: {
          data: structuredClone(rows.slice((page - 1) * pageSize, page * pageSize)),
          metadata: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) },
        },
      };
    }
    if (this.failWrite) {
      const failure = this.failWrite;
      this.failWrite = undefined;
      return failure;
    }
    const current = this.records.find((row) => String(row.id) === id && !row._deletedAt);
    if (call.method === 'DELETE') {
      if (!current) return { status: 404, body: { error: 'record_not_found' } };
      // This fixture exercises one seeded incoming UID reference; production must resolve all forms.
      if (
        this.records.some(
          (row) =>
            row !== current &&
            !row._deletedAt &&
            JSON.stringify(row.value).includes(`"uidRef":"${current.uid}"`),
        )
      )
        return {
          status: 409,
          body: {
            error: 'record_is_referenced',
            message: 'Another record has a reference to this Organization.',
            constraint: 'organization_reference',
          },
        };
      current.crud = 'D';
      current.pendingExport = true;
      current._deletedAt = '2026-11-02T12:00:00.000Z';
      return { status: 204 };
    }
    if (call.method !== 'POST' && call.method !== 'PUT')
      return { status: 405, body: { error: 'method_not_allowed' } };
    if (call.method === 'PUT' && !current)
      return { status: 404, body: { error: 'record_not_found' } };
    const body = call.body || {};
    if (['uid', 'crud', 'id', 'revision', '_msg_seq'].some((key) => Object.hasOwn(body, key)))
      return {
        status: 400,
        body: { error: 'invalid_request', message: 'Root identity belongs to the server.' },
      };
    const issues = validateOrganization(body);
    if (issues.length)
      return {
        status: 400,
        body: { error: 'invalid_request', message: 'Check the fields.', details: { issues } },
      };
    if (current && same(current.value, body))
      return { status: 200, body: { data: structuredClone(current) } };
    const value = structuredClone(body);
    // Only document assignments and remarks used in these tests receive fixture identities.
    // Actual allocation, baseline history and nested deletion persistence are backend responsibilities.
    const before = new Map<string, JsonObject>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(collect);
        return;
      }
      if (!isObject(node)) return;
      if (typeof node['uid'] === 'string') before.set(node['uid'], node);
      Object.values(node).forEach(collect);
    };
    collect(current?.value);
    const prepare = (node: unknown, type: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item) => prepare(item, type));
        return;
      }
      if (!isObject(node)) return;
      const shape = shapeOf(type);
      if (!shape) return;
      if (type === 'documentAssignment' || type === 'remark') {
        const old = typeof node['uid'] === 'string' ? before.get(node['uid']) : undefined;
        if (!old) {
          node['uid'] = (type === 'remark' ? 'rmk' : 'docasg') + this.nextIdentity++;
          node['crud'] = 'I';
        } else if (!same(old, node)) node['crud'] = old['crud'] === 'I' ? 'I' : 'U';
      }
      for (const field of shape.fields) if (field.ref) prepare(node[field.name], field.ref);
    };
    prepare(value, 'organization');
    const saved: ApiEntityRecord<OrganizationValue> = current || {
      id: String(this.nextIdentity++),
      uid: 'org' + this.nextIdentity++,
      crud: 'I',
      pendingExport: true,
      _createdAt: '2026-11-02T12:00:00.000Z',
      _updatedAt: '2026-11-02T12:00:00.000Z',
      _deletedAt: null,
      value: value as OrganizationValue,
    };
    saved.value = value as OrganizationValue;
    saved.crud = current?.crud === 'R' ? 'U' : saved.crud;
    saved.pendingExport = true;
    saved._updatedAt = '2026-11-02T12:30:00.000Z';
    if (!current) this.records.push(saved);
    return { status: call.method === 'POST' ? 201 : 200, body: { data: structuredClone(saved) } };
  }
}
export const test = base.extend<{ backend: BackendFixture }>({
  backend: async ({ page }, use) => {
    const backend = new BackendFixture();
    await backend.install(page);
    await use(backend);
  },
});
export { expect };
