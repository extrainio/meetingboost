# BlackHole First-Run Detection + Setup Walkthrough

**Status:** Approved (design)
**Date:** 2026-05-09
**Author:** brainstormed with Claude Code (superpowers)

## Goal

Detect a missing virtual audio driver at first launch and walk the user through a 90-second install — before they silently route sounds nowhere useful. The current onboarding (`onboardingComplete`) covers the general welcome flow but says nothing concrete about BlackHole. Users who skip the install have a working soundboard that sends audio to the wrong destination with no warning.

## Non-goals

- Windows and Linux support. MeetingBoost is macOS-only; this feature stays macOS-only.
- Auto-installing BlackHole via `exec`/`shell`. We link; we don't shell-out package managers on the user's behalf.
- Verifying that Zoom/Teams/Meet is configured to use BlackHole as its microphone. We confirm the driver exists on the system; per-app meeting configuration is out of scope.
- Replacing the existing general onboarding (`onboardingComplete`). Both flows coexist — the general flow fires first-run; the BlackHole flow fires if the driver is absent regardless of whether general onboarding was previously completed.
- Surfacing this walkthrough on any trigger other than first-run + re-entry via the footer indicator.

## Scope summary

| Dimension | Decision |
|---|---|
| Input | App launch (board `DOMContentLoaded`), plus focus-regain and explicit footer re-entry |
| Detection | `navigator.mediaDevices.enumerateDevices()` in renderer; label match against `/BlackHole\|VB-Cable\|Soundflower\|Loopback Audio/i` |
| Detection location | Renderer-side (board.html) for the re-detect button; IPC handler `audio-detect-virtual-driver` in main for the initial boot check |
| Output | 3-step inline overlay panel on the board window (not a separate window) |
| Setting | `firstRun.blackholeWalkthroughSeen: boolean` in `settings.json` |
| Re-entry | Footer status indicator `⚠ no virtual driver · setup` visible when walkthrough was dismissed but driver is still absent |
| Platform | macOS only — `navigator.mediaDevices` is available in Electron's renderer context |

## Architecture

Detection runs in two places with intentionally different motivations. The main-process IPC handler `audio-detect-virtual-driver` is the authoritative check at startup: main calls it during `app.whenReady`, then signals the board renderer via a push event `blackhole-detect-result`. The renderer also runs detection directly via `navigator.mediaDevices.enumerateDevices()` for the in-walkthrough "Refresh devices" button (step 2), because re-detecting on a button press is a renderer concern — round-tripping to main just to call the same Web API is unnecessary indirection. The helper `isVirtualAudioDevice(name)` is implemented once in TypeScript (main) and mirrored in Python for testing; the renderer uses an inline regex equivalent.

```
app.whenReady()
  └─ audio-detect-virtual-driver IPC handler registers
  └─ createBoardWindow()
       └─ boardWin 'did-finish-load'
            └─ invoke('audio-detect-virtual-driver')
                 ├─ found → no-op (driver present)
                 └─ not found
                      ├─ firstRun.blackholeWalkthroughSeen == true → no-op
                      └─ false → boardWin.webContents.send('show-blackhole-walkthrough')

renderer (board.html) DOMContentLoaded
  └─ onOutputDeviceChanged, onGlobalKey, pack init … (unchanged)
  └─ listen for 'show-blackhole-walkthrough'
       └─ showBlackholeWalkthrough(step=0)

Step 2 — "Refresh devices" click
  └─ reDetectVirtualDriver() [renderer-side enumerateDevices()]
       ├─ found → markWalkthroughSeen() → autoAdvance(step=3)
       └─ not found → show inline tip

window.addEventListener('focus')
  └─ if walkthroughActive && step==2
       └─ reDetectVirtualDriver() [silent auto-advance if found]

"Done" or "Skip" button
  └─ electronAPI.markBlackholeWalkthroughSeen()
       └─ IPC → setSetting('firstRun.blackholeWalkthroughSeen', true)
  └─ hideWalkthrough()
  └─ if driver still absent → showFooterIndicator()
```

**Key invariant:** `firstRun.blackholeWalkthroughSeen` is written once — on Done or Skip. It is never written on a forced dismiss (e.g., app crash). If the setting write fails, the app fails open: the overlay hides and the flag stays false, so the next launch re-triggers — but the footer indicator does not loop.

## UI / Behavior

### Step 1 — Why

```
┌─────────────────────────────────────────────────────────────┐
│  STEP 1 OF 3                                                │
│                                                             │
│  VIRTUAL AUDIO CABLE REQUIRED                               │
│                                                             │
│  MeetingBoost needs a virtual audio cable to route sounds   │
│  into Zoom/Teams/Meet. BlackHole is the standard — it's     │
│  free, open source, and 30 seconds to install.              │
│                                                             │
│  ●  ○  ○                              [Skip]  [Continue →]  │
└─────────────────────────────────────────────────────────────┘
```

