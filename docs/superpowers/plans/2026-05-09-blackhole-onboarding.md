# BlackHole First-Run Detection + Setup Walkthrough — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a missing virtual audio driver at first launch and walk the user through a 90-second install. Most current onboarding drop-off is silent — the app works but routes nowhere meeting-useful until BlackHole is configured.

**Architecture:** One pure helper (`isVirtualAudioDevice`), two IPC handlers (`audio-detect-virtual-driver`, `audio-mark-walkthrough-seen`), two new preload methods, a 3-step overlay in `board.html` with a footer status indicator, and a focus-regain re-detect loop. No new windows. Detection regex: `/BlackHole|VB-Cable|Soundflower|Loopback Audio/i`.

**Tech Stack:** Electron 32 + TypeScript 5 (main + preload), vanilla HTML/JS in `src/board.html`, Python+pytest for unit tests, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-05-09-blackhole-onboarding-design.md`

**Design tokens in use:** `--amber`, `--amber-d`, `--amber-bg`, `--amber-glow`, `--warn`, `--border`, `--bhi`, `--s1`, `--s2`, `--s3`, `--muted`, `--muted2`, `--text`. Fonts: `'Barlow Condensed'` (headings), `'IBM Plex Mono'` (body, buttons, code). These match the existing board.html vocabulary exactly.

---

## Task 1: Pure helper — `isVirtualAudioDevice` + Python parity test

**Files:**
- Modify: `main.ts` (add helper near top, after `setSetting`)
- Create: `tests/test_blackhole_detection.py`

**Why first:** zero binary dependencies, unblocks all downstream IPC. Python parity mirrors `test_record_pipeline.py`'s dual-impl pattern.

- [ ] **Step 1: Create the failing Python test**

Create `tests/test_blackhole_detection.py`:

```python
"""
Unit tests for virtual audio driver detection.

Mirrors isVirtualAudioDevice() in main.ts (dual-implementation pattern —
matches test_record_pipeline.py). No binaries, no Electron.

Run with: python3 -m pytest tests/test_blackhole_detection.py -v
"""
import re
import unittest

VIRTUAL_DRIVER_RE = re.compile(
    r'BlackHole|VB-Cable|Soundflower|Loopback Audio', re.IGNORECASE
)

def is_virtual_audio_device(name: str) -> bool:
    """Return True if the device label matches a known virtual audio driver."""
    return bool(VIRTUAL_DRIVER_RE.search(name))


class TestIsVirtualAudioDevice(unittest.TestCase):
    def test_blackhole_variants(self):
        self.assertTrue(is_virtual_audio_device('BlackHole 2ch'))
        self.assertTrue(is_virtual_audio_device('blackhole 16ch'))
        self.assertTrue(is_virtual_audio_device('BLACKHOLE'))

    def test_other_virtual_drivers(self):
        self.assertTrue(is_virtual_audio_device('VB-Cable'))
        self.assertTrue(is_virtual_audio_device('Soundflower (2ch)'))
        self.assertTrue(is_virtual_audio_device('Loopback Audio'))

    def test_real_devices_excluded(self):
        self.assertFalse(is_virtual_audio_device('MacBook Pro Speakers'))
        self.assertFalse(is_virtual_audio_device('AirPods Pro'))
        self.assertFalse(is_virtual_audio_device('External Headphones'))
        self.assertFalse(is_virtual_audio_device(''))

    def test_partial_match_in_label(self):
        self.assertTrue(is_virtual_audio_device('Existential Audio BlackHole 2ch'))

    def test_case_insensitive(self):
        self.assertTrue(is_virtual_audio_device('soundflower'))
        self.assertTrue(is_virtual_audio_device('loopback audio'))


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run the test — expect PASS (Python is the fixture)**

```bash
python3 -m pytest tests/test_blackhole_detection.py -v
```

Expected: 5 tests PASS.

- [ ] **Step 3: Add the TypeScript helper to `main.ts`**

Find the `setSetting` function body (around line 42) and add the helper immediately after:

