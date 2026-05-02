/**
 * E2E tests for pack selection — validates the full IPC chain:
 * packs.html → IPC → main.ts → boardWin.webContents.send → board.html
 */

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';

const APP_ROOT = path.join(__dirname, '..', '..');

let app: ElectronApplication;
let boardPage: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [APP_ROOT],
    env: { ...process.env, ELECTRON_IS_DEV: '0' },
  });
  boardPage = await app.firstWindow();
  await boardPage.waitForLoadState('domcontentloaded');
  // Wait for packs.json to load and board to render
  await boardPage.waitForFunction(
    () => !document.querySelector('[data-key="q"]')?.classList.contains('empty'),
    { timeout: 5000 }
  );
});

test.afterAll(async () => {
  await app.close();
});

// ── Board initial state ─────────────────────────────────────────────────────

test('board loads Classics pack by default', async () => {
  const qLabel = await boardPage.$eval('[data-key="q"] .sb-name', el => el.textContent);
  expect(qLabel).toBe('Rimshot');

  const wLabel = await boardPage.$eval('[data-key="w"] .sb-name', el => el.textContent);
  expect(wLabel).toBe('Sad Trombone');
});

test('board has no empty tiles in row 1 for Classics', async () => {
  const empties = await boardPage.$$eval(
    '#row1 .sb.empty',
    els => els.length
  );
  expect(empties).toBe(0);
});

test('board shows pack name in header', async () => {
  const label = await boardPage.$eval('.board-lbl', el => el.textContent);
  expect(label).toBe('Classics');
});

// ── Pack screen renders correctly ───────────────────────────────────────────

test('packs screen loads and shows 3 official packs', async () => {
  // Open packs window
  await boardPage.evaluate(() => window.electronAPI?.openPacks());

  const packsPage = await app.waitForEvent('window');
  await packsPage.waitForLoadState('domcontentloaded');
  await packsPage.waitForFunction(() => document.querySelectorAll('.pack-row').length > 0);

  const packNames = await packsPage.$$eval(
    '.pack-row-name',
    els => els.map(e => e.textContent?.trim())
  );
  expect(packNames).toContain('Classics');
  expect(packNames).toContain('Corporate Warfare');
  expect(packNames).toContain('Hype Machine');

  // Store reference for next tests
  (test as any)._packsPage = packsPage;
});

test('packs screen shows active badge on current pack', async () => {
  const packsPage: Page = (test as any)._packsPage;
  if (!packsPage) test.skip();

  const activeBadge = await packsPage.$('.pack-badge.badge-active');
  expect(activeBadge).not.toBeNull();
  const badgeText = await activeBadge!.textContent();
  expect(badgeText?.trim()).toBe('Active');
});

test('selecting a pack updates preview title', async () => {
  const packsPage: Page = (test as any)._packsPage;
  if (!packsPage) test.skip();

  // Click Corporate Warfare row
  const rows = await packsPage.$$('.pack-row');
  for (const row of rows) {
    const name = await row.$eval('.pack-row-name', el => el.textContent);
    if (name?.includes('Corporate')) {
      await row.click();
      break;
    }
  }

  const title = await packsPage.$eval('#previewTitle', el => el.textContent);
  expect(title).toBe('Corporate Warfare');
});

test('preview grid shows correct sound labels for selected pack', async () => {
  const packsPage: Page = (test as any)._packsPage;
  if (!packsPage) test.skip();

  // Corporate pack should have "Synergy!" on Q
  const labels = await packsPage.$$eval(
    '.mini-key:not(.empty) .mini-name',
    els => els.map(e => e.textContent?.trim())
  );
  expect(labels).toContain('Synergy!');
  expect(labels).toContain('WRONG');
});

test('Load Pack button is enabled when a non-active pack is selected', async () => {
  const packsPage: Page = (test as any)._packsPage;
  if (!packsPage) test.skip();

  const btnText = await packsPage.$eval('#activateBtn', el => el.textContent?.trim());
  expect(btnText).toBe('Load Pack');

  const isActive = await packsPage.$eval(
    '#activateBtn', el => el.classList.contains('is-active')
  );
  expect(isActive).toBe(false);
});

// ── Pack activation updates the board ──────────────────────────────────────

test('clicking Load Pack switches the board to Corporate Warfare', async () => {
  const packsPage: Page = (test as any)._packsPage;
  if (!packsPage) test.skip();

  // Click Load Pack
  await packsPage.click('#activateBtn');

  // Board should update — wait for Q key to show "Synergy!"
  await boardPage.waitForFunction(
    () => document.querySelector('[data-key="q"] .sb-name')?.textContent === 'Synergy!',
    { timeout: 3000 }
  );

  const qLabel = await boardPage.$eval('[data-key="q"] .sb-name', el => el.textContent);
  expect(qLabel).toBe('Synergy!');
});

test('board header updates to Corporate Warfare after pack switch', async () => {
  const label = await boardPage.$eval('.board-lbl', el => el.textContent);
  expect(label).toBe('Corporate Warfare');
});

test('packs screen now shows Corporate Warfare as active', async () => {
  const packsPage: Page = (test as any)._packsPage;
  if (!packsPage) test.skip();

  // Re-click Corporate row to refresh state
  const rows = await packsPage.$$('.pack-row');
  for (const row of rows) {
    const name = await row.$eval('.pack-row-name', el => el.textContent);
    if (name?.includes('Corporate')) {
      await row.click();
      break;
    }
  }

  const btnText = await packsPage.$eval('#activateBtn', el => el.textContent?.trim());
  expect(btnText).toBe('✓ Active Pack');
});

// ── Switching back to Classics ──────────────────────────────────────────────

test('switching back to Classics restores board sounds', async () => {
  const packsPage: Page = (test as any)._packsPage;
  if (!packsPage) test.skip();

  const rows = await packsPage.$$('.pack-row');
  for (const row of rows) {
    const name = await row.$eval('.pack-row-name', el => el.textContent);
    if (name?.includes('Classics')) {
      await row.click();
      break;
    }
  }
  await packsPage.click('#activateBtn');

  await boardPage.waitForFunction(
    () => document.querySelector('[data-key="q"] .sb-name')?.textContent === 'Rimshot',
    { timeout: 3000 }
  );

  const qLabel = await boardPage.$eval('[data-key="q"] .sb-name', el => el.textContent);
  expect(qLabel).toBe('Rimshot');
});

// ── Keyboard fire works on the board ───────────────────────────────────────

test('pressing Q key triggers fired animation on board', async () => {
  await boardPage.keyboard.press('q');

  // Wait for the 'fired' class to appear
  const hasFired = await boardPage.waitForFunction(
    () => document.querySelector('[data-key="q"]')?.classList.contains('fired') ||
          document.querySelector('[data-key="q"]')?.classList.contains('lit'),
    { timeout: 1000 }
  ).then(() => true).catch(() => false);

  expect(hasFired).toBe(true);
});

test('session counter increments on key press', async () => {
  const before = await boardPage.$eval('#sc', el => parseInt(el.textContent || '0'));
  await boardPage.keyboard.press('w');
  const after = await boardPage.$eval('#sc', el => parseInt(el.textContent || '0'));
  expect(after).toBe(before + 1);
});
