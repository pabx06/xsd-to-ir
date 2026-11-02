import { describe, expect, it } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { mapRecord, toCrudError } from '../src/app/entity-crud-http.service';
import { parseRuntimeConfig, loadRuntimeConfig } from '../src/app/runtime-config';
import {
  fixtureRecords,
  fixtureCatalogs,
  TEST_CONFIG,
  TEST_PROJECT as P,
} from './fixtures/records';
import { transport } from './fixtures/http';
import type { OrganizationValue } from '../src/app/models';

const E = 'organization';
const minimal: OrganizationValue = { orgId: [{ id: '000123' }] };
const envelope = (data: unknown[], page = 1, total = data.length, pageSize = 100) => ({
  data,
  metadata: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) },
});
describe('configuration before initialization', () => {
  it('requires a project, label, Issue 1.1, and a same-origin API path', () => {
    expect(parseRuntimeConfig({ ...TEST_CONFIG, apiBasePath: '/api/' })).toEqual(TEST_CONFIG);
    for (const value of [
      null,
      {},
      { ...TEST_CONFIG, projectId: ' ' },
      { ...TEST_CONFIG, projectLabel: '' },
      { ...TEST_CONFIG, schemaIssue: '2.0' },
      ...['https://host/api', '//host/api', '/api/../other', '/api?x=1'].map((apiBasePath) => ({
        ...TEST_CONFIG,
        apiBasePath,
      })),
    ])
      expect(() => parseRuntimeConfig(value)).toThrow();
  });
  it('reports missing, malformed or unavailable files without a CRUD request', async () => {
    for (const response of [
      new Response('Not found', { status: 404 }),
      new Response('{broken'),
      new Response('{}'),
    ]) {
      const state = await loadRuntimeConfig(async () => response);
      expect(state.error).toBeTruthy();
      const { http, backend } = transport(state);
      await expect(firstValueFrom(http.list(P, E))).rejects.toMatchObject({
        code: 'configuration',
      });
      expect(backend.requests).toHaveLength(0);
    }
    expect(
      await loadRuntimeConfig(async (_input, init) => {
        expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
        return Response.json(TEST_CONFIG);
      }),
    ).toEqual({ config: TEST_CONFIG });
    expect(
      (
        await loadRuntimeConfig(async () => {
          throw Error('Network down');
        })
      ).error,
    ).toBe('Network down');
  });
});
describe('generic HTTP transport', () => {
  it('encodes queries and maps mixed ID types and timestamp names', async () => {
    const { http, backend } = transport();
    const result = firstValueFrom(
      http.list('project / one', E, {
        page: 2,
        pageSize: 6,
        sortBy: '_updatedAt',
        sortDirection: 'desc',
        filters: {
          search: '000042 & Co',
          status: 'pending',
          empty: '',
          nil: null,
          zero: 0,
          no: false,
        },
      }),
    );
    const request = backend.last.request;
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/api/projects/project%20%2F%20one/entities/organization');
    expect(request.withCredentials).toBe(true);
    expect(request.params.keys()).toEqual([
      'page',
      'pageSize',
      'sortBy',
      'sortDirection',
      'filter.search',
      'filter.status',
      'filter.zero',
      'filter.no',
    ]);
    expect(request.params.get('filter.search')).toBe('000042 & Co');
    expect(request.params.get('filter.status')).toBe('pending');
    expect(request.params.get('sortBy')).toBe('_updatedAt');
    const rows = fixtureRecords().slice(0, 2);
    rows[1].id = 2;
    backend.last.reply(envelope(rows, 2, 8, 6));
    expect(await result).toEqual({
      data: rows.map(mapRecord),
      metadata: { page: 2, pageSize: 6, total: 8, pageCount: 2 },
    });
    expect((await result).data[0]).toMatchObject({
      id: '1',
      createdAt: rows[0]._createdAt,
      deletedAt: null,
      value: { orgId: [{ id: '001234' }, { id: 'AURORA-DESIGN' }] },
    });
    expect((await result).data[0]).not.toHaveProperty('_createdAt');
  });
  it('uses GET, POST, complete PUT, and DELETE with string record IDs', async () => {
    const { http, backend } = transport();
    const record = fixtureRecords()[0];
    const get = firstValueFrom(http.findById(P, E, 'a/b c'));
    expect(backend.last.request.url.endsWith('/a%2Fb%20c')).toBe(true);
    backend.last.reply({ data: record });
    await get;
    const create = firstValueFrom(http.create(P, E, minimal));
    expect(backend.last.request.method).toBe('POST');
    expect(backend.last.request.body).toEqual(minimal);
    backend.last.reply({
      data: { ...record, uid: 'org900', crud: 'I', pendingExport: true, value: minimal },
    });
    expect(await create).toMatchObject({
      uid: 'org900',
      crud: 'I',
      pendingExport: true,
      value: minimal,
    });
    const body = { ...minimal, docs: null };
    const update = firstValueFrom(http.update(P, E, record.id, body));
    expect(backend.last.request.method).toBe('PUT');
    expect(backend.last.request.body).toEqual(body);
    for (const key of ['revision', 'changes', 'remove', 'uid', 'crud', 'name'])
      expect(backend.last.request.body).not.toHaveProperty(key);
    backend.last.reply({ data: { ...record, value: body, crud: 'U', pendingExport: true } });
    expect(await update).toMatchObject({ crud: 'U', value: { docs: null } });
    const remove = firstValueFrom(http.delete(P, E, record.id));
    expect(backend.last.request.method).toBe('DELETE');
    backend.last.reply(null, 204);
    await remove;
  });
  it('keeps complete nested values and accepts only backend-assigned tracking in responses', async () => {
    const { http, backend } = transport();
    const value = structuredClone(fixtureRecords()[0].value);
    value.docs!.doc.push({ docRef: { uidRef: 'doc2' } });
    const result = firstValueFrom(http.update(P, E, '1', value));
    expect(backend.last.request.body).toEqual(value);
    const returned = structuredClone(value);
    returned.docs!.doc[1] = { ...returned.docs!.doc[1], uid: 'docasg999', crud: 'I' };
    backend.last.reply({
      data: { ...fixtureRecords()[0], crud: 'U', pendingExport: true, value: returned },
    });
    const saved = await result;
    expect(saved.value.docs!.doc[0]).toEqual(value.docs!.doc[0]);
    expect(saved.value.docs!.doc[1]).toMatchObject({ uid: 'docasg999', crud: 'I' });
    expect(value.docs!.doc[1]).not.toHaveProperty('uid');
  });
  it('cancels obsolete reads and does not retry a failed PUT as PATCH', async () => {
    const { http, backend } = transport();
    const received: unknown[] = [];
    const old = http
      .list(P, E, { filters: { search: 'old' } })
      .subscribe((value) => received.push(value));
    const pending = backend.last;
    old.unsubscribe();
    expect(pending.cancelled).toBe(true);
    pending.reply(envelope(fixtureRecords()));
    expect(received).toEqual([]);
    const value = fixtureRecords()[0].value;
    const update = firstValueFrom(http.update(P, E, '1', value));
    backend.last.reply({ error: 'forbidden', message: 'No update permission' }, 403);
    await expect(update).rejects.toMatchObject({ httpStatus: 403, code: 'forbidden' });
    expect(backend.requests.map((item) => item.request.method)).toEqual(['GET', 'PUT']);
    expect(value).toEqual(fixtureRecords()[0].value);
  });
  it('rejects incompatible record and pagination contracts', async () => {
    for (const change of [
      { id: 9007199254740992 },
      { _updatedAt: 'bad' },
      { value: 'json string' },
      { pendingExport: undefined },
    ])
      expect(() => mapRecord({ ...fixtureRecords()[0], ...change } as never)).toThrow();
    const { http, backend } = transport();
    const result = firstValueFrom(http.list(P, E));
    backend.last.reply({ data: [], metadata: { page: 1, pageSize: 100, total: 2, pageCount: 0 } });
    await expect(result).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
describe('backend errors', () => {
  it('retains structured pointers, Zod errors, permission, status and constraints', () => {
    const error = toCrudError(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: 'project_not_ready',
          message: 'Wait for import',
          status: 'importing',
          constraint: 'organization_uid',
          details: {
            issues: [{ path: '/orgId/0/id', message: 'Invalid ID' }],
            fieldErrors: { name: ['Invalid name'] },
            formErrors: ['Invalid record'],
          },
        },
      }),
    );
    expect(error).toMatchObject({
      code: 'project_not_ready',
      httpStatus: 409,
      projectStatus: 'importing',
      constraint: 'organization_uid',
      issues: [
        { path: '/orgId/0/id', message: 'Invalid ID' },
        { path: '/name', message: 'Invalid name' },
        { path: '', message: 'Invalid record' },
      ],
    });
    const bare = toCrudError(
      new HttpErrorResponse({
        status: 400,
        error: { error: 'invalid_request', message: 'Adapter validation failed' },
      }),
    );
    expect(bare.message).toBe('Adapter validation failed');
    expect(bare.issues).toEqual([]);
    expect(toCrudError(new HttpErrorResponse({ status: 0 })).message).toContain('unavailable');
    expect(toCrudError(new HttpErrorResponse({ status: 401 })).message).toContain('Sign in');
  });
});
describe('Organization API', () => {
  it('verifies the summary issue and counts before enabling edits', async () => {
    const { service, backend } = transport();
    for (const schemaIssue of ['1.1', '2.0']) {
      const result = firstValueFrom(service.summary(P));
      expect(backend.last.request.url).toBe(`/api/projects/${P}/entities/organization/summary`);
      backend.last.reply({ data: { schemaIssue, total: 8, pending: 2, documents: 3, deleted: 1 } });
      if (schemaIssue === '1.1')
        expect(await result).toMatchObject({ total: 8, pending: 2, documents: 3, deleted: 1 });
      else await expect(result).rejects.toMatchObject({ code: 'schema_issue' });
    }
  });
  it('loads all reference pages with XML UIDs, caches per project, and refreshes after writes', async () => {
    const { service, backend } = transport();
    const catalog = firstValueFrom(service.references(P));
    expect(backend.requests).toHaveLength(4);
    for (const pending of [...backend.requests]) {
      expect(pending.request.params.get('pageSize')).toBe('100');
      expect(pending.request.params.get('sortBy')).toBe('uid');
      const entity = pending.request.url.split('/').at(-1)!;
      if (entity === 'organization')
        pending.reply(
          envelope(
            Array.from({ length: 100 }, (_, i) => ({
              ...fixtureRecords()[0],
              id: String(i + 1),
              uid: 'org' + (i + 1),
            })),
            1,
            101,
          ),
        );
      else pending.reply(envelope(fixtureCatalogs()[entity]));
    }
    expect(backend.last.request.params.get('page')).toBe('2');
    backend.last.reply(envelope([{ ...fixtureRecords()[0], id: '101', uid: 'org101' }], 2, 101));
    const choices = await catalog;
    expect(choices['organizationReference']).toHaveLength(101);
    expect(choices['organizationReference'][100].value).toEqual({ uidRef: 'org101' });
    expect(choices['documentReference'][0].label).toContain('DOC-001');
    expect(await firstValueFrom(service.references(P))).toEqual(choices);
    expect(backend.requests).toHaveLength(5);
    const write = firstValueFrom(service.update(P, E, '1', minimal));
    backend.last.reply({ data: { ...fixtureRecords()[0], value: minimal } });
    await write;
    const refresh = service.references(P).subscribe();
    expect(backend.requests).toHaveLength(10);
    refresh.unsubscribe();
    const other = service.references('other-project').subscribe();
    expect(backend.requests).toHaveLength(14);
    other.unsubscribe();
  });
  it('does not return partial catalogs on a failed page and permits a retry', async () => {
    const { service, backend } = transport();
    const result = firstValueFrom(service.references(P));
    backend.last.reply({ error: 'forbidden', message: 'No reference access' }, 403);
    await expect(result).rejects.toMatchObject({ httpStatus: 403 });
    const retry = service.references(P).subscribe();
    expect(backend.requests).toHaveLength(8);
    retry.unsubscribe();
  });
  it('rejects silently truncated catalog pages', async () => {
    const { service, backend } = transport();
    const result = firstValueFrom(service.references(P));
    backend.requests[0].reply(envelope(fixtureRecords(), 1, 101));
    await expect(result).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