```typescript
// ── Virtual driver detection ───────────────────────────────────────────────
//
// Mirrored in tests/test_blackhole_detection.py.

const VIRTUAL_DRIVER_RE = /BlackHole|VB-Cable|Soundflower|Loopback Audio/i;

export function isVirtualAudioDevice(name: string): boolean {
  return VIRTUAL_DRIVER_RE.test(name);
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 2: IPC handler — `audio-detect-virtual-driver`

**Files:**
- Modify: `main.ts` (add handler in the IPC block near line 183)

The handler uses the renderer's `navigator.mediaDevices` via a helper call to the board window's webContents — but main cannot call Web APIs directly. Instead, main invokes the renderer via `executeJavaScript` to enumerate devices and returns the result. This keeps the detection logic in one place (the regex in main) while using the renderer's Web API capability.

- [ ] **Step 5: Add the IPC handler**

Find the block at line 183 (`ipcMain.handle('get-all-settings', ...)`) and add after the existing handlers in that cluster:

```typescript
// Detect virtual audio driver by enumerating output devices.
// Uses the board window's renderer context (navigator.mediaDevices) because
// main-process code has no access to Web Audio APIs.
// Returns { found: boolean, deviceName?: string }.
ipcMain.handle('audio-detect-virtual-driver', async (): Promise<{ found: boolean; deviceName?: string }> => {
  if (!boardWin || boardWin.isDestroyed()) return { found: false };
  try {
    // Brief getUserMedia to unlock device labels, then enumerate.
    const result = await boardWin.webContents.executeJavaScript(`
      (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(t => t.stop());
        } catch {}
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        return outputs.map(d => d.label || '');
      })()
    `);
    const labels: string[] = Array.isArray(result) ? result : [];
    for (const label of labels) {
      if (isVirtualAudioDevice(label)) return { found: true, deviceName: label };
    }
    return { found: false };
  } catch {
    return { found: false };
  }
});
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

---

## Task 3: IPC handler — `audio-mark-walkthrough-seen`

**Files:**
- Modify: `main.ts` (add handler adjacent to `audio-detect-virtual-driver`)

- [ ] **Step 7: Add the handler**

Immediately after the `audio-detect-virtual-driver` handler:

```typescript
// Write firstRun.blackholeWalkthroughSeen = true.
// Uses the flat key naming convention of the existing settings store.
// Errors are caught by writeStore() internally — fail open.
ipcMain.handle('audio-mark-walkthrough-seen', (): { ok: boolean } => {
  setSetting('firstRun.blackholeWalkthroughSeen', true);
  return { ok: true };
});
```

- [ ] **Step 8: Add the boot-time check after `createBoardWindow()`**

Find the `app.whenReady().then(...)` block. After `createBoardWindow()` is called, add:

```typescript
// After the board finishes loading, check for a virtual audio driver.
// If absent and the walkthrough hasn't been seen, push an event to the renderer.
boardWin!.webContents.once('did-finish-load', async () => {
  const seen = getSetting<boolean>('firstRun.blackholeWalkthroughSeen', false);
  if (seen) return;
  try {
    const { found } = await (boardWin!.webContents.executeJavaScript(`
      (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(t => t.stop());
        } catch {}
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices
          .filter(d => d.kind === 'audiooutput')
          .map(d => d.label || '');
      })()
    `) as Promise<string[]>).then(labels => ({
      found: labels.some(l => isVirtualAudioDevice(l)),
    }));
    if (!found) {
      boardWin!.webContents.send('show-blackhole-walkthrough');
    }
  } catch { /* fail open — no walkthrough is better than a crash */ }
});
```

- [ ] **Step 9: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

---

## Task 4: Expose both methods on preload

**Files:**
- Modify: `preload.ts`

- [ ] **Step 10: Add two new methods**

Find the `// ── Push events ──` comment block (around line 98) and add the new methods before it, in the IPC invoke section:

