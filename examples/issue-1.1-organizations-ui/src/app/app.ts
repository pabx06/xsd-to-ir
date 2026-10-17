import { Component, HostListener, OnDestroy, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Subscription, debounceTime, distinctUntilChanged } from 'rxjs';
import { ButtonModule } from '@openng/optimus-ui/button';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { DrawerModule } from '@openng/optimus-ui/drawer';
import { DialogModule } from '@openng/optimus-ui/dialog';
import { TableModule } from '@openng/optimus-ui/table';
import { FieldEditor } from './field-editor';
import { FieldNode } from './field-node';
import { organizationFields, same } from './metadata';
import { makePatch } from './organization-store';
import { OfflineOrganizationService } from './offline.service';
import {
  CrudError,
  ENTITY,
  ENTITY_CRUD,
  PROJECT,
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
  readonly api = inject(ENTITY_CRUD);
  readonly demo = inject(OfflineOrganizationService);
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
  sortBy: NonNullable<ListQuery['sortBy']> = 'name';
  sortDirection: 'asc' | 'desc' = 'asc';
  private subscriptions = new Subscription();
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
    this.refresh();
  }
  refresh(page = this.pageInfo().page): void {
    this.error.set('');
    this.api
      .list(PROJECT, ENTITY, {
        page,
        pageSize: this.pageInfo().pageSize,
        sortBy: this.sortBy,
        sortDirection: this.sortDirection,
        filters: { search: this.search.value, status: this.status.value },
      })
      .subscribe({
        next: (response) => {
          this.rows.set(response.data);
          this.pageInfo.set(response.metadata);
        },
        error: (error) => {
          this.rows.set([]);
          this.report(error);
        },
      });
    this.demo
      .summary()
      .subscribe({ next: (stats) => this.stats.set(stats), error: (error) => this.report(error) });
    this.demo.references().subscribe({
      next: (references) => this.references.set(references),
      error: (error) => this.report(error),
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
    const start = () => {
      this.opener = document.activeElement as HTMLElement;
      if (row)
        this.api.findById(PROJECT, ENTITY, row.id).subscribe({
          next: (fresh) => this.startEditor(fresh),
          error: (error) => this.report(error),
        });
      else this.startEditor(null);
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
    this.busy.set(true);
    this.error.set('');
    this.issues.set([]);
    const value = this.value();
    const row = this.selected();
    const request = row
      ? this.api.update(PROJECT, ENTITY, row.id, makePatch(this.original, value, row.revision))
      : this.api.create(PROJECT, ENTITY, value);
    request.subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.finishClose();
        this.refresh();
        this.feedback.set(
          row && saved.revision === row.revision
            ? 'No changes to save.'
            : `${displayName(saved.value)} saved. Changes are pending export.`,
        );
      },
      error: (error) => {
        this.busy.set(false);
        this.report(error);
        if (error instanceof CrudError) this.issues.set(error.issues);
      },
    });
  }
  close(): void {
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
    if (!row) return;
    this.confirmation.set({
      title: 'Delete organization?',
      message: `${displayName(row.value)} will be removed from the active list. Its deletion will remain pending export.${this.dirty() ? ' Unsaved changes will be discarded.' : ''}`,
      action: 'Delete organization',
      run: () => {
        this.api.delete(PROJECT, ENTITY, row.id, row.revision).subscribe({
          next: () => {
            this.finishClose();
            this.refresh();
            this.feedback.set('Organization deleted. The deletion is pending export.');
          },
          error: (error) => this.report(error),
        });
      },
    });
  }
  reset(): void {
    this.confirmation.set({
      title: 'Reset demo data?',
      message:
        'This replaces all local Organizations and pending changes with the eight demonstration records. Other projects are not affected.',
      action: 'Reset demo data',
      run: () => {
        this.demo.reset().subscribe({
          next: () => {
            if (this.editorOpen()) this.finishClose();
            this.search.setValue('', { emitEvent: false });
            this.status.setValue('', { emitEvent: false });
            this.refresh(1);
            this.feedback.set('Demo data reset.');
          },
          error: (error) => this.report(error),
        });
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
    this.error.set(error instanceof Error ? error.message : 'The operation failed.');
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
    this.fields.forEach((node) => node.dispose());
  }
}
