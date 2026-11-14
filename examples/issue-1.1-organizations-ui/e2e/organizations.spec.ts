import type { Page } from '@playwright/test';
import { expect, test } from './backend.fixture';

const input = (page: Page, path: string) => page.locator(`[data-path="${path}"] > input`);
const presence = (page: Page, path: string) =>
  page.getByRole('combobox', { name: `${path} presence`, exact: true });
async function create(page: Page, name: string, id: string) {
  await page.getByRole('button', { name: 'New organization', exact: true }).click();
  await input(page, '/name/descr').fill(name);
  await page.getByRole('tab', { name: 'Identifiers' }).click();
  await input(page, '/orgId/0/id').fill(id);
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('status')).toContainText('saved');
}

test.beforeEach(async ({ page, backend }) => {
  void backend;
  await page.goto('/');
});
test('displays and filters the N unchanged status without rejecting catalog records', async ({
  page,
  backend,
}) => {
  backend.records[0].crud = 'N';
  backend.catalogs['externalDocument'][0].crud = 'N';
  await page.reload();
  await page.locator('#status-filter').selectOption('N');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr').first()).toContainText('Unchanged');
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit organization' })).toBeVisible();
});
test('complete HTTP CRUD, reload, leading zeroes, null/removal, and summaries', async ({
  page,
  backend,
}) => {
  await create(page, 'Atlas Test Organization', '000009');
  await page.getByRole('button', { name: 'Atlas Test Organization', exact: true }).click();
  await input(page, '/name/descr').fill('Atlas Edited');
  await page.getByRole('tab', { name: 'Identifiers' }).click();
  await expect(input(page, '/orgId/0/id')).toHaveValue('000009');
  await page.getByRole('tab', { name: 'Documents' }).click();
  await presence(page, '/docs').selectOption('null');
  await page.getByRole('button', { name: 'Save organization' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Atlas Edited', exact: true }).click();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(presence(page, '/docs')).toHaveValue('null');
  await presence(page, '/docs').selectOption('absent');
  await page.getByRole('button', { name: 'Save organization' }).click();
  await page.getByRole('button', { name: 'Atlas Edited', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete organization', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('deleted');
  await page.getByRole('searchbox', { name: 'Search organizations' }).fill('Atlas Edited');
  await expect(page.getByRole('heading', { name: 'No organizations found' })).toBeVisible();
  const saved = backend.records.find((row) => row.value.orgId[0].id === '000009')!;
  expect(saved.crud).toBe('D');
  expect(saved.value.docs).toBeUndefined();
  expect(backend.writes.map((call) => call.method)).toEqual(['POST', 'PUT', 'PUT', 'DELETE']);
  expect(backend.writes[1].body).toMatchObject({ orgId: [{ id: '000009' }], docs: null });
  expect(backend.writes[2].body).not.toHaveProperty('docs');
  await expect(page.locator('.stat-card').nth(0).locator('strong')).toHaveText('8');
  await expect(page.locator('.stat-card').nth(1).locator('strong')).toHaveText('1');
  await expect(page.locator('.stat-card').nth(1)).toContainText('1 deletion(s)');
  await expect(page.locator('.stat-card').nth(2).locator('strong')).toHaveText('3');
  await page.locator('#status-filter').selectOption('pending');
  await page.getByRole('searchbox').fill('');
  await expect(page.getByRole('heading', { name: 'No organizations found' })).toBeVisible();
});

test('disabled navigation, search, sorting, pagination, keyboard access, and discard guard', async ({
  page,
}) => {
  for (const name of [
    'Product and project',
    'Product structure',
    'Part definition',
    'Tasks and requirements',
    'Task resources',
  ]) {
    await expect(
      page.getByRole('button', { name: `${name} — not available in this example`, exact: true }),
    ).toBeDisabled();
  }
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.pagination')).toContainText('Page 2');
  await page.getByRole('button', { name: 'Last update', exact: true }).click();
  await expect(
    page.getByRole('columnheader', { name: 'Last update', exact: true }),
  ).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('searchbox').fill('000042');
  await expect(
    page.getByRole('button', { name: 'Northstar Engineering', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Northstar Engineering', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Edit organization' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close editor' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Save organization' })).toBeFocused();
  await page.getByRole('tab', { name: 'Details' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Identifiers' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Details' })).toBeFocused();
  await input(page, '/name/descr').fill('Unsaved test');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep working' }).click();
  await expect(input(page, '/name/descr')).toHaveValue('Unsaved test');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit organization' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Northstar Engineering', exact: true }).click();
  await expect(input(page, '/name/descr')).toHaveValue('Northstar Engineering');
});

test('validates identifiers, offers document choices, and protects referenced Organizations', async ({
  page,
  backend,
}) => {
  await page.getByRole('button', { name: 'New organization', exact: true }).click();
  await input(page, '/name/descr').fill('Document Test');
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.locator('.validation-summary')).toContainText('/orgId/0/id');
  await page.getByRole('tab', { name: 'Identifiers' }).click();
  await input(page, '/orgId/0/id').fill('000011');
  await page.getByRole('tab', { name: 'Documents' }).click();
  await presence(page, '/docs').selectOption('value');
  await page.locator('[data-path="/docs/doc"] > .field-heading .expand-field').click();
  await page.locator('[data-path="/docs/doc/0"] > .field-heading .expand-field').click();
  await presence(page, '/docs/doc/0/docRole').selectOption('value');
  await page
    .locator('#field--docs-doc-0-docRole-code')
    .selectOption({ label: 'Drawing reference (DRW)' });
  await page
    .locator('#field--docs-doc-0-choice-0')
    .selectOption({ label: 'Document issue reference' });
  await page.locator('[data-path="/docs/doc/0/docIssRef"] > .field-heading .expand-field').click();
  await page
    .locator('#field--docs-doc-0-docIssRef-lookup')
    .selectOption({ label: 'DOC-001 · Issue 02' });
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  const saved = backend.records.find((record) => record.value.name?.descr === 'Document Test')!;
  expect(saved.value.docs!.doc[0].docRole!.code).toBe('DRW');
  expect(saved.value.docs!.doc[0]).toMatchObject({
    uid: expect.stringMatching(/^docasg/),
    crud: 'I',
    docIssRef: { uidRef: 'dociss1' },
  });
  expect(backend.writes.at(-1)!.body).not.toHaveProperty('uid');
  expect((backend.writes.at(-1)!.body!['docs'] as { doc: unknown[] }).doc[0]).not.toHaveProperty(
    'uid',
  );
  await page.getByRole('searchbox').fill('Northstar');
  await page.getByRole('button', { name: 'Northstar Engineering', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete organization', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('reference');
});

test('keeps drafts after server errors, maps fields, and prevents overlapping writes', async ({
  page,
  backend,
}) => {
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  await input(page, '/name/descr').fill('Failed save');
  backend.failWrite = {
    status: 400,
    body: {
      error: 'invalid_request',
      message: 'Name is not permitted',
      details: { issues: [{ path: '/name/descr', message: 'Use the approved name.' }] },
    },
  };
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.locator('.validation-summary')).toContainText('/name/descr');
  await expect(input(page, '/name/descr')).toHaveValue('Failed save');
  await expect(page.getByRole('status')).toHaveCount(0);
  backend.failWrite = {
    status: 403,
    body: { error: 'forbidden', message: 'No update permission' },
  };
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('alert')).toContainText('403 · forbidden');
  await expect(input(page, '/name/descr')).toHaveValue('Failed save');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.hold = (call) => (call.method === 'PUT' ? pending : undefined);
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('button', { name: 'Save organization' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Close editor' })).toBeDisabled();
  await expect(input(page, '/name/descr')).toBeDisabled();
  expect(backend.writes).toHaveLength(3);
  release();
  await expect(page.getByRole('status')).toContainText('saved');
  expect(backend.writes.map((call) => call.method)).toEqual(['PUT', 'PUT', 'PUT']);
});

test('renders responsive layouts with only configured API and local assets', async ({
  page,
}, testInfo) => {
  const remote: string[] = [];
  const failures: string[] = [];
  page.on('request', (request) => {
    if (
      !request.url().startsWith('data:') &&
      (new URL(request.url()).origin !== 'http://127.0.0.1:4212' ||
        (['fetch', 'xhr'].includes(request.resourceType()) &&
          !new URL(request.url()).pathname.startsWith('/api/projects/contract-project/entities/') &&
          !new URL(request.url()).pathname.endsWith('/organizations.config.json')))
    )
      remote.push(request.url());
  });
  page.on('pageerror', (error) => failures.push(error.message));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Organizations', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('organizations.png'), fullPage: true });
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Edit organization' });
  await expect(drawer).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await drawer.boundingBox();
      return Math.abs(bounds!.x + bounds!.width - page.viewportSize()!.width);
    })
    .toBeLessThan(1);
  const box = await drawer.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeLessThanOrEqual(viewport.width + 1);
  if (testInfo.project.name === 'mobile')
    expect(Math.abs(box!.width - viewport.width)).toBeLessThan(2);
  await expect(page.getByRole('button', { name: 'Save organization' })).toBeInViewport();
  expect(Math.abs((await drawer.boundingBox())!.y)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('editor.png') });
  expect(remote).toEqual([]);
  expect(failures).toEqual([]);
});