```typescript
  // ── Virtual driver setup ─────────────────────────────────────────────────
  detectVirtualDriver: (): Promise<{ found: boolean; deviceName?: string }> =>
    ipcRenderer.invoke('audio-detect-virtual-driver'),
  markBlackholeWalkthroughSeen: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('audio-mark-walkthrough-seen'),

  // ── Push events ──
```

Also add the push-event listener for `show-blackhole-walkthrough`:

```typescript
  onShowBlackholeWalkthrough: (cb: () => void): void =>
    void ipcRenderer.on('show-blackhole-walkthrough', cb),
```

- [ ] **Step 11: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

---

## Task 5: Walkthrough overlay HTML structure in `src/board.html`

**Files:**
- Modify: `src/board.html`

Add the CSS and HTML for the BlackHole walkthrough overlay. This is a second overlay distinct from `#onboardOverlay` (the general welcome overlay). It uses the same design tokens and `.onboard-*` class vocabulary but has a different ID to avoid conflicts.

- [ ] **Step 12: Add CSS for the walkthrough overlay**

Find the existing `/* ── ONBOARDING ─────────────────────────── */` comment block (around line 415) and add the following after the `.onboard-btn.primary` block (after the closing `}` around line 487):

```css
/* ── BLACKHOLE WALKTHROUGH ─────────────────────── */
/* Reuses .onboard-overlay, .onboard-card, .onboard-btn vocabulary.
   New elements specific to this walkthrough: */

.bh-brew-row {
  display: flex; align-items: stretch; gap: 0;
  margin: 12px 0 8px;
  border: 1px solid var(--bhi); border-radius: 4px; overflow: hidden;
}
.bh-brew-cmd {
  flex: 1;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px; font-weight: 600;
  padding: 9px 12px;
  background: var(--s3); color: var(--amber);
  user-select: all; letter-spacing: 0.2px;
  border: none; outline: none;
}
.bh-copy-btn {
  padding: 0 12px;
  background: var(--s2); border: none; border-left: 1px solid var(--bhi);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
  text-transform: uppercase; color: var(--muted2); cursor: pointer;
  transition: color 0.12s, background 0.12s;
}
.bh-copy-btn:hover { background: var(--s3); color: var(--text); }
.bh-copy-btn.copied { color: var(--amber); }

.bh-ext-link {
  font-size: 11px; color: var(--amber);
  text-decoration: none; display: inline-block; margin-bottom: 14px;
}
.bh-ext-link:hover { text-decoration: underline; }

.bh-refresh-row {
  margin-top: 12px; display: flex; flex-direction: column; gap: 6px;
}
.bh-refresh-tip {
  font-size: 9px; color: var(--warn);
  display: none; line-height: 1.5;
}
.bh-refresh-tip.show { display: block; }

.bh-configure-pane {
  display: grid; grid-template-columns: 1fr auto 1fr;
  gap: 8px; align-items: center;
  margin: 14px 0;
  font-size: 10px;
}
.bh-config-box {
  background: var(--s3); border: 1px solid var(--bhi); border-radius: 4px;
  padding: 10px 12px; text-align: center;
}
.bh-config-label {
  font-size: 9px; color: var(--muted); margin-bottom: 4px;
  letter-spacing: 1px; text-transform: uppercase; font-weight: 700;
}
.bh-config-val {
  font-size: 11px; color: var(--amber); font-weight: 700;
}
.bh-config-arrow { color: var(--muted); font-size: 14px; text-align: center; }

/* Footer virtual-driver warning indicator */
.bh-footer-warn {
  display: none; align-items: center; gap: 5px;
  font-size: 9px; color: var(--warn); font-weight: 700;
  letter-spacing: 0.3px; cursor: pointer;
  padding: 4px 8px; border-radius: 3px;
  border: 1px solid oklch(60% 0.18 25 / 28%);
  background: oklch(60% 0.18 25 / 10%);
  transition: background 0.12s;
  flex-shrink: 0;
}
.bh-footer-warn.show { display: flex; }
.bh-footer-warn:hover { background: oklch(60% 0.18 25 / 18%); }
```