"Skip" sets `firstRun.blackholeWalkthroughSeen = true` and dismisses immediately. Suitable for power users who have a different virtual driver already installed — they passed detection so they wouldn't see this overlay, but if they somehow land here, Skip is the escape hatch.

### Step 2 — Install

```
┌─────────────────────────────────────────────────────────────┐
│  STEP 2 OF 3                                                │
│                                                             │
│  INSTALL BLACKHOLE                                          │
│                                                             │
│  Option A — Homebrew (recommended):                         │
│  ┌─────────────────────────────────────────┐  [Copy]        │
│  │ brew install blackhole-2ch              │               │
│  └─────────────────────────────────────────┘               │
│                                                             │
│  Option B — installer package:                              │
│  Download from existential.audio/blackhole →                │
│                                                             │
│  [← Back]  [I've installed it — refresh devices →]         │
│                                                             │
│  ●  ●  ○                                          [Skip]    │
└─────────────────────────────────────────────────────────────┘
```

"I've installed it — refresh devices →" calls `reDetectVirtualDriver()`. If found, the overlay auto-advances to step 3 and writes the seen flag. If not found, an inline message appears below the button: *"Still not seeing a virtual driver. macOS sometimes needs a logout/login after install."* The "Download installer" link calls `shell.openExternal` and has no effect on step state.

On app focus-regain while step 2 is active, `reDetectVirtualDriver()` runs silently; if it finds a driver it auto-advances without any click required.

### Step 3 — Configure

```
┌─────────────────────────────────────────────────────────────┐
│  STEP 3 OF 3                                                │
│                                                             │
│  CONFIGURE ROUTING                                          │
│                                                             │
│  MeetingBoost output  →  BlackHole 2ch                      │
│  Your meeting app mic →  BlackHole 2ch                      │
│                                                             │
│  In MeetingBoost: Settings → Audio → Virtual Output         │
│  In Zoom/Teams/Meet: Microphone → BlackHole 2ch             │
│                                                             │
│  ●  ●  ●                              [← Back]   [Done]     │
└─────────────────────────────────────────────────────────────┘
```

"Done" writes the seen flag and closes the overlay. If detection still shows no driver (user skipped the install), the footer indicator appears. If a driver was found in step 2, the footer indicator does not appear.

### Footer status indicator (dismissed-but-still-missing)

```
┌ board footer ─────────────────────────────────────────────┐
│ Output · BlackHole 2ch ▾         ⚠ no virtual driver · setup  0 fired  [Packs] [+ Add Sound] │
└────────────────────────────────────────────────────────────┘
```

