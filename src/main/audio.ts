import { systemPreferences, type BrowserWindow } from 'electron';
import * as settings from './settings.js';

// ── Virtual driver detection ───────────────────────────────────────────────
//
// Mirrored in tests/test_blackhole_detection.py.

export const VIRTUAL_DRIVER_RE = /BlackHole|VB-Cable|Soundflower|Loopback Audio/i;

export function isVirtualAudioDevice(name: string): boolean {
  return VIRTUAL_DRIVER_RE.test(name);
}

// Detect virtual audio driver by enumerating output devices.
// Uses the board window's renderer context (navigator.mediaDevices) because
// main-process code has no access to Web Audio APIs.
// Returns { found: boolean, deviceName?: string }.
export async function detectVirtualDriver(
  boardWin: BrowserWindow | null,
): Promise<{ found: boolean; deviceName?: string }> {
  if (!boardWin || boardWin.isDestroyed()) return { found: false };
  try {
    // Enumerate-only: no getUserMedia so we don't trigger the TCC prompt.
    // If labels are empty (no prior mic permission), detection returns false
    // and the walkthrough shows — the Refresh button inside it requests permission.
    const result = await boardWin.webContents.executeJavaScript(`
      (async () => {
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
}

// Write firstRun.blackholeWalkthroughSeen = true.
// Uses the flat key naming convention of the existing settings store.
// Errors are caught by settings.writeAll() internally — fail open.
export function markWalkthroughSeen(): { ok: boolean } {
  settings.save('firstRun.blackholeWalkthroughSeen', true);
  return { ok: true };
}

export function checkAccessibility(): boolean {
  return process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : true;
}

export function requestAccessibility(): boolean {
  if (process.platform === 'darwin') {
    // Triggers the macOS prompt — user must grant in System Settings, then restart MB
    systemPreferences.isTrustedAccessibilityClient(true);
  }
  return true;
}