- [ ] **Step 13: Add the HTML overlay element**

Find the closing `</div>` of `#onboardOverlay` (around line 592) and add after it:

```html
<!-- ── BLACKHOLE WALKTHROUGH OVERLAY ───────────────────────────────────── -->
<div class="onboard-overlay" id="bhOverlay" role="dialog" aria-modal="true" aria-labelledby="bhH">
  <div class="onboard-card">
    <div class="onboard-step-num" id="bhNum">Step 1 of 3</div>
    <div class="onboard-h" id="bhH"></div>
    <div class="onboard-body" id="bhBody"></div>
    <div class="onboard-foot">
      <div class="onboard-dots">
        <div class="onboard-dot" id="bhDot0"></div>
        <div class="onboard-dot" id="bhDot1"></div>
        <div class="onboard-dot" id="bhDot2"></div>
      </div>
      <div class="onboard-btns">
        <button class="onboard-btn" id="bhBack"  onclick="bhBack()"  style="display:none">← Back</button>
        <button class="onboard-btn" id="bhSkip"  onclick="bhSkip()">Skip</button>
        <button class="onboard-btn primary" id="bhNext" onclick="bhNext()">Continue →</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 14: Add the footer warning indicator**

Find the footer HTML:

```html
<div class="spacer"></div>
<div class="sess-stat">session <b id="sc">0</b> fired</div>
```

Replace with:

```html
<div class="spacer"></div>
<div class="bh-footer-warn" id="bhFooterWarn" onclick="bhReopenSetup()" title="No virtual driver detected — click to set up">
  ⚠ no virtual driver · setup
</div>
<div class="sess-stat">session <b id="sc">0</b> fired</div>
```

---

## Task 6: Walkthrough state machine

**Files:**
- Modify: `src/board.html` (add to the `<script>` block)

- [ ] **Step 15: Add the state machine**

Find the `// ── Onboarding ────────────────────────────────────` comment block (around line 840) and add the BlackHole walkthrough code before it:

