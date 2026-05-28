import { app, dialog, BrowserWindow, type BrowserWindow as BrowserWindowType } from 'electron';
import * as fs from 'fs';
import { storeFile } from './paths.js';

export type Store = Record<string, unknown>;

export function readAll(): Store {
  try { return JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Store; }
  catch { return {}; }
}

export function writeAll(data: Store): void {
  try { fs.writeFileSync(storeFile(), JSON.stringify(data, null, 2)); } catch {}
}

export function get<T>(key: string, fallback: T): T {
  return (readAll()[key] as T) ?? fallback;
}

export function save(key: string, val: unknown): void {
  const s = readAll(); s[key] = val; writeAll(s);
}

// Export the raw settings.json via Save dialog. Scope is intentionally just
// preferences (not custom packs / recordings) — those move via .mbpack.
export async function exportToFile(parent: BrowserWindowType | null): Promise<{ ok: boolean; canceled?: boolean; file?: string; error?: string }> {
  const win = BrowserWindow.getFocusedWindow() ?? parent ?? undefined;
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win!, {
    title:       'Export MeetingBoost settings',
    defaultPath: `meetingboost-settings-${stamp}.json`,
    filters:     [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(readAll(), null, 2));
    return { ok: true, file: res.filePath };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Wipe settings.json. Live windows fall back to defaults on next read; we
// re-broadcast a few effects (theme, opacity, alwaysOnTop) so the open
// windows reflect the reset without a manual reload.
export function reset(): { ok: boolean } {
  try { fs.unlinkSync(storeFile()); } catch {}
  for (const k of ['theme', 'windowOpacity', 'alwaysOnTop']) {
    applySideEffect(k, get(k, k === 'alwaysOnTop' ? true : k === 'windowOpacity' ? 100 : 'dark'));
  }
  return { ok: true };
}

// One place for all "this setting changes app behaviour at runtime" effects.
export function applySideEffect(key: string, val: unknown): void {
  const boardWin = sideEffects.getBoardWin();
  const childWin = sideEffects.getChildWin();
  switch (key) {
    case 'alwaysOnTop':
      boardWin?.setAlwaysOnTop(!!val);
      childWin?.setAlwaysOnTop(!!val);
      break;
    case 'theme':
      boardWin?.webContents.send('theme-changed', val);
      childWin?.webContents.send('theme-changed', val);
      break;
    case 'windowOpacity': {
      const op = sideEffects.clamp01(Number(val) / 100);
      boardWin?.setOpacity(op);
      break;
    }
    case 'launchAtLogin':
      app.setLoginItemSettings({ openAtLogin: !!val, openAsHidden: get('startHidden', false) });
      break;
    case 'startHidden':
      app.setLoginItemSettings({ openAtLogin: get('launchAtLogin', false), openAsHidden: !!val });
      break;
    case 'globalCapture':
      val ? sideEffects.startGlobalCapture() : sideEffects.stopGlobalCapture();
      break;
    case 'outputDeviceId':
      boardWin?.webContents.send('output-device-changed', val);
      break;
  }
}

// Side-effect dependencies injected from main.ts. Window handles are read via
// getters so this module always sees the current value of main.ts's mutable
// `boardWin` / `childWin` lets — not a snapshot from configure() time.
interface SideEffectDeps {
  getBoardWin: () => BrowserWindowType | null;
  getChildWin: () => BrowserWindowType | null;
  clamp01: (n: number) => number;
  startGlobalCapture: () => void;
  stopGlobalCapture: () => void;
}

const sideEffects: SideEffectDeps = {
  getBoardWin: () => null,
  getChildWin: () => null,
  clamp01: (n) => n,
  startGlobalCapture: () => {},
  stopGlobalCapture: () => {},
};

export function configure(deps: Partial<SideEffectDeps>): void {
  Object.assign(sideEffects, deps);
}
