/**
 * Screenshot capture harness — produces marketing/README screenshots from a
 * real Electron run. Not a test in the assertion sense; we use Playwright's
 * Electron driver to drive the same windows the user sees, then write them
 * to assets/screenshots/. Run with:
 *
 *   npx playwright test tests/e2e/screenshots.spec.ts
 *
 * Each capture launches against a fresh temp userData dir so the developer's
 * personal settings.json never appears in a shipped screenshot.
 */

import { test, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const APP_ROOT  = path.join(__dirname, '..', '..');
const OUT_DIR   = path.join(APP_ROOT, 'assets', 'screenshots');

let app: ElectronApplication;
let board: Page;
let userDataDir: string;

test.beforeAll(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-shot-'));

  // Pre-seed settings so the first-run onboarding overlay doesn't paint over
  // the screenshot. We're shooting the steady-state UI, not the welcome flow.
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ onboardingComplete: true, theme: 'dark', volume: 80 }, null, 2),
  );

  app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env:  { ...process.env, ELECTRON_IS_DEV: '0' },
    timeout: 30_000,
  });
  board = await app.firstWindow();
  await board.waitForLoadState('domcontentloaded');
  await board.waitForFunction(
    () => !document.querySelector('[data-key="q"]')?.classList.contains('empty'),
    null,
    { timeout: 10_000 },
  );
  // Webfonts need a beat to settle — IBM Plex Mono is loaded from Google Fonts
  // and an unsettled `document.fonts` state shows up as fallback Helvetica
  // mid-screenshot. `document.fonts.ready` is the load completion promise.
  await board.evaluate(() => document.fonts.ready);
});

test.afterAll(async () => {
  try { await app?.close(); } catch {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
});

test('capture board (default)', async () => {
  await board.bringToFront();
  await board.screenshot({ path: path.join(OUT_DIR, 'board-default.png'), type: 'png' });
});

test('capture board (lit)', async () => {
  // Light up Q + D so the keycap glow comes through in the marketing shot.
  await board.evaluate(() => {
    document.querySelector('[data-key="q"]')?.classList.add('lit');
    document.querySelector('[data-key="d"]')?.classList.add('lit');
  });
  await board.screenshot({ path: path.join(OUT_DIR, 'board-lit.png'), type: 'png' });
  // Restore for subsequent shots.
  await board.evaluate(() => {
    document.querySelector('[data-key="q"]')?.classList.remove('lit');
    document.querySelector('[data-key="d"]')?.classList.remove('lit');
  });
});

test('capture packs screen', async () => {
  const packsPromise = app.waitForEvent('window');
  await board.evaluate(() => window.electronAPI?.openPacks());
  const packs = await packsPromise;
  await packs.waitForLoadState('domcontentloaded');
  await packs.waitForFunction(() => document.querySelectorAll('.pack-row').length > 0);
  await packs.bringToFront();
  await packs.screenshot({ path: path.join(OUT_DIR, 'packs.png'), type: 'png' });
  await packs.close();
});

test('capture sound-manager screen', async () => {
  const childPromise = app.waitForEvent('window');
  await board.evaluate(() => window.electronAPI?.openAddSound());
  const child = await childPromise;
  await child.waitForLoadState('domcontentloaded');
  await child.evaluate(() => document.fonts.ready);
  // Give the renderer a moment to paint waveform placeholders / level meters
  await child.waitForTimeout(500);
  await child.bringToFront();
  await child.screenshot({ path: path.join(OUT_DIR, 'sound-manager.png'), type: 'png' });
  await child.close();
});

test('capture settings screen', async () => {
  const childPromise = app.waitForEvent('window');
  await board.evaluate(() => window.electronAPI?.openSettings());
  const child = await childPromise;
  await child.waitForLoadState('domcontentloaded');
  await child.evaluate(() => document.fonts.ready);
  await child.waitForTimeout(300);
  await child.bringToFront();
  await child.screenshot({ path: path.join(OUT_DIR, 'settings.png'), type: 'png' });
  await child.close();
});