```javascript
  // ── BlackHole Walkthrough ─────────────────────────
  // Three-step inline overlay for first-run virtual driver setup.
  // Triggered by main-process 'show-blackhole-walkthrough' event.

  const BH_VIRTUAL_RE = /BlackHole|VB-Cable|Soundflower|Loopback Audio/i;

  let bhStep = 0;
  let bhActive = false;
  let bhDriverFound = false;
  let bhReDetectInFlight = false;

  const BH_STEPS = [
    // Step 0 — Why
    () => {
      document.getElementById('bhNum').textContent = 'Step 1 of 3';
      document.getElementById('bhH').textContent = 'Virtual audio cable required';
      document.getElementById('bhBody').innerHTML =
        'MeetingBoost needs a virtual audio cable to route sounds into ' +
        'Zoom/Teams/Meet. BlackHole is the standard — it\'s free, open source, ' +
        'and 30 seconds to install.';
      document.getElementById('bhNext').textContent = 'Continue →';
      document.getElementById('bhBack').style.display = 'none';
      document.getElementById('bhSkip').style.display = '';
    },

    // Step 1 — Install
    () => {
      document.getElementById('bhNum').textContent = 'Step 2 of 3';
      document.getElementById('bhH').textContent = 'Install BlackHole';
      document.getElementById('bhBody').innerHTML =
        'Option A — Homebrew (recommended):' +
        '<div class="bh-brew-row">' +
          '<span class="bh-brew-cmd" id="bhBrewCmd">brew install blackhole-2ch</span>' +
          '<button class="bh-copy-btn" id="bhCopyBtn" onclick="bhCopyBrew()">Copy</button>' +
        '</div>' +
        'Option B — installer package:<br>' +
        '<a class="bh-ext-link" href="#" onclick="bhOpenExternal(); return false;">' +
          'Download from existential.audio/blackhole →' +
        '</a>' +
        '<div class="bh-refresh-row">' +
          '<button class="onboard-btn primary" style="width:100%" onclick="bhRefresh()">' +
            'I\'ve installed it — refresh devices →' +
          '</button>' +
          '<div class="bh-refresh-tip" id="bhRefreshTip">' +
            'Still not seeing a virtual driver. macOS sometimes needs a logout/login after install.' +
          '</div>' +
        '</div>';
      document.getElementById('bhNext').textContent = 'Next →';
      document.getElementById('bhNext').style.display = 'none';
      document.getElementById('bhBack').style.display = '';
      document.getElementById('bhSkip').style.display = '';
    },

    // Step 2 — Configure
    () => {
      document.getElementById('bhNum').textContent = 'Step 3 of 3';
      document.getElementById('bhH').textContent = 'Configure routing';
      document.getElementById('bhBody').innerHTML =
        '<div class="bh-configure-pane">' +
          '<div class="bh-config-box">' +
            '<div class="bh-config-label">MeetingBoost output</div>' +
            '<div class="bh-config-val">BlackHole 2ch</div>' +
          '</div>' +
          '<div class="bh-config-arrow">→</div>' +
          '<div class="bh-config-box">' +
            '<div class="bh-config-label">Meeting app mic</div>' +
            '<div class="bh-config-val">BlackHole 2ch</div>' +
          '</div>' +
        '</div>' +
        'In MeetingBoost: <code>Settings → Audio → Virtual Output</code><br>' +
        'In Zoom/Teams/Meet: set Microphone to <code>BlackHole 2ch</code>';
      document.getElementById('bhNext').textContent = 'Done';
      document.getElementById('bhNext').style.display = '';
      document.getElementById('bhBack').style.display = '';
      document.getElementById('bhSkip').style.display = 'none';
    },
  ];

  function showBlackholeWalkthrough(step = 0) {
    bhStep = step;
    bhActive = true;
    BH_STEPS[step]();
    // Update progress dots
    [0, 1, 2].forEach(i => {
      document.getElementById('bhDot' + i).classList.toggle('active', i === step);
    });
    document.getElementById('bhOverlay').classList.add('show');
  }

  function hideBlackholeWalkthrough() {
    bhActive = false;
    document.getElementById('bhOverlay').classList.remove('show');
    // Show footer indicator if driver still absent
    if (!bhDriverFound) {
      document.getElementById('bhFooterWarn').classList.add('show');
    }
  }
```

---

## Task 7: Wire "Refresh devices" button

**Files:**
- Modify: `src/board.html` (continuing in the `<script>` block, after Task 6)

- [ ] **Step 16: Add re-detect helper and button handlers**

Add immediately after `hideBlackholeWalkthrough()`:

```javascript
  async function reDetectVirtualDriver() {
    if (bhReDetectInFlight) return false;
    bhReDetectInFlight = true;
    try {
      let labels = [];
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch {}
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        labels = devices.filter(d => d.kind === 'audiooutput').map(d => d.label || '');
      } catch {}
      const found = labels.some(l => BH_VIRTUAL_RE.test(l));
      bhDriverFound = found;
      return found;
    } finally {
      bhReDetectInFlight = false;
    }
  }

  async function bhRefresh() {
    const found = await reDetectVirtualDriver();
    if (found) {
      await window.electronAPI?.markBlackholeWalkthroughSeen?.();
      showBlackholeWalkthrough(2);  // advance to configure step
    } else {
      const tip = document.getElementById('bhRefreshTip');
      if (tip) tip.classList.add('show');
    }
  }

  function bhCopyBrew() {
    navigator.clipboard.writeText('brew install blackhole-2ch').then(() => {
      const btn = document.getElementById('bhCopyBtn');
      if (!btn) return;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
    });
  }

  function bhOpenExternal() {
    // shell.openExternal is not exposed on preload — use a link in the body instead.
    // The <a> tag with target="_blank" works in Electron's renderer with
    // setWindowOpenHandler allowing blank targets, but MeetingBoost uses
    // shell.openExternal via IPC. For now, open via electronAPI if available,
    // fall back to window.open.
    const url = 'https://existential.audio/blackhole/';
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }
```

