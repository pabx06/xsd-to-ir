import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { Entities } from '../generated/types';

export type Organization = Entities['organization'];
export type OrganizationValue = Omit<Organization, 'uid' | 'crud'>;
export type JsonObject = Record<string, unknown>;
export interface RemovedRecord {
  uid: string;
  type: string;
  crud: 'D';
  deletedAt: string;
}
export interface EntityRecord<T> {
  id: number;
  revision: number;
  uid: string;
  crud: 'I' | 'U' | 'R' | 'D';
  baseline: boolean;
  pendingExport: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  value: T;
  deletedNested: RemovedRecord[];
}
export type OrganizationRecord = EntityRecord<OrganizationValue>;
export interface ListQuery {
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'identifiers' | 'documents' | 'crud' | 'updatedAt';
  sortDirection?: 'asc' | 'desc';
  filters?: { search?: string; status?: string };
}
export interface ListResponse<T> {
  data: EntityRecord<T>[];
  metadata: { page: number; pageSize: number; total: number; pageCount: number };
}
export interface Update<T> {
  revision: number;
  changes: Partial<T>;
  remove: (keyof T)[];
}
export interface EntityCrudService {
  list(
    project: string,
    entity: string,
    query?: ListQuery,
  ): Observable<ListResponse<OrganizationValue>>;
  findById(project: string, entity: string, id: number): Observable<OrganizationRecord>;
  create(project: string, entity: string, value: OrganizationValue): Observable<OrganizationRecord>;
  update(
    project: string,
    entity: string,
    id: number,
    patch: Update<OrganizationValue>,
  ): Observable<OrganizationRecord>;
  delete(project: string, entity: string, id: number, revision: number): Observable<void>;
}
export const ENTITY_CRUD = new InjectionToken<EntityCrudService>('EntityCrudService');
export interface FieldIssue {
  path: string;
  message: string;
}
export class CrudError extends Error {
  constructor(
    public code:
      'storage' | 'corrupt' | 'validation' | 'conflict' | 'reference' | 'not_found' | 'scope',
    message: string,
    public issues: FieldIssue[] = [],
  ) {
    super(message);
  }
}
export const PROJECT = 'aurora-demo';
export const ENTITY = 'organization';
export const STORAGE_KEY = 'xsd-to-ir:organizations-ui:v1:aurora-demo:issue-1.1';
export interface Snapshot {
  version: 1;
  issue: '1.1';
  projectId: typeof PROJECT;
  revision: number;
  nextId: number;
  nextUid: number;
  establishedUids: string[];
  records: OrganizationRecord[];
}
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface ReferenceOption {
  label: string;
  value: JsonObject;
}
export type ReferenceCatalog = Record<string, ReferenceOption[]>;
export function displayName(value: OrganizationValue): string {
  return value.name?.descr || 'Unnamed organization';
}
