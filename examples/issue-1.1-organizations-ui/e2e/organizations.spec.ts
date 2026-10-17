import { expect, test, type Page } from '@playwright/test';

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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});
test('complete CRUD, reload, leading zeroes, null/removal, and reset', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Reset demo data', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Reset demo data?' })
    .getByRole('button', { name: 'Reset demo data', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Aurora Aerospace', exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Organization', exact: true }).click();
  await expect(page.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'descending');
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
  const savedCode = await page.evaluate(() => {
    const snapshot = JSON.parse(
      localStorage.getItem('xsd-to-ir:organizations-ui:v1:aurora-demo:issue-1.1')!,
    );
    return snapshot.records.find(
      (record: { value: { name?: { descr: string } } }) =>
        record.value.name?.descr === 'Document Test',
    ).value.docs.doc[0].docRole.code;
  });
  expect(savedCode).toBe('DRW');
  await page.getByRole('searchbox').fill('Northstar');
  await page.getByRole('button', { name: 'Northstar Engineering', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete organization', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('reference');
});

test('handles corrupt storage and failed saves without claiming success', async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem('xsd-to-ir:organizations-ui:v1:aurora-demo:issue-1.1', '{broken'),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('has not been replaced');
  await page.getByRole('button', { name: 'Reset demo data', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Reset demo data?' })
    .getByRole('button', { name: 'Reset demo data', exact: true })
    .click();
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  await input(page, '/name/descr').fill('Failed save');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Full', 'QuotaExceededError');
    };
  });
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('alert')).toContainText('not saved');
  await expect(input(page, '/name/descr')).toHaveValue('Failed save');
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('renders responsive layouts and needs no API or CDN', async ({ page }, testInfo) => {
  const remote: string[] = [];
  const failures: string[] = [];
  page.on('request', (request) => {
    if (
      ['fetch', 'xhr'].includes(request.resourceType()) ||
      (!request.url().startsWith('http://127.0.0.1:4212/') && !request.url().startsWith('data:'))
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
  await page.getByRole('button', { name: 'Remove /orgId/2', exact: true }).click();
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
  const saved = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem('xsd-to-ir:organizations-ui:v1:aurora-demo:issue-1.1')!,
    ).records.find((row: { id: number }) => row.id === 1),
  );
  expect(saved.crud).toBe('U');
  expect(saved.value.name.applic).toEqual({ applicRef: { uidRef: 'applst2' } });
  expect(saved.value.orgId.map((id: { id: string }) => id.id)).toEqual(['001234', '000091']);
  expect(saved.value.docs.doc[0]).toEqual({
    docRef: { uidRef: 'doc1' },
    uid: 'docasg101',
    crud: 'R',
  });
  expect(saved.value.rmks.rmk[0].uid).toBe('rmk102');
  expect(saved.value.rmks.rmk[0].crud).toBe('U');
  expect(saved.value.rmks.rmk[0].text.providedBy).toEqual({ orgId: { id: '000042' } });
  await page.getByRole('button', { name: 'Aurora Aerospace', exact: true }).click();
  await page.getByRole('button', { name: 'Save organization' }).click();
  await expect(page.getByRole('status')).toContainText('No changes to save.');
});