The indicator is a clickable inline chip in the footer, styled with `--warn` color, between the output chip and the session counter. Clicking it re-opens the walkthrough at step 2 (skip step 1 — they've already been told why). The indicator disappears if `audio-detect-virtual-driver` returns `found: true` on a subsequent launch.

## Data flow

```
MAIN                            RENDERER (board.html)              DISK
────                            ─────────────────────              ────

app boot
  ipcMain.handle('audio-detect-virtual-driver')
  ipcMain.handle('audio-mark-walkthrough-seen')

boardWin 'did-finish-load'
  invoke('audio-detect-virtual-driver')
    enumerateDevices() [main uses
    navigator via session helper]      ←─ OR ─→ [renderer calls directly]
    regex match
    return { found, deviceName? }
                                 ←── 'show-blackhole-walkthrough'
                                       (only if !found && !seen)

                                 showBlackholeWalkthrough(0)
                                   render step 1 content
                                   overlay.show()

                                 [user clicks Continue]
                                   showBlackholeWalkthrough(1)

                                 [user clicks Refresh]
                                   reDetectVirtualDriver()
                                     enumerateDevices() (renderer)
                                     regex match
                                     ├─ found → markSeen() → step 3
                                     └─ not found → inline tip

                                 [user clicks Done/Skip]
                                   electronAPI.markBlackholeWalkthroughSeen()
                                                                   settings.json ← firstRun.blackholeWalkthroughSeen=true
                                   overlay.hide()
                                   if !driverFound → footerIndicator.show()
```

**Settings key decision:** `firstRun.blackholeWalkthroughSeen` is stored as a top-level flat key in `settings.json` (not a nested object) to match the existing pattern where all settings are flat (`onboardingComplete`, `activePack`, `outputDeviceId`). The `firstRun.` prefix is a naming convention only, not a nested object.

## Error handling

| Scenario | Handling |
|---|---|
| `enumerateDevices()` throws (rare — Electron always grants media in renderer) | Catch, treat as `found: false`, proceed to show walkthrough. Fail open. |
| `enumerateDevices()` returns devices with empty labels (mic permission denied) | Labels are unlocked by the existing `getUserMedia` flow in `settings.html`. In the board context, we match on `label` — empty labels produce no match. Treat as not found. Show walkthrough. User can still proceed normally. |
| `shell.openExternal` blocked by OS policy | The link call is fire-and-forget. If it fails silently, the user still has the brew command to copy. No error state shown. |
| Settings write fails in `markBlackholeWalkthroughSeen` | `setSetting` catches write errors silently (existing pattern: `try { fs.writeFileSync... } catch {}`). Walkthrough hides anyway — fail open. Next launch re-triggers the walkthrough, which is acceptable vs. a broken loop. |
| User has multiple virtual drivers | `/BlackHole\|VB-Cable\|Soundflower\|Loopback Audio/i` matches any. `{ found: true, deviceName: 'BlackHole 2ch' }` returns the first match. Walkthrough is suppressed. No state written. |
| General onboarding (`onboardingComplete`) hasn't been seen yet | Both overlays can coexist in the DOM. Ordering decision: general onboarding fires first (step 1 of 3 general), then BlackHole walkthrough fires after general onboarding finishes. This avoids two overlays at once. Implementation: `showBlackholeWalkthrough` is called inside the `onboardFinish` callback if detection failed, rather than in `DOMContentLoaded` directly. |

## Edge cases

**Re-detection on focus regain:** `window.addEventListener('focus')` calls `reDetectVirtualDriver()` only when `walkthroughActive && walkthroughStep === 1` (step 2 in 0-indexed). If found, writes seen flag and advances. Guards against repeated triggers: set a `reDetectInFlight` boolean, clear it after the call resolves.

**User installs BlackHole then dismisses the walkthrough without refreshing:** The footer indicator will show on this session (we don't know they installed it). On the next launch, `audio-detect-virtual-driver` finds the driver and suppresses the walkthrough; the footer indicator does not appear either. Net result: one session of spurious indicator; self-heals on relaunch.

**Multiple-window scenarios:** The walkthrough overlay lives only in `board.html`. Child windows (settings, packs, sound-manager) are unaffected.

**Reset settings:** `settings-reset` wipes `settings.json`. This clears `firstRun.blackholeWalkthroughSeen`. On the next load, if no driver is found, the walkthrough shows again. This is correct behavior — a reset should re-trigger setup.

## Testing

### Layer 1 — Python unit test (`tests/test_blackhole_detection.py`)

Pure-Python reimplementation of `isVirtualAudioDevice`, mirroring the project's existing pattern (`test_record_pipeline.py`, `test_youtube_pack.py`). No Electron boot required.

```python
# tests/test_blackhole_detection.py
import re, unittest

VIRTUAL_DRIVER_RE = re.compile(
    r'BlackHole|VB-Cable|Soundflower|Loopback Audio', re.IGNORECASE
)

def is_virtual_audio_device(name: str) -> bool:
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
        # Device names sometimes include vendor prefix
        self.assertTrue(is_virtual_audio_device('Existential Audio BlackHole 2ch'))
```

### Layer 2 — Playwright e2e (`tests/e2e/blackhole-walkthrough.spec.ts`)

Stubs the `audio-detect-virtual-driver` IPC call to return `{ found: false }` (no real BlackHole required in CI). Uses Electron's `ipcMain` mock via `electron-playwright-helpers` or the existing test harness pattern.

One golden path:

1. Boot app with stubbed `audio-detect-virtual-driver` → `{ found: false }`.
2. Assert `#bhOverlay` becomes visible with step-1 content.
3. Click Skip → assert overlay hides.
4. Assert `firstRun.blackholeWalkthroughSeen === true` by reading `settings.json` from `app.getPath('userData')`.
5. Reload app → assert overlay does not re-appear (seen flag present).

Manual smoke:

- With no BlackHole installed: launch app, confirm walkthrough appears on step 1, complete all 3 steps, confirm overlay hides, confirm footer indicator absent (driver was not detected so indicator shows — verify it appears).
- With BlackHole installed: launch app, confirm no walkthrough appears.
- Step 2 refresh: install BlackHole mid-walkthrough, click "Refresh devices", confirm auto-advance to step 3.

## File-level change list

- `main.ts` — add `isVirtualAudioDevice(name)` helper; add `ipcMain.handle('audio-detect-virtual-driver')` and `ipcMain.handle('audio-mark-walkthrough-seen')`; emit `blackhole-detect-result` push event after board loads.
- `preload.ts` — expose `detectVirtualDriver()` and `markBlackholeWalkthroughSeen()`.
- `src/board.html` — add BlackHole walkthrough overlay (`#bhOverlay`) with 3-step state machine; add footer status indicator; add `reDetectVirtualDriver()` renderer helper; add focus-regain handler; wire `'blackhole-detect-result'` IPC listener.
- `tests/test_blackhole_detection.py` — Layer 1 Python tests.
- `tests/e2e/blackhole-walkthrough.spec.ts` — Layer 2 Playwright e2e.

No changes to: `packs.json`, `recordings.json`, the general onboarding flow, `settings.html`, `packs.html`, `sound-manager.html`.