test('edits applicability, repeated identifiers, and a nested natural Organization reference', async ({
  page,
  backend,
}) => {
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  await presence(page, '/name/applic').selectOption('value');
  await page
    .locator('#field--name-applic-choice-0')
    .selectOption({ label: 'Applicability reference' });
  await page.locator('[data-path="/name/applic/applicRef"] > .field-heading .expand-field').click();
  await page
    .locator('#field--name-applic-applicRef-lookup')
    .selectOption({ label: 'COLD-WEATHER · Cold weather configuration' });
  await page.getByRole('tab', { name: 'Identifiers' }).click();
  await page.getByRole('button', { name: 'Add identifiers', exact: true }).click();
  await input(page, '/orgId/2/id').fill('000091');
  await page.getByRole('button', { name: 'Move /orgId/2 up', exact: true }).click();
  await expect(input(page, '/orgId/1/id')).toHaveValue('000091');
  await expect(input(page, '/orgId/2/id')).toHaveValue('AURORA-DESIGN');
  await page.getByRole('button', { name: 'Remove /orgId/2', exact: true }).click();
  await expect(input(page, '/orgId/1/id')).toHaveValue('000091');
  await expect(input(page, '/orgId/2/id')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Remarks' }).click();
  for (const path of [
    '/rmks/rmk',
    '/rmks/rmk/0',
    '/rmks/rmk/0/text',
    '/rmks/rmk/0/text/providedBy',
  ]) {
    await page.locator(`[data-path="${path}"] > .field-heading .expand-field`).click();
  }
  await page.locator('#field--rmks-rmk-0-text-providedBy-choice-0').selectOption('1');
  await page
    .locator('[data-path="/rmks/rmk/0/text/providedBy/orgId"] > .field-heading .expand-field')
    .click();
  await input(page, '/rmks/rmk/0/text/providedBy/orgId/id').fill('000042');
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  const saved = backend.records.find((row) => row.id === '1')!;
  expect(saved.crud).toBe('U');
  expect(saved.value.name!.applic).toEqual({ applicRef: { uidRef: 'applst2' } });
  expect(saved.value.orgId.map((id: { id: string }) => id.id)).toEqual(['001234', '000091']);
  expect(saved.value.docs!.doc[0]).toEqual({
    docRef: { uidRef: 'doc1' },
    uid: 'docasg101',
    crud: 'R',
  });
  expect(saved.value.rmks!.rmk[0].uid).toBe('rmk102');
  expect(saved.value.rmks!.rmk[0].crud).toBe('U');
  expect(saved.value.rmks!.rmk[0].text.providedBy).toEqual({ orgId: { id: '000042' } });
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  const count = backend.writes.length;
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('status')).toContainText('No changes to save.');
  expect(backend.writes).toHaveLength(count);
});

