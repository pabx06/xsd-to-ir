import { Component, HostListener, OnDestroy, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Subscription, debounceTime, distinctUntilChanged, finalize } from 'rxjs';
import { ButtonModule } from '@openng/optimus-ui/button';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { DrawerModule } from '@openng/optimus-ui/drawer';
import { DialogModule } from '@openng/optimus-ui/dialog';
import { TableModule } from '@openng/optimus-ui/table';
import { FieldEditor } from './field-editor';
import { FieldNode } from './field-node';
import { organizationFields, same } from './metadata';
import { RUNTIME_CONFIG } from './runtime-config';
import { validateOrganization } from './validation';
import {
  CrudError,
  ENTITY,
  ORGANIZATION_CRUD,
  displayName,
  type FieldIssue,
  type ListQuery,
  type OrganizationRecord,
  type OrganizationValue,
  type ReferenceCatalog,
} from './models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    ButtonModule,
    InputTextModule,
    DrawerModule,
    DialogModule,
    TableModule,
    FieldEditor,
  ],
  templateUrl: './app.html',
})
export class App implements OnDestroy {
  readonly api = inject(ORGANIZATION_CRUD);
  readonly configuration = inject(RUNTIME_CONFIG);
  readonly projectLabel = this.configuration.config?.projectLabel || 'Project not configured';
  private readonly project = this.configuration.config?.projectId || '';
  readonly ready = signal(false);
  readonly connecting = signal(false);
  readonly loading = signal(false);
  readonly opening = signal(false);
  readonly referencesLoading = signal(false);
  readonly referenceError = signal('');
  readonly search = new FormControl('', { nonNullable: true });
  readonly status = new FormControl('', { nonNullable: true });
  readonly rows = signal<OrganizationRecord[]>([]);
  readonly pageInfo = signal({ page: 1, pageSize: 6, total: 0, pageCount: 0 });
  readonly stats = signal({ total: 0, pending: 0, documents: 0, deleted: 0 });
  readonly error = signal('');
  readonly feedback = signal('');
  readonly busy = signal(false);
  readonly editorOpen = signal(false);
  readonly selected = signal<OrganizationRecord | null>(null);
  readonly tab = signal('Details');
  readonly issues = signal<FieldIssue[]>([]);
  readonly references = signal<ReferenceCatalog>({});
  readonly formVersion = signal(0);
  readonly confirmation = signal<{
    title: string;
    message: string;
    action: string;
    run: () => void;
  } | null>(null);
  readonly tabs = ['Details', 'Identifiers', 'Documents', 'Remarks'];
  readonly workAreas = [
    { label: 'Product and project', icon: 'pi-briefcase' },
    { label: 'Product structure', icon: 'pi-sitemap' },
    { label: 'Part definition', icon: 'pi-box' },
    { label: 'Tasks and requirements', icon: 'pi-list-check' },
    { label: 'Task resources', icon: 'pi-wrench' },
  ];
  readonly title = displayName;
  fields: FieldNode[] = [];
  original: OrganizationValue = { orgId: [{ id: '' }] };
  sortBy: NonNullable<ListQuery['sortBy']> = '_updatedAt';
  sortDirection: 'asc' | 'desc' = 'desc';
  private subscriptions = new Subscription();
  private listRead?: Subscription;
  private summaryRead?: Subscription;
  private referenceRead?: Subscription;
  private recordRead?: Subscription;
  private opener: HTMLElement | null = null;
  // Intercept Escape before the drawer's own handler can remove its mask.
  private modalKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || (!this.editorOpen() && !this.confirmation())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.confirmation()) this.cancelConfirmation();
    else this.close();
  };
  readonly dirty = computed(() => {
    this.formVersion();
    return this.editorOpen() && !same(this.original, this.value());
  });
  readonly visibleFields = computed(() => {
    this.formVersion();
    const names: Record<string, string> = {
      Details: 'name',
      Identifiers: 'orgId',
      Documents: 'docs',
      Remarks: 'rmks',
    };
    return this.fields.filter((node) => node.field.name === names[this.tab()]);
  });
  constructor() {
    document.addEventListener('keydown', this.modalKey, { capture: true });
    this.subscriptions.add(
      this.search.valueChanges
        .pipe(debounceTime(180), distinctUntilChanged())
        .subscribe(() => this.refresh(1)),
    );
    this.subscriptions.add(this.status.valueChanges.subscribe(() => this.refresh(1)));
    this.connect();
  }
  connect(): void {
    if (this.busy()) return;
    if (!this.configuration.config) {
      this.error.set(this.configuration.error);
      return;
    }
    this.summaryRead?.unsubscribe();
    this.listRead?.unsubscribe();
    this.referenceRead?.unsubscribe();
    this.recordRead?.unsubscribe();
    this.ready.set(false);
    this.connecting.set(true);
    this.error.set('');
    this.summaryRead = this.api
      .summary(this.project)
      .pipe(finalize(() => this.connecting.set(false)))
      .subscribe({
        next: (stats) => {
          this.stats.set(stats);
          this.ready.set(true);
          this.refresh();
          this.loadReferences(true);
        },
        error: (error) => this.report(error),
      });
  }
  refresh(page = this.pageInfo().page): void {
    if (!this.ready() || this.busy()) return;
    this.listRead?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.listRead = this.api
      .list(this.project, ENTITY, {
        page,
        pageSize: this.pageInfo().pageSize,
        sortBy: this.sortBy,
        sortDirection: this.sortDirection,
        filters: { search: this.search.value, status: this.status.value },
      })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          if (response.metadata.page > 1 && response.metadata.page > response.metadata.pageCount) {
            this.refresh(Math.max(1, response.metadata.pageCount));
            return;
          }
          this.rows.set(response.data);
          this.pageInfo.set(response.metadata);
        },
        error: (error) => {
          this.rows.set([]);
          this.report(error);
        },
      });
  }
  loadReferences(refresh = false): void {
    if (!this.ready() || this.busy()) return;
    this.referenceRead?.unsubscribe();
    this.referencesLoading.set(true);
    this.referenceError.set('');
    this.references.set({});
    this.referenceRead = this.api
      .references(this.project, refresh)
      .pipe(finalize(() => this.referencesLoading.set(false)))
      .subscribe({
        next: (references) => this.references.set(references),
        error: (error) => this.referenceError.set(this.errorMessage(error)),
      });
  }
  sort(field: NonNullable<ListQuery['sortBy']>): void {
    this.sortDirection = this.sortBy === field && this.sortDirection === 'asc' ? 'desc' : 'asc';
    this.sortBy = field;
    this.refresh(1);
  }
  ariaSort(field: string): 'ascending' | 'descending' | 'none' {
    return this.sortBy !== field
      ? 'none'
      : this.sortDirection === 'asc'
        ? 'ascending'
        : 'descending';
  }
  setPageSize(event: Event): void {
    this.pageInfo.update((value) => ({
      ...value,
      pageSize: Number((event.target as HTMLSelectElement).value),
    }));
    this.refresh(1);
  }
  tabKey(event: KeyboardEvent, current: string): void {
    const index = this.tabs.indexOf(current);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % this.tabs.length
        : event.key === 'ArrowLeft'
          ? (index + this.tabs.length - 1) % this.tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? this.tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    this.tab.set(this.tabs[next]);
    document.getElementById(`tab-${this.tabs[next]}`)?.focus();
  }
  open(row?: OrganizationRecord): void {
    if (!this.ready() || this.busy()) return;
    const start = () => {
      this.recordRead?.unsubscribe();
      this.opener = document.activeElement as HTMLElement;
      if (row) {
        this.opening.set(true);
        this.recordRead = this.api
          .findById(this.project, ENTITY, row.id)
          .pipe(finalize(() => this.opening.set(false)))
          .subscribe({
            next: (fresh) => this.startEditor(fresh),
            error: (error) => this.report(error),
          });
      } else this.startEditor(null);
    };
    this.guard(start);
  }
  private startEditor(row: OrganizationRecord | null): void {
    this.fields.forEach((node) => node.dispose());
    this.selected.set(row);
    this.tab.set('Details');
    this.issues.set([]);
    this.error.set('');
    this.feedback.set('');
    this.original = structuredClone(row?.value || { orgId: [{ id: '' }], name: { descr: '' } });
    this.fields = organizationFields.map((field) => {
      const node = new FieldNode(field, this.original[field.name as keyof OrganizationValue], () =>
        this.formVersion.update((v) => v + 1),
      );
      node.expanded = true;
      node.materialize();
      if (field.name === 'orgId')
        for (const item of node.items || []) {
          item.expanded = true;
          item.materialize();
        }
      return node;
    });
    this.formVersion.update((v) => v + 1);
    this.editorOpen.set(true);
  }
  value(): OrganizationValue {
    return Object.fromEntries(
      this.fields
        .map((node) => [node.field.name, node.read()])
        .filter(([, value]) => value !== undefined),
    ) as OrganizationValue;
  }
  save(): void {
    if (!this.ready() || this.busy() || !this.editorOpen()) return;
    this.error.set('');
    this.issues.set([]);
    const value = this.value();
    const row = this.selected();
    if (row && same(this.original, value)) {
      this.finishClose();
      this.feedback.set('No changes to save.');
      return;
    }
    const issues = validateOrganization(value, row?.uid, row?.crud);
    if (issues.length) {
      this.issues.set(issues);
      this.error.set('Check the marked fields before saving.');
      return;
    }
    this.busy.set(true);
    const request = row
      ? this.api.update(this.project, ENTITY, row.id, value)
      : this.api.create(this.project, ENTITY, value);
    this.subscriptions.add(
      request.pipe(finalize(() => this.busy.set(false))).subscribe({
        next: (saved) => {
          this.busy.set(false);
          this.finishClose();
          this.connect();
          this.feedback.set(
            `${displayName(saved.value)} saved.${saved.pendingExport ? ' Changes are pending export.' : ''}`,
          );
        },
        error: (error) => {
          this.busy.set(false);
          this.report(error);
          if (error instanceof CrudError) this.issues.set(error.issues);
        },
      }),
    );
  }
  close(): void {
    if (this.busy()) return;
    this.guard(() => this.finishClose());
  }
  private finishClose(): void {
    this.editorOpen.set(false);
    this.fields.forEach((node) => node.dispose());
    this.issues.set([]);
    this.selected.set(null);
    setTimeout(() => this.opener?.focus(), 0);
  }
  focusEditor(): void {
    setTimeout(() => document.getElementById('editor-close')?.focus({ preventScroll: true }), 0);
  }
  cancelConfirmation(): void {
    this.confirmation.set(null);
    if (this.editorOpen()) this.focusEditor();
  }
  private guard(action: () => void): void {
    if (!this.dirty()) {
      action();
      return;
    }
    this.confirmation.set({
      title: 'Discard unsaved changes?',
      message: 'Your changes have not been saved. Discard them to continue.',
      action: 'Discard changes',
      run: action,
    });
  }
  deleteSelected(): void {
    const row = this.selected();
    if (!row || this.busy() || !this.ready()) return;
    this.confirmation.set({
      title: 'Delete organization?',
      message: `${displayName(row.value)} will be removed from the active list. Its deletion will remain pending export.${this.dirty() ? ' Unsaved changes will be discarded.' : ''}`,
      action: 'Delete organization',
      run: () => {
        if (this.busy()) return;
        this.busy.set(true);
        this.error.set('');
        this.subscriptions.add(
          this.api
            .delete(this.project, ENTITY, row.id)
            .pipe(finalize(() => this.busy.set(false)))
            .subscribe({
              next: () => {
                this.busy.set(false);
                this.finishClose();
                this.connect();
                this.feedback.set('Organization deleted.');
              },
              error: (error) => this.report(error),
            }),
        );
      },
    });
  }
  confirm(): void {
    const confirmation = this.confirmation();
    this.confirmation.set(null);
    confirmation?.run();
  }
  focusIssue(issue: FieldIssue): void {
    const segments = issue.path.split('/').slice(1);
    this.tab.set(
      (
        { orgId: 'Identifiers', docs: 'Documents', rmks: 'Remarks', name: 'Details' } as Record<
          string,
          string
        >
      )[segments[0]] || 'Details',
    );
    let node = this.fields.find((field) => field.field.name === segments[0]);
    for (const segment of segments.slice(1)) {
      if (!node) break;
      node.expanded = true;
      node.materialize();
      node = node.isArray
        ? node.items?.[Number(segment)]
        : node.children?.find((child) => child.field.name === segment);
    }
    if (node) {
      node.expanded = true;
      node.materialize();
    }
    setTimeout(
      () => document.getElementById(`field-${issue.path.replace(/[^a-zA-Z0-9_-]/g, '-')}`)?.focus(),
      0,
    );
  }
  report(error: unknown): void {
    this.error.set(this.errorMessage(error));
  }
  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : 'The operation failed.';
    if (!(error instanceof CrudError)) return message;
    const details = [
      error.httpStatus ? `${error.httpStatus} · ${error.code}` : '',
      error.projectStatus ? `Project status: ${error.projectStatus}` : '',
      error.constraint ? `Constraint: ${error.constraint}` : '',
    ].filter(Boolean);
    return message + (details.length ? ` (${details.join('; ')})` : '');
  }
  @HostListener('window:beforeunload', ['$event']) beforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }
  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.modalKey, { capture: true });
    this.subscriptions.unsubscribe();
    [this.listRead, this.summaryRead, this.referenceRead, this.recordRead].forEach((read) =>
      read?.unsubscribe(),
    );
    this.fields.forEach((node) => node.dispose());
  }
}