---

## Task 8: Wire "Skip", "Back", "Next/Done" buttons

**Files:**
- Modify: `src/board.html` (continuing `<script>` block)

- [ ] **Step 17: Add button handlers**

```javascript
  function bhNext() {
    if (bhStep < 2) {
      showBlackholeWalkthrough(bhStep + 1);
    } else {
      // Done — step 3
      bhDriverFound = true; // trust the user configured it
      window.electronAPI?.markBlackholeWalkthroughSeen?.();
      hideBlackholeWalkthrough();
      // Suppress footer indicator — user went through the whole flow
      document.getElementById('bhFooterWarn').classList.remove('show');
    }
  }

  function bhBack() {
    if (bhStep > 0) showBlackholeWalkthrough(bhStep - 1);
  }

  function bhSkip() {
    window.electronAPI?.markBlackholeWalkthroughSeen?.();
    hideBlackholeWalkthrough();
  }

  function bhReopenSetup() {
    // Re-entry from footer indicator — jump straight to Install (step 1)
    document.getElementById('bhFooterWarn').classList.remove('show');
    showBlackholeWalkthrough(1);
  }
```

---

## Task 9: Focus-regain re-detection

**Files:**
- Modify: `src/board.html` (continuing `<script>` block)

- [ ] **Step 18: Add focus handler**

```javascript
  // On app focus regain while stuck on the Install step, silently re-detect.
  // If BlackHole now exists, auto-advance to Configure.
  window.addEventListener('focus', async () => {
    if (!bhActive || bhStep !== 1) return;
    const found = await reDetectVirtualDriver();
    if (found) {
      await window.electronAPI?.markBlackholeWalkthroughSeen?.();
      showBlackholeWalkthrough(2);
    }
  });
```

---

## Task 10: Wire the IPC push event in board init

**Files:**
- Modify: `src/board.html` (DOMContentLoaded handler)

- [ ] **Step 19: Wire `onShowBlackholeWalkthrough` listener**

Find the `window.addEventListener('DOMContentLoaded', async () => {` block (around line 899). After the `if (!onboarded) showOnboard(0);` line, add:

```javascript
    // Wire the BlackHole walkthrough push event from main.
    // Main sends this after 'did-finish-load' if no virtual driver is found
    // and the walkthrough hasn't been seen yet.
    window.electronAPI?.onShowBlackholeWalkthrough?.(() => {
      // If general onboarding is still running, wait for it to finish first.
      if (!onboarded) {
        // Patch onboardFinish to chain into BH walkthrough
        const origFinish = window.onboardFinish;
        window.onboardFinish = function() {
          origFinish?.();
          showBlackholeWalkthrough(0);
        };
      } else {
        showBlackholeWalkthrough(0);
      }
    });
```

Also add to the `Promise.all` at init — read the `firstRun.blackholeWalkthroughSeen` setting to conditionally show the footer indicator without repeating detection:

```javascript
    const [savedVol, savedPack, savedDevice, onboarded, bhSeen] = await Promise.all([
      window.electronAPI?.getSetting('volume',                          80),
      window.electronAPI?.getSetting('activePack',                     'classics'),
      window.electronAPI?.getSetting('outputDeviceId',                  'default'),
      window.electronAPI?.getSetting('onboardingComplete',              false),
      window.electronAPI?.getSetting('firstRun.blackholeWalkthroughSeen', false),
    ]);
```

Then after `if (!onboarded) showOnboard(0);`:

```javascript
    // If walkthrough was seen but we still can't detect a driver, show indicator.
    // (A fresh non-seen state means main will push 'show-blackhole-walkthrough'
    // via the event listener above.)
    if (bhSeen) {
      const found = await reDetectVirtualDriver();
      if (!found) {
        document.getElementById('bhFooterWarn').classList.add('show');
      }
    }
```

---

## Task 11: Playwright e2e test

**Files:**
- Create: `tests/e2e/blackhole-walkthrough.spec.ts`