test('blocks CRUD for invalid configuration and blocks editing for a mismatched schema', async ({
  page,
  backend,
}) => {
  await expect(page.getByRole('button', { name: 'Aurora Aerospace', exact: true })).toBeVisible();
  await expect
    .poll(
      () => backend.calls.filter((call) => call.url.searchParams.get('pageSize') === '100').length,
    )
    .toBe(4);
  backend.calls = [];
  backend.config = { ...(backend.config as object), projectId: '' };
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Set projectId');
  await expect(page.getByRole('button', { name: 'New organization', exact: true })).toBeDisabled();
  expect(backend.calls).toEqual([]);
  backend.config = {
    apiBasePath: '/api',
    projectId: 'contract-project',
    projectLabel: 'Contract test project',
    schemaIssue: '1.1',
  };
  backend.schemaIssue = '2.0';
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('does not report S3000L Issue 1.1');
  await expect(page.getByRole('button', { name: 'New organization', exact: true })).toBeDisabled();
  expect(backend.calls).toHaveLength(1);
});

test('keeps the newest search result after an earlier read finishes late', async ({
  page,
  backend,
}) => {
  await expect(page.getByRole('button', { name: 'Aurora Aerospace', exact: true })).toBeVisible();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.hold = (call) =>
    call.url.searchParams.get('filter.search') === 'Aurora' ? delayed : undefined;
  await page.getByRole('searchbox').fill('Aurora');
  await expect
    .poll(() =>
      backend.calls.some((call) => call.url.searchParams.get('filter.search') === 'Aurora'),
    )
    .toBe(true);
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: (request) => new URL(request.url()).searchParams.get('filter.search') === 'Aurora',
  });
  await page.getByRole('searchbox').fill('Northstar');
  await cancelled;
  await expect(
    page.getByRole('button', { name: 'Northstar Engineering', exact: true }),
  ).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Aurora Aerospace', exact: true })).toHaveCount(0);
  await expect(page.locator('.pagination')).toContainText('1 organization');
  backend.failList = {
    status: 503,
    body: { error: 'unavailable', message: 'Database temporarily unavailable' },
  };
  await page.getByRole('searchbox').fill('Boreal');
  await expect(page.getByRole('alert')).toContainText('Database temporarily unavailable');
  backend.failList = undefined;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Boreal Maintenance', exact: true })).toBeVisible();
});

