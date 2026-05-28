import { app, systemPreferences, type BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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

// ── Bundled BlackHole installer ────────────────────────────────────────────
//
// Resolve the bundled BlackHole installer path. Dev builds look in the
// project tree; packaged builds read from electron-builder's extraResources
// directory (`process.resourcesPath/installers/`). Returns null if the
// installer wasn't bundled — the renderer falls back to brew/web links then.
function bundledInstallerPath(): string | null {
  const filename = 'BlackHole2ch.pkg';
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'installers', filename)
    : path.join(__dirname, '..', '..', 'assets', 'installers', filename);
  return fs.existsSync(candidate) ? candidate : null;
}

export function isBundledInstallerAvailable(): { available: boolean } {
  return { available: bundledInstallerPath() !== null };
}

// Launch the bundled BlackHole .pkg via Apple's Installer.app. The installer
// is signed by Existential Audio (Developer ID), so Gatekeeper accepts it
// without right-click → Open. BlackHole is an AudioServerPlugin (not a kext)
// since v0.5, so no separate "system extension approval" prompt is needed —
// just the standard admin password prompt the Installer presents itself.
//
// `open -W` blocks until the user closes Installer.app. We don't try to read
// the installer's exit code for success vs cancel — the renderer instead
// re-detects the BlackHole audio device after the call returns.
export function installBundled(): Promise<{ ok: boolean; error?: string }> {
  const pkg = bundledInstallerPath();
  if (!pkg) return Promise.resolve({ ok: false, error: 'Bundled installer not present in this build' });
  return new Promise((resolve) => {
    const proc = spawn('open', ['-W', pkg]);
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('exit', (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: `installer exited ${code}` });
    });
  });
}

// Opens Audio MIDI Setup so the user can create a Multi-Output Device that
// combines built-in speakers + BlackHole 2ch (the routing step we can't
// fully automate without a CoreAudio helper binary).
export function openAudioMidiSetup(): { ok: boolean } {
  spawn('open', ['-a', 'Audio MIDI Setup']).unref();
  return { ok: true };
}
