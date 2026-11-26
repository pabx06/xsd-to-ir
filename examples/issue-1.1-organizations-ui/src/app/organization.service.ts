import { Injectable, inject } from '@angular/core';
import {
  EMPTY,
  catchError,
  defer,
  expand,
  forkJoin,
  map,
  of,
  reduce,
  shareReplay,
  tap,
  throwError,
  type Observable,
} from 'rxjs';
import { EntityCrudHttpService } from './entity-crud-http.service';
import {
  CrudError,
  ENTITY,
  type OrganizationCrudService,
  type EntityId,
  type EntityRecord,
  type JsonObject,
  type ListQuery,
  type OrganizationSummary,
  type OrganizationValue,
  type ReferenceCatalog,
} from './models';

const sources = [
  ['organizationReference', 'organization', ['name', 'orgId']],
  ['documentReference', 'externalDocument', ['docId', 'docTitle']],
  ['documentIssueReference', 'externalDocumentIssue', ['docIssId']],
  ['applicabilityStatementReference', 'applicabilityStatement', ['applicId', 'applicDescr']],
] as const;
function labelText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(labelText).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    const object = value as JsonObject;
    for (const key of ['descr', 'id', 'value'])
      if (typeof object[key] === 'string') return object[key] as string;
  }
  return '';
}
@Injectable({ providedIn: 'root' })
export class OrganizationService implements OrganizationCrudService {
  private readonly http = inject(EntityCrudHttpService);
  private readonly catalogs = new Map<string, Observable<ReferenceCatalog>>();
  list(project: string, entity: string, query: ListQuery = {}) {
    return this.http.list<OrganizationValue>(project, entity, query);
  }
  findById(project: string, entity: string, id: EntityId) {
    return this.http.findById<OrganizationValue>(project, entity, id);
  }
  create(project: string, entity: string, value: OrganizationValue) {
    return this.http.create(project, entity, value).pipe(tap(() => this.catalogs.delete(project)));
  }
  update(project: string, entity: string, id: EntityId, value: OrganizationValue) {
    return this.http
      .update(project, entity, id, value)
      .pipe(tap(() => this.catalogs.delete(project)));
  }
  delete(project: string, entity: string, id: EntityId) {
    return this.http.delete(project, entity, id).pipe(tap(() => this.catalogs.delete(project)));
  }
  summary(project: string): Observable<OrganizationSummary> {
    return this.http.summary<OrganizationSummary>(project, ENTITY).pipe(
      map((summary) => {
        if (summary?.schemaIssue !== '1.1')
          throw new CrudError(
            'schema_issue',
            'This project does not report S3000L Issue 1.1. Editing is disabled.',
          );
        if (
          ![summary.total, summary.pending, summary.documents, summary.deleted].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          )
        )
          throw new CrudError(
            'invalid_response',
            'The backend returned invalid Organization totals.',
          );
        return summary;
      }),
    );
  }
  private all(project: string, entity: string): Observable<EntityRecord<JsonObject>[]> {
    const page = (number: number) =>
      this.http
        .list<JsonObject>(project, entity, {
          page: number,
          pageSize: 100,
          sortBy: 'uid',
          sortDirection: 'asc',
        })
        .pipe(
          map((response) => {
            const expected = Math.max(
              0,
              Math.min(100, response.metadata.total - (number - 1) * 100),
            );
            if (
              response.metadata.page !== number ||
              response.metadata.pageSize !== 100 ||
              response.data.length !== expected
            )
              throw new CrudError(
                'invalid_response',
                `The backend returned an invalid reference page for ${entity}.`,
              );
            return response;
          }),
        );
    return defer(() => page(1)).pipe(
      expand(
        (response) =>
          response.metadata.page < response.metadata.pageCount
            ? page(response.metadata.page + 1)
            : EMPTY,
        1,
      ),
      reduce(
        (state, response) => {
          if (state.total !== undefined && state.total !== response.metadata.total)
            throw new CrudError(
              'catalog_changed',
              'Reference records changed while loading. Retry the reference choices.',
            );
          return { rows: [...state.rows, ...response.data], total: response.metadata.total };
        },
        { rows: [] as EntityRecord<JsonObject>[], total: undefined as number | undefined },
      ),
      map(({ rows, total }) => {
        if (rows.length !== total || new Set(rows.map((row) => row.uid)).size !== rows.length)
          throw new CrudError(
            'invalid_response',
            'Reference pages are incomplete or contain duplicate XML UIDs. Retry the reference choices.',
          );
        return rows;
      }),
    );
  }
  references(project: string, refresh = false): Observable<ReferenceCatalog> {
    if (refresh) this.catalogs.delete(project);
    const cached = this.catalogs.get(project);
    if (cached) return cached;
    const catalog = forkJoin(
      sources.map(([type, entity, fields]) =>
        this.all(project, entity).pipe(
          map(
            (rows) =>
              [
                type,
                rows
                  .filter((row) => row.deletedAt === null)
                  .map((row) => ({
                    label:
                      fields
                        .map((field) => labelText(row.value[field]))
                        .filter(Boolean)
                        .join(' · ') || row.uid,
                    value: { uidRef: row.uid },
                  })),
              ] as const,
          ),
        ),
      ),
    ).pipe(
      map((entries) => Object.fromEntries(entries)),
      tap((value) => {
        if (this.catalogs.get(project) === catalog) this.catalogs.set(project, of(value));
      }),
      catchError((error) => {
        if (this.catalogs.get(project) === catalog) this.catalogs.delete(project);
        return throwError(() => error);
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    this.catalogs.set(project, catalog);
    return catalog;
  }
}