test('loads every catalog page, reuses choices, and refreshes Organizations after writes', async ({
  page,
  backend,
}) => {
  const template = backend.catalogs['externalDocument'][0];
  backend.catalogs['externalDocument'] = Array.from({ length: 101 }, (_, i) => ({
    ...template,
    id: String(i + 1),
    uid: `doc${i + 1}`,
    value: {
      docId: [{ id: `DOC-${String(i + 1).padStart(3, '0')}` }],
      docTitle: { descr: 'Catalog entry' },
    },
  }));
  await page.reload();
  await expect
    .poll(() =>
      backend.calls.some(
        (call) =>
          call.url.pathname.endsWith('/externalDocument') &&
          call.url.searchParams.get('page') === '2',
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  await page.getByRole('tab', { name: 'Documents' }).click();
  for (const path of ['/docs/doc', '/docs/doc/0', '/docs/doc/0/docRef'])
    await page.locator(`[data-path="${path}"] > .field-heading .expand-field`).click();
  const options = page.locator('#field--docs-doc-0-docRef-lookup option');
  await expect(options).toHaveCount(102);
  await page
    .locator('#field--docs-doc-0-docRef-lookup')
    .selectOption({ label: 'DOC-101 · Catalog entry' });
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  expect(backend.records[0].value.docs!.doc[0].docRef).toEqual({ uidRef: 'doc101' });
  const prior = backend.calls.filter(
    (call) =>
      call.url.pathname.endsWith('/organization') &&
      call.url.searchParams.get('pageSize') === '100',
  ).length;
  await create(page, 'Catalog test partner', '000077');
  await expect
    .poll(
      () =>
        backend.calls.filter(
          (call) =>
            call.url.pathname.endsWith('/organization') &&
            call.url.searchParams.get('pageSize') === '100',
        ).length,
    )
    .toBeGreaterThan(prior);
});

test('shows project-status and constraint messages without losing the draft', async ({
  page,
  backend,
}) => {
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  await input(page, '/name/descr').fill('Keep this draft');
  backend.failWrite = {
    status: 409,
    body: {
      error: 'project_not_ready',
      message: 'Project is importing.',
      status: 'importing',
      constraint: 'project_state',
    },
  };
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('alert')).toContainText('Project status: importing');
  await expect(page.getByRole('alert')).toContainText('Constraint: project_state');
  await expect(input(page, '/name/descr')).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
});

test('sorts only scalar columns and sends CRUD filters before pagination', async ({
  page,
  backend,
}) => {
  await expect(page.getByRole('button', { name: 'Aurora Aerospace', exact: true })).toBeVisible();
  const lastUpdate = page.getByRole('columnheader', { name: 'Last update', exact: true });
  await expect(lastUpdate).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('tbody tr').first()).toContainText('Aurora Aerospace');
  const initialList = backend.calls.find((call) => call.url.searchParams.get('pageSize') === '6')!;
  expect(initialList.url.searchParams.get('sortBy')).toBe('_updatedAt');
  expect(initialList.url.searchParams.get('sortDirection')).toBe('desc');
  for (const name of ['Organization', 'Identifiers', 'Documents']) {
    const heading = page.getByRole('columnheader', { name, exact: true });
    await expect(heading.getByRole('button')).toHaveCount(0);
    await expect(heading).not.toHaveAttribute('aria-sort', /.+/);
  }
  for (const [label, field] of [
    ['Change status', 'crud'],
    ['Last update', '_updatedAt'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => backend.calls.at(-1)?.url.searchParams.get('sortBy')).toBe(field);
    await expect(
      page
        .getByRole('columnheader')
        .filter({ has: page.getByRole('button', { name: label, exact: true }) }),
    ).toHaveAttribute('aria-sort', 'ascending');
  }
  await page.locator('#status-filter').selectOption('U');
  await expect(page.getByRole('heading', { name: 'No organizations found' })).toBeVisible();
  expect(backend.calls.at(-1)!.url.searchParams.get('filter.status')).toBe('U');
  await page.locator('#status-filter').selectOption('R');
  await expect(page.locator('.pagination')).toContainText('8 organizations');
  await page.locator('#page-size').selectOption('12');
  await expect(page.locator('tbody tr')).toHaveCount(8);
  expect(backend.calls.at(-1)!.url.searchParams.get('pageSize')).toBe('12');
  expect(
    backend.calls
      .filter((call) => call.url.searchParams.has('sortBy'))
      .every((call) =>
        ['crud', '_updatedAt', 'uid'].includes(call.url.searchParams.get('sortBy')!),
      ),
  ).toBe(true);
});
