/**
 * E2E tests for pack selection — validates the full IPC chain:
 * packs.html → IPC → main.ts → boardWin.webContents.send → board.html
 *
 * Each test run launches the app against a fresh temp userData dir so a
 * polluted settings.json from a prior run can't leak in (e.g. an active
 * pack of "Classics (2)" left behind by an interrupted import test).
 */

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const APP_ROOT = path.join(__dirname, '..', '..');

let app: ElectronApplication;
let boardPage: Page;
let packsPage: Page;
let userDataDir: string;

test.beforeAll(async () => {
  // Isolated profile — Electron honours --user-data-dir, so the app reads
  // and writes settings.json/packs.json/recordings inside this temp tree
  // and we leave the developer's real ~/Library/.../MeetingBoost intact.
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-e2e-'));

  app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_IS_DEV: '0' },
    timeout: 30_000,
  });
  boardPage = await app.firstWindow();
  await boardPage.waitForLoadState('domcontentloaded');
  // Wait for packs.json to load and board to render.
  await boardPage.waitForFunction(
    () => !document.querySelector('[data-key="q"]')?.classList.contains('empty'),
    null,
    { timeout: 10_000 },
  );
});

test.afterAll(async () => {
  try { await app?.close(); } catch { /* ignore — we still want to clean up */ }
  if (userDataDir) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
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
    els => els.length,
  );
  expect(empties).toBe(0);
});

test('board shows pack name in header', async () => {
  const label = await boardPage.$eval('.board-lbl', el => el.textContent);
  expect(label).toBe('Classics');
});

// ── Pack screen renders correctly ───────────────────────────────────────────
//
// Tests below share `packsPage` — they're a single user flow (open packs,
// inspect, switch, switch back). Splitting the flow across `test()` blocks
// keeps the failure surface small while still respecting the natural
// ordering. Playwright runs them serially because workers=1 in the config.

test('packs screen loads and shows 3 official packs', async () => {
  await boardPage.evaluate(() => window.electronAPI?.openPacks());

  packsPage = await app.waitForEvent('window');
  await packsPage.waitForLoadState('domcontentloaded');
  await packsPage.waitForFunction(() => document.querySelectorAll('.pack-row').length > 0);

  const packNames = await packsPage.$$eval(
    '.pack-row-name',
    els => els.map(e => e.textContent?.trim()),
  );
  expect(packNames).toContain('Classics');
  expect(packNames).toContain('Corporate Warfare');
  expect(packNames).toContain('Hype Machine');
});

test('packs screen shows active badge on current pack', async () => {
  const activeBadge = await packsPage.$('.pack-badge.badge-active');
  expect(activeBadge).not.toBeNull();
  const badgeText = await activeBadge!.textContent();
  expect(badgeText?.trim()).toBe('Active');
});

test('selecting a pack updates preview title', async () => {
  await selectPackByName(packsPage, 'Corporate');

  const title = await packsPage.$eval('#previewTitle', el => el.textContent);
  expect(title).toBe('Corporate Warfare');
});

test('preview grid shows correct sound labels for selected pack', async () => {
  // Corporate pack should have "Synergy!" on Q
  const labels = await packsPage.$$eval(
    '.mini-key:not(.empty) .mini-name',
    els => els.map(e => e.textContent?.trim()),
  );
  expect(labels).toContain('Synergy!');
  expect(labels).toContain('WRONG');
});

test('Load Pack button is enabled when a non-active pack is selected', async () => {
  const btnText = await packsPage.$eval('#activateBtn', el => el.textContent?.trim());
  expect(btnText).toBe('Load Pack');

  const isActive = await packsPage.$eval(
    '#activateBtn', el => el.classList.contains('is-active'),
  );
  expect(isActive).toBe(false);
});

// ── Pack activation updates the board ──────────────────────────────────────

test('clicking Load Pack switches the board to Corporate Warfare', async () => {
  await packsPage.click('#activateBtn');

  await boardPage.waitForFunction(
    () => document.querySelector('[data-key="q"] .sb-name')?.textContent === 'Synergy!',
    null,
    { timeout: 5_000 },
  );

  const qLabel = await boardPage.$eval('[data-key="q"] .sb-name', el => el.textContent);
  expect(qLabel).toBe('Synergy!');
});

test('board header updates to Corporate Warfare after pack switch', async () => {
  await boardPage.waitForFunction(
    () => document.querySelector('.board-lbl')?.textContent === 'Corporate Warfare',
    null,
    { timeout: 2_000 },
  );
  const label = await boardPage.$eval('.board-lbl', el => el.textContent);
  expect(label).toBe('Corporate Warfare');
});

test('packs screen now shows Corporate Warfare as active', async () => {
  await selectPackByName(packsPage, 'Corporate');

  // The renderer rebinds the button text after the active-pack IPC round-trip.
  // Wait for it rather than reading on the next tick.
  await packsPage.waitForFunction(
    () => document.querySelector('#activateBtn')?.textContent?.trim() === '✓ Active Pack',
    null,
    { timeout: 2_000 },
  );
});

// ── Switching back to Classics ──────────────────────────────────────────────

test('switching back to Classics restores board sounds', async () => {
  await selectPackByName(packsPage, 'Classics');
  await packsPage.click('#activateBtn');

  await boardPage.waitForFunction(
    () => document.querySelector('[data-key="q"] .sb-name')?.textContent === 'Rimshot',
    null,
    { timeout: 5_000 },
  );

  const qLabel = await boardPage.$eval('[data-key="q"] .sb-name', el => el.textContent);
  expect(qLabel).toBe('Rimshot');
});

// ── Keyboard fire works on the board ───────────────────────────────────────

test('pressing Q key triggers fired animation on board', async () => {
  await boardPage.bringToFront();
  await boardPage.keyboard.press('q');

  // Wait for the 'fired' or 'lit' class to appear.
  const hasFired = await boardPage.waitForFunction(
    () => document.querySelector('[data-key="q"]')?.classList.contains('fired') ||
          document.querySelector('[data-key="q"]')?.classList.contains('lit'),
    null,
    { timeout: 2_000 },
  ).then(() => true).catch(() => false);

  expect(hasFired).toBe(true);
});

test('session counter increments on key press', async () => {
  await boardPage.bringToFront();
  const before = await boardPage.$eval('#sc', el => parseInt(el.textContent || '0'));
  await boardPage.keyboard.press('w');

  await boardPage.waitForFunction(
    (prev) => parseInt(document.querySelector('#sc')?.textContent || '0') > prev,
    before,
    { timeout: 2_000 },
  );
  const after = await boardPage.$eval('#sc', el => parseInt(el.textContent || '0'));
  expect(after).toBe(before + 1);
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function selectPackByName(page: Page, namePart: string): Promise<void> {
  const rows = await page.$$('.pack-row');
  for (const row of rows) {
    const name = await row.$eval('.pack-row-name', el => el.textContent);
    if (name?.includes(namePart)) {
      await row.click();
      return;
    }
  }
  throw new Error(`Pack row matching "${namePart}" not found`);
}
