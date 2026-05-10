/**
 * e2e: BlackHole first-run walkthrough
 *
 * Stubs audio-detect-virtual-driver to return { found: false } so this test
 * runs in CI without a real virtual driver installed.
 *
 * Pattern follows tests/e2e/youtube-pack-import.spec.ts and the existing
 * Playwright+Electron setup in this repo.
 */
import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

let electronApp: ElectronApplication;
let page: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-bh-e2e-'));

  electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      ELECTRON_IS_DEV: '1',
      // Point userData to a clean temp dir so we start with a blank settings.json
      MB_USERDATA_OVERRIDE: userDataDir,
    },
  });

  page = await electronApp.firstWindow();

  // Stub the IPC handler: intercept before renderer calls it.
  // Override via ipcMain mock injected before board loads.
  await electronApp.evaluate(({ ipcMain }) => {
    // Remove the real handler and install a stub.
    ipcMain.removeHandler('audio-detect-virtual-driver');
    ipcMain.handle('audio-detect-virtual-driver', () => ({ found: false }));
  });

  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('walkthrough appears when no virtual driver detected', async () => {
  // The board should have triggered 'show-blackhole-walkthrough' via
  // 'did-finish-load'. We may need to wait a tick for the async detection.
  await expect(page.locator('#bhOverlay')).toHaveClass(/show/, { timeout: 4000 });
  await expect(page.locator('#bhH')).toContainText('Virtual audio cable required');
  await expect(page.locator('#bhNum')).toHaveText('Step 1 of 3');
});

test('Skip closes walkthrough and persists seen flag', async () => {
  await page.locator('#bhSkip').click();
  await expect(page.locator('#bhOverlay')).not.toHaveClass(/show/);

  // Read settings.json from the temp userDataDir
  const settingsPath = path.join(userDataDir, 'settings.json');
  // Give the async write a moment
  await page.waitForTimeout(200);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings['firstRun.blackholeWalkthroughSeen']).toBe(true);
});

test('walkthrough does not reappear after seen flag is set', async () => {
  // Reload the page (simulates relaunch with seen flag in settings)
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500); // let async detection run
  await expect(page.locator('#bhOverlay')).not.toHaveClass(/show/);
});
