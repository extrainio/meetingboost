import { app, BrowserWindow, ipcMain, globalShortcut, session, shell } from 'electron';

import { ensureUserDirs } from './src/main/paths.js';
import * as settings from './src/main/settings.js';
import * as audio from './src/main/audio.js';
import * as recording from './src/main/recording.js';
import * as youtube from './src/main/youtube.js';
import * as packs from './src/main/packs.js';
import * as library from './src/main/library.js';
import * as protocol from './src/main/protocol.js';
import * as windows from './src/main/windows.js';

// Wire main-process deps the settings module needs to dispatch side effects.
// Getters keep the link live so the module always sees the current boardWin /
// childWin values (they're reassigned during window lifecycle).
settings.configure({
  getBoardWin:        windows.getBoardWin,
  getChildWin:        windows.getChildWin,
  startGlobalCapture: windows.startGlobalCapture,
  stopGlobalCapture:  windows.stopGlobalCapture,
});

// Recording / packs / library modules emit window-targeted events
// (`recordings-changed`, `packs-changed`, `pack-selected`) and need live
// window refs via the same getter pattern.
recording.configure({ getBoardWin: windows.getBoardWin, getChildWin: windows.getChildWin });
packs.configure({     getBoardWin: windows.getBoardWin, getChildWin: windows.getChildWin });
library.configure({   getBoardWin: windows.getBoardWin, getChildWin: windows.getChildWin });
protocol.configure({  getBoardWin: windows.getBoardWin, getChildWin: windows.getChildWin });

// Single-instance lock — required so a second launch (e.g. user clicks an
// mbpack:// link while the app is already running on Windows/Linux) routes
// the URL to the existing process instead of opening a duplicate.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find(a => a.startsWith('mbpack://'));
    if (url) protocol.handleMbpackUrl(url);
    const w = windows.getBoardWin();
    if (w && !w.isDestroyed()) { w.show(); w.focus(); }
  });
}

// macOS routes URL launches through `open-url` instead of argv. Can fire
// before or after `whenReady`, so handleMbpackUrl queues and drains.
app.on('open-url', (event, url) => {
  event.preventDefault();
  protocol.handleMbpackUrl(url);
});

app.setAsDefaultProtocolClient('mbpack');

// ── IPC registration table — pure delegation ─────────────────────────────────
//
// Pack CRUD / read / bind / import / export — src/main/packs.ts
// Recording inventory CRUD                  — src/main/recording.ts
// YouTube snippet pipeline                  — src/main/youtube.ts
// library-* (promote prepared clips/packs)  — src/main/library.ts
// Window/tray/keyboard + window-coupled IPC — src/main/windows.ts
//
// main.ts only wires channels. The handlers are intentionally one line each —
// every side effect (event fan-out, fs writes) lives in the owning module.

// app
ipcMain.handle('app-version', () => app.getVersion());

