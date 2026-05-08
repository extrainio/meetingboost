/**
 * E2E smoke test for the YouTube Pack import tab.
 *
 * Covers the no-chapters routing path: paste a URL whose video has no chapter
 * metadata → the app surfaces an inline error directing the user to the
 * YouTube Clip tab.
 *
 * A chaptered-URL happy-path test will be added once a stable CC0 chaptered
 * video is identified.
 */

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Real CC0 audio with chapters is rare; this URL is the same one used by
// test_youtube_download.py — a 5-second public-domain clip with NO chapters.
// The smoke test covers the routing path: paste a URL that has no chapters →
// app surfaces an inline message routing the user to the YouTube Clip tab.
const TEST_URL = 'https://www.youtube.com/watch?v=aBr2kKAHN6M';

const APP_ROOT = path.join(__dirname, '..', '..');

let app: ElectronApplication;
let boardPage: Page;
let userDataDir: string;

test.beforeAll(async () => {
  // Isolated profile — keeps the developer's real userData untouched.
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-yt-e2e-'));

  app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_IS_DEV: '0' },
    timeout: 30_000,
  });

  boardPage = await app.firstWindow();
  await boardPage.waitForLoadState('domcontentloaded');
  // Wait for the board to finish rendering (same gate as pack-selection.spec.ts).
  await boardPage.waitForFunction(
    () => !document.querySelector('[data-key="q"]')?.classList.contains('empty'),
    null,
    { timeout: 10_000 },
  );
});

test.afterAll(async () => {
  try { await app?.close(); } catch { /* always clean up */ }
  if (userDataDir) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
});

test.describe('YouTube Pack import', () => {
  test('paste → detect (no chapters) routes to YouTube Clip', async () => {
    // yt-dlp network round-trip can take 30–60 s on a cold connection; raise
    // the per-test timeout well above the global 30 s default.
    test.setTimeout(120_000);
    // openAddSound sends 'open-add-sound' via IPC → main creates/reuses childWin
    // with sound-manager.html. Register the waitForEvent BEFORE triggering it
    // so we don't miss the event.
    const winPromise = app.waitForEvent('window');
    await boardPage.evaluate(() => (window as any).electronAPI.openAddSound());
    const soundManagerWin = await winPromise;

    await soundManagerWin.waitForLoadState('domcontentloaded');

    // Click the YouTube Pack tab
    await soundManagerWin.locator('.stab[data-src="ytpack"]').click();

    // Verify the tab switched (the pane is no longer hidden)
    await expect(soundManagerWin.locator('.src-pane[data-src="ytpack"]')).not.toBeHidden({ timeout: 2_000 });

    // Verify the IPC bridge is wired before clicking Detect
    const hasIpc = await soundManagerWin.evaluate(
      () => typeof (window as any).electronAPI?.ytDetectSnippets === 'function'
    );
    expect(hasIpc).toBe(true);

    // Paste URL and trigger detection
    await soundManagerWin.locator('#ytpUrl').fill(TEST_URL);
    await soundManagerWin.locator('#ytpDetectBtn').click();

    // The no-chapters branch populates #ytpPasteError and makes it visible.
    // Allow up to 60 s for the network round-trip to yt-dlp.
    await expect(soundManagerWin.locator('#ytpPasteError')).toBeVisible({ timeout: 60_000 });
    await expect(soundManagerWin.locator('#ytpPasteError')).toContainText(/no chapters/i);
  });

  // Additional happy-path test against a chaptered URL goes here once a
  // stable CC0 chaptered video is identified.
});
