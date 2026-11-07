import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, defer, map, throwError, type Observable } from 'rxjs';
import { RUNTIME_CONFIG } from './runtime-config';
import {
  CrudError,
  type ApiEntityRecord,
  type EntityId,
  type EntityListQuery,
  type EntityRecord,
  type FieldIssue,
  type ListResponse,
  type PageMetadata,
} from './models';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const pointer = (key: string): string => '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function invalidResponse(): never {
  throw new CrudError(
    'invalid_response',
    'The backend returned an unexpected response. Check the backend contract.',
  );
}
export function mapRecord<T>(raw: ApiEntityRecord<T>): EntityRecord<T> {
  if (
    !object(raw) ||
    !object(raw.value) ||
    Object.hasOwn(raw.value, 'uid') ||
    Object.hasOwn(raw.value, 'crud') ||
    !((typeof raw.id === 'string' && raw.id.length > 0) || count(raw.id)) ||
    typeof raw.uid !== 'string' ||
    !raw.uid ||
    !['I', 'U', 'R', 'D'].includes(raw.crud) ||
    typeof raw.pendingExport !== 'boolean' ||
    ![raw._createdAt, raw._updatedAt].every(
      (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)),
    ) ||
    !(
      raw._deletedAt === null ||
      (typeof raw._deletedAt === 'string' && Number.isFinite(Date.parse(raw._deletedAt)))
    )
  )
    invalidResponse();
  return {
    id: raw.id,
    uid: raw.uid,
    crud: raw.crud,
    pendingExport: raw.pendingExport,
    createdAt: raw._createdAt,
    updatedAt: raw._updatedAt,
    deletedAt: raw._deletedAt,
    value: raw.value,
  };
}
function pageMetadata(value: PageMetadata): PageMetadata {
  if (
    !object(value) ||
    !count(value.page) ||
    value.page < 1 ||
    !count(value.pageSize) ||
    value.pageSize < 1 ||
    !count(value.total) ||
    !count(value.pageCount) ||
    value.pageCount !== Math.ceil(value.total / value.pageSize)
  )
    invalidResponse();
  return value;
}
export function toCrudError(error: unknown): CrudError {
  if (error instanceof CrudError) return error;
  if (!(error instanceof HttpErrorResponse))
    return new CrudError(
      'unknown_error',
      error instanceof Error ? error.message : 'The operation failed.',
    );
  const body = object(error.error) ? error.error : {};
  const details = object(body['details']) ? body['details'] : {};
  const issues: FieldIssue[] = [];
  if (Array.isArray(details['issues']))
    for (const item of details['issues']) {
      if (
        object(item) &&
        typeof item['path'] === 'string' &&
        (item['path'] === '' || item['path'].startsWith('/')) &&
        typeof item['message'] === 'string'
      )
        issues.push({ path: item['path'], message: item['message'] });
    }
  if (object(details['fieldErrors']))
    for (const [field, messages] of Object.entries(details['fieldErrors'])) {
      if (Array.isArray(messages))
        for (const message of messages)
          if (typeof message === 'string') issues.push({ path: pointer(field), message });
    }
  if (Array.isArray(details['formErrors']))
    for (const message of details['formErrors'])
      if (typeof message === 'string') issues.push({ path: '', message });
  const defaults: Record<number, string> = {
    0: 'The backend is unavailable. Check the connection before trying again.',
    400: 'The request is invalid.',
    401: 'Sign in to the backend, then try again.',
    403: 'You are not allowed to perform this operation.',
    404: 'The requested resource was not found.',
    409: 'The operation conflicts with the current project or record state.',
  };
  return new CrudError(
    typeof body['error'] === 'string' ? body['error'] : 'http_error',
    typeof body['message'] === 'string'
      ? body['message']
      : defaults[error.status] || 'The backend could not complete the operation.',
    issues,
    error.status,
    typeof body['constraint'] === 'string' ? body['constraint'] : undefined,
    typeof body['status'] === 'string' ? body['status'] : undefined,
  );
}

/** Generic transport. Business validation, identities and tracking belong to the backend. */
@Injectable({ providedIn: 'root' })
export class EntityCrudHttpService {
  private readonly http = inject(HttpClient);
  private readonly configuration = inject(RUNTIME_CONFIG);
  private url(project: string, entity: string, suffix?: EntityId): string {
    const config = this.configuration.config;
    if (!config) throw new CrudError('configuration', this.configuration.error);
    return (
      `${config.apiBasePath}/projects/${encodeURIComponent(project)}/entities/${encodeURIComponent(entity)}` +
      (suffix === undefined ? '' : `/${encodeURIComponent(String(suffix))}`)
    );
  }
  private request<T>(operation: () => Observable<T>): Observable<T> {
    return defer(operation).pipe(catchError((error) => throwError(() => toCrudError(error))));
  }
  list<T>(
    project: string,
    entity: string,
    query: EntityListQuery = {},
  ): Observable<ListResponse<T>> {
    return this.request(() => {
      let params = new HttpParams();
      for (const field of ['page', 'pageSize', 'sortBy', 'sortDirection'] as const) {
        if (query[field] !== undefined) params = params.set(field, String(query[field]));
      }
      for (const [field, value] of Object.entries(query.filters || {})) {
        if (value !== undefined && value !== null && value !== '')
          params = params.set(`filter.${field}`, String(value));
      }
      return this.http
        .get<{ data: ApiEntityRecord<T>[]; metadata: PageMetadata }>(this.url(project, entity), {
          params,
          withCredentials: true,
        })
        .pipe(
          map((response) => {
            if (!response || !Array.isArray(response.data)) invalidResponse();
            return {
              data: response.data.map((row) => mapRecord(row)),
              metadata: pageMetadata(response.metadata),
            };
          }),
        );
    });
  }
  findById<T>(project: string, entity: string, id: EntityId): Observable<EntityRecord<T>> {
    return this.request(() =>
      this.http
        .get<{ data: ApiEntityRecord<T> }>(this.url(project, entity, id), { withCredentials: true })
        .pipe(map((response) => mapRecord(response?.data))),
    );
  }
  create<T>(project: string, entity: string, value: T): Observable<EntityRecord<T>> {
    return this.request(() =>
      this.http
        .post<{ data: ApiEntityRecord<T> }>(this.url(project, entity), value, {
          withCredentials: true,
        })
        .pipe(map((response) => mapRecord(response?.data))),
    );
  }
  update<T>(project: string, entity: string, id: EntityId, value: T): Observable<EntityRecord<T>> {
    return this.request(() =>
      this.http
        .put<{ data: ApiEntityRecord<T> }>(this.url(project, entity, id), value, {
          withCredentials: true,
        })
        .pipe(map((response) => mapRecord(response?.data))),
    );
  }
  delete(project: string, entity: string, id: EntityId): Observable<void> {
    return this.request(() =>
      this.http.delete<void>(this.url(project, entity, id), { withCredentials: true }),
    );
  }
  summary<T>(project: string, entity: string): Observable<T> {
    return this.request(() =>
      this.http
        .get<{ data: T }>(this.url(project, entity, 'summary'), { withCredentials: true })
        .pipe(map((response) => response?.data)),
    );
  }
}