// Open a URL in the system's default browser via shell.openExternal.
// Restricted to http(s) so the bridge can't be used to launch file://, javascript:,
// or custom-protocol URIs from any future caller.
ipcMain.handle('open-external', async (_e, url: string): Promise<{ ok: boolean }> => {
  if (!/^https?:\/\//i.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

// settings
ipcMain.on(    'set-volume',       (_e, v: number)               => settings.save('volume', v));
ipcMain.on(    'save-setting',     (_e, key: string, val: unknown) => {
  settings.save(key, val);
  settings.applySideEffect(key, val);
});
ipcMain.handle('get-setting',      (_e, key: string, fb: unknown) => settings.get(key, fb));
ipcMain.handle('get-all-settings', () => settings.readAll());
ipcMain.handle('settings-export',  () => settings.exportToFile(windows.getChildWin() ?? windows.getBoardWin()));
ipcMain.handle('settings-reset',   () => settings.reset());

// audio
ipcMain.handle('audio-detect-virtual-driver',   () => audio.detectVirtualDriver(windows.getBoardWin()));
ipcMain.handle('audio-mark-walkthrough-seen',   () => audio.markWalkthroughSeen());
ipcMain.handle('check-accessibility',           () => audio.checkAccessibility());
ipcMain.handle('request-accessibility',         () => audio.requestAccessibility());
ipcMain.handle('blackhole-installer-available', () => audio.isBundledInstallerAvailable());
ipcMain.handle('install-blackhole',             () => audio.installBundled());
ipcMain.handle('open-audio-midi-setup',         () => audio.openAudioMidiSetup());

// recording
ipcMain.handle('recording-save',   (_e, opts)                  => recording.save(opts));
ipcMain.handle('recording-list',   ()                          => recording.list());
ipcMain.handle('recording-delete', (_e, id: string)            => recording.remove(id));
ipcMain.handle('recording-rename', (_e, id: string, n: string) => recording.rename(id, n));

// youtube
ipcMain.handle('yt-info',             (_e, url: string)                   => youtube.getInfo(url));
ipcMain.handle('yt-detect-snippets',  (_e, url: string)                   => youtube.detectSnippets(url));
ipcMain.handle('yt-prepare-clip',     (_e, opts: youtube.PrepareClipOpts) => youtube.prepareClip(opts));
ipcMain.handle('yt-prepare-pack',     (_e, opts: youtube.PreparePackOpts) => youtube.preparePack(opts));

// packs
ipcMain.handle('pack-create',     (_e, opts)                    => packs.create(opts));
ipcMain.handle('pack-delete',     (_e, id: string)              => packs.remove(id));
ipcMain.handle('pack-bind-sound', (_e, opts)                    => packs.bindSound(opts));
ipcMain.handle('pack-unbind-key', (_e, id: string, k: string)   => packs.unbindKey(id, k));
ipcMain.handle('get-packs',       ()                            => packs.getAll());
ipcMain.handle('pack-export',     (_e, id: string)              => packs.exportPack(id));
ipcMain.handle('pack-import',     ()                            => packs.importPack());

// library
ipcMain.handle('library-add-from-clip',          (_e, opts) => library.addFromClip(opts));
ipcMain.handle('library-create-pack-from-clips', (_e, opts) => library.createPackFromClips(opts));

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Allow getUserMedia({audio:true}) without a prompt — macOS still gates
  // access at the system level via TCC, so the user is prompted by the OS.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') return callback(true);
    callback(false);
  });

  ensureUserDirs();
  windows.buildAppMenu();
  windows.createBoardWindow();
  try {
    windows.createTray();
  } catch (e) {
    console.error('createTray failed (continuing without tray):', e);
  }
  windows.registerWindowIPC();

  // After the board finishes loading, check for a virtual audio driver.
  // If absent and the walkthrough hasn't been seen, push an event to the renderer.
  const boardWin = windows.getBoardWin();
  boardWin!.webContents.once('did-finish-load', async () => {
    const seen = settings.get<boolean>('firstRun.blackholeWalkthroughSeen', false);
    if (seen) return;
    try {
      const { found } = await (boardWin!.webContents.executeJavaScript(`
        (async () => {
          const devices = await navigator.mediaDevices.enumerateDevices();
          return devices
            .filter(d => d.kind === 'audiooutput')
            .map(d => d.label || '');
        })()
      `) as Promise<string[]>).then(labels => ({
        found: labels.some(l => audio.isVirtualAudioDevice(l)),
      }));
      if (!found) {
        boardWin!.webContents.send('show-blackhole-walkthrough');
      }
    } catch { /* fail open — no walkthrough is better than a crash */ }
  });

  globalShortcut.register('Alt+Shift+M', () => {
    const w = windows.getBoardWin();
    w!.isVisible() ? w!.hide() : (w!.show(), w!.focus());
  });

  // Restore persisted runtime state
  if (settings.get('globalCapture', false)) windows.startGlobalCapture();

  // mbpack:// URL that arrived during cold-start, before app was ready.
  protocol.drainPending();

  app.on('activate', () => {
    const w = windows.getBoardWin();
    w!.show(); w!.focus();
  });
});

app.on('window-all-closed', () => { /* tray app — stay alive until explicit quit */ });
// Anything that reaches `before-quit` (Cmd+Q, app.quit() from Playwright,
// macOS shutdown) is a real exit — flip the flag so the board's "hide on
// close" handler stops vetoing the close.
app.on('before-quit', () => { windows.setIsQuitting(true); });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  windows.stopGlobalCapture();
});