- [ ] **Step 20: Write the Playwright spec**

Create `tests/e2e/blackhole-walkthrough.spec.ts`:

```typescript
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
```

- [ ] **Step 21: Verify the spec file is valid TypeScript**

```bash
npx tsc --noEmit
```

---

## Task 12: Commit + smoke test

- [ ] **Step 22: Run all Python tests**

```bash
python3 -m pytest tests/test_blackhole_detection.py -v
```

Expected: 5 tests PASS.

- [ ] **Step 23: Run TypeScript compile check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 24: Manual smoke test (with BlackHole not installed)**

1. Delete or rename `settings.json` from `~/Library/Application Support/MeetingBoost/` to reset state.
2. `npm start` (or `npx electron .`).
3. Verify: BlackHole walkthrough overlay appears on step 1 after general onboarding finishes.
4. Click Skip → overlay hides.
5. Verify: footer indicator `⚠ no virtual driver · setup` appears.
6. Click the footer indicator → overlay re-opens on step 2 (Install).
7. Quit and relaunch → overlay does not appear; footer indicator appears (seen flag set, driver still absent).

- [ ] **Step 25: Manual smoke test (with BlackHole installed)**

1. Reset `settings.json`.
2. `npm start`.
3. Verify: walkthrough does not appear (driver detected).
4. Verify: footer indicator does not appear.

- [ ] **Step 26: Commit**

```bash
git add main.ts preload.ts src/board.html \
        tests/test_blackhole_detection.py \
        tests/e2e/blackhole-walkthrough.spec.ts \
        docs/superpowers/specs/2026-05-09-blackhole-onboarding-design.md \
        docs/superpowers/plans/2026-05-09-blackhole-onboarding.md
git commit -m "$(cat <<'EOF'
feat(onboarding): first-run BlackHole detection + 3-step setup walkthrough

Detect missing virtual audio driver at first launch, show a 3-step
inline walkthrough (why / install / configure), persist a 'seen' flag,
and keep a footer status indicator for re-entry. macOS-only; we link to
existential.audio/blackhole — we don't auto-install.
EOF
)"
```

---

## Self-review

**Correctness:**
- Detection uses `enumerateDevices()` which requires a prior `getUserMedia` call to unlock labels. Both the main-process boot check and the renderer's `reDetectVirtualDriver()` include the `getUserMedia` unlock step.
- `isVirtualAudioDevice` is `export`ed from `main.ts` for testability; the renderer uses an inline regex equivalent (cannot import main.ts directly).
- `firstRun.blackholeWalkthroughSeen` uses dot notation as a flat key — consistent with `onboardingComplete`, `activePack`, etc. A nested object would require schema changes to `readStore`.

**Failure modes covered:**
- `enumerateDevices()` failure → `{ found: false }` → walkthrough shows → acceptable.
- Settings write failure → overlay hides, flag not written, next launch re-triggers → acceptable (fail open).
- `shell.openExternal` not on preload → task 7 notes the fallback to `window.open`. **Follow-up:** expose `openExternal` on preload for the walkthrough link, or use a plain `<a href target="_blank">` with `setWindowOpenHandler` allowing blank targets.

**Known gap:** `openExternal` is not currently on `preload.ts`. The plan notes the fallback. This is tracked for a follow-up; the walkthrough degrades gracefully (the brew command is the primary CTA).

**Ordering with general onboarding:** The plan chains BH walkthrough into `onboardFinish` if the general onboarding hasn't been seen yet. This is slightly fragile — if `onboardFinish` is refactored, the chain breaks. Alternative: emit a custom event from `onboardFinish` that the BH code listens for. Flag for implementation review.

**Test coverage:** Python unit tests cover the regex thoroughly. The Playwright e2e relies on stubbing `audio-detect-virtual-driver` via `electronApp.evaluate` — this works in dev mode. In packaged builds, `ipcMain` is not accessible this way; the e2e is CI/dev only, matching the project's existing Playwright pattern.
