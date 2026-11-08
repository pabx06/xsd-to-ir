import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { Entities } from '../generated/types';
export type Organization = Entities['organization'];
export type OrganizationValue = Omit<Organization, 'uid' | 'crud'>;
export type JsonObject = Record<string, unknown>;
export type EntityId = string | number;
export type CrudMarker = 'I' | 'U' | 'R' | 'D' | 'N';
export interface EntityRecord<T> {
  id: EntityId;
  uid: string;
  crud: CrudMarker;
  pendingExport: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  value: T;
}
/** Backend wire format; timestamp names are mapped at the HTTP boundary. */
export interface ApiEntityRecord<T> {
  id: EntityId;
  uid: string;
  crud: CrudMarker;
  pendingExport: boolean;
  _createdAt: string;
  _updatedAt: string;
  _deletedAt: string | null;
  value: T;
}
export type OrganizationRecord = EntityRecord<OrganizationValue>;
export interface PageMetadata {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}
export interface ListResponse<T> {
  data: EntityRecord<T>[];
  metadata: PageMetadata;
}
export interface EntityListQuery {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  filters?: Record<string, string | number | boolean | null | undefined>;
}
export interface ListQuery extends EntityListQuery {
  sortBy?: 'crud' | '_updatedAt';
  filters?: { search?: string; status?: string };
}
export interface OrganizationSummary {
  schemaIssue: '1.1';
  total: number;
  pending: number;
  documents: number;
  deleted: number;
}
export interface EntityCrudService {
  list(
    project: string,
    entity: string,
    query?: ListQuery,
  ): Observable<ListResponse<OrganizationValue>>;
  findById(project: string, entity: string, id: EntityId): Observable<OrganizationRecord>;
  create(project: string, entity: string, value: OrganizationValue): Observable<OrganizationRecord>;
  update(
    project: string,
    entity: string,
    id: EntityId,
    value: OrganizationValue,
  ): Observable<OrganizationRecord>;
  delete(project: string, entity: string, id: EntityId): Observable<void>;
  summary(project: string): Observable<OrganizationSummary>;
  references(project: string, refresh?: boolean): Observable<ReferenceCatalog>;
}
export const ENTITY_CRUD = new InjectionToken<EntityCrudService>('EntityCrudService');
export const ENTITY = 'organization';
export interface FieldIssue {
  path: string;
  message: string;
}
export class CrudError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly issues: FieldIssue[] = [],
    public readonly httpStatus = 0,
    public readonly constraint?: string,
    public readonly projectStatus?: string,
  ) {
    super(message);
  }
}
export interface ReferenceOption {
  label: string;
  value: JsonObject;
}
export type ReferenceCatalog = Record<string, ReferenceOption[]>;
export function displayName(value: OrganizationValue): string {
  return value.name?.descr || 'Unnamed organization';
}
