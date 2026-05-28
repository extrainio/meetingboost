import {
  app, BrowserWindow, ipcMain, globalShortcut,
  Tray, nativeImage, Menu, screen, session,
  shell,
} from 'electron';
import * as path from 'path';
import { GlobalKeyboardListener } from 'node-global-key-listener';

import { ensureUserDirs } from './src/main/paths.js';
import * as settings from './src/main/settings.js';
import * as audio from './src/main/audio.js';
import * as recording from './src/main/recording.js';
import * as youtube from './src/main/youtube.js';
import * as packs from './src/main/packs.js';
import * as library from './src/main/library.js';

const isDev = process.env.ELECTRON_IS_DEV === '1';

let boardWin: BrowserWindow | null = null;
let childWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Wire main-process deps the settings module needs to dispatch side effects.
// Getters keep the link live so the module always sees the current boardWin /
// childWin values (they're reassigned during window lifecycle).
settings.configure({
  getBoardWin: () => boardWin,
  getChildWin: () => childWin,
  clamp01:            (n) => clamp01(n),
  startGlobalCapture: ()  => startGlobalCapture(),
  stopGlobalCapture:  ()  => stopGlobalCapture(),
});

// Recording module needs window refs (for `recordings-changed` events). It
// reaches into packs.* directly for the pack-detach side effect on delete —
// no DI needed for pack helpers since Task 6.
recording.configure({
  getBoardWin: () => boardWin,
  getChildWin: () => childWin,
});

// Packs + library modules emit their own `pack-selected` / `packs-changed` /
// `recordings-changed` events so they need window refs via the same getter
// pattern.
packs.configure({
  getBoardWin: () => boardWin,
  getChildWin: () => childWin,
});
library.configure({
  getBoardWin: () => boardWin,
  getChildWin: () => childWin,
});

function createBoardWindow(): void {
  const saved = (settings.readAll().boardPosition ?? {}) as { x?: number; y?: number };
  const startHidden  = settings.get('startHidden',  false);
  const windowOpacity = clamp01(settings.get<number>('windowOpacity', 100) / 100);

  boardWin = new BrowserWindow({
    width:     520,
    height:    580,
    minWidth:  520,
    maxWidth:  520,
    resizable: false,
    x: saved.x,
    y: saved.y,
    alwaysOnTop: settings.get('alwaysOnTop', true),
    frame:       false,
    hasShadow:   true,
    show:        !startHidden,
    opacity:     windowOpacity,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  boardWin.loadFile(path.join(__dirname, 'src', 'board.html'));

  boardWin.on('moved', () => {
    const [x, y] = boardWin!.getPosition();
    settings.save('boardPosition', { x, y });
  });

  boardWin.on('close', (e) => {
    if (!isQuitting && settings.get('hideOnClose', true)) {
      e.preventDefault();
      boardWin!.hide();
    }
  });

  if (isDev) boardWin.webContents.openDevTools({ mode: 'detach' });
}

function clamp01(n: number): number {
  return Math.max(0.3, Math.min(1, isNaN(n) ? 1 : n));
}

function openChild(page: string): void {
  if (childWin && !childWin.isDestroyed()) {
    childWin.loadFile(path.join(__dirname, 'src', `${page}.html`));
    childWin.focus();
    return;
  }

  const [bx, by] = boardWin!.getPosition();
  const disp = screen.getDisplayNearestPoint({ x: bx, y: by });
  const cx = Math.max(disp.bounds.x + 20, bx - 120);
  const cy = Math.min(by, disp.bounds.y + disp.bounds.height - 660);

  childWin = new BrowserWindow({
    width:  740,
    height: 640,
    x: cx,
    y: cy,
    alwaysOnTop: settings.get('alwaysOnTop', true),
    frame:     false,
    hasShadow: true,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  childWin.loadFile(path.join(__dirname, 'src', `${page}.html`));
  childWin.on('closed', () => { childWin = null; });

  if (isDev) childWin.webContents.openDevTools({ mode: 'detach' });
}

function createTray(): void {
  // Template image: macOS auto-tints it based on menu-bar light/dark state.
  // `__dirname` resolves through the asar in packaged builds.
  const trayIconPath = path.join(__dirname, 'assets', 'trayTemplate.png');

  let trayImg = nativeImage.createFromPath(trayIconPath);
  if (trayImg.isEmpty()) {
    // Fallback for dev runs where the icon hasn't been generated yet
    trayImg = nativeImage.createEmpty();
  } else {
    trayImg.setTemplateImage(true);
  }

  tray = new Tray(trayImg);
  tray.setToolTip(`MeetingBoost ${app.getVersion()}`);

  const menu = Menu.buildFromTemplate([
    { label: 'Show Board', click: () => { boardWin!.show(); boardWin!.focus(); } },
    { label: 'Add Sound…', click: () => openChild('sound-manager') },
    { label: 'Packs…',     click: () => openChild('packs') },
    { label: 'Settings…',  click: () => openChild('settings') },
    { type: 'separator' },
    { label: 'Quit MeetingBoost', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => {
    boardWin!.isVisible() ? boardWin!.hide() : (boardWin!.show(), boardWin!.focus());
  });
}

ipcMain.on('open-packs',     () => openChild('packs'));
ipcMain.on('open-add-sound', () => openChild('sound-manager'));
ipcMain.on('open-settings',  () => openChild('settings'));
ipcMain.on('open-board', () => {
  childWin?.close();
  boardWin!.show();
  boardWin!.focus();
});
ipcMain.on('close-window', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});
ipcMain.on('set-volume',   (_e, v: number)               => settings.save('volume', v));
ipcMain.on('select-pack',  (_e, packId: string) => {
  settings.save('activePack', packId);
  boardWin?.webContents.send('pack-selected', packId);
});
ipcMain.on('save-setting', (_e, key: string, val: unknown) => {
  settings.save(key, val);
  settings.applySideEffect(key, val);
});

ipcMain.handle('get-setting',      (_e, key: string, fb: unknown) => settings.get(key, fb));
ipcMain.handle('get-all-settings', () => settings.readAll());
ipcMain.handle('app-version',      () => app.getVersion());

ipcMain.handle('audio-detect-virtual-driver', () => audio.detectVirtualDriver(boardWin));

// Open a URL in the system's default browser via shell.openExternal.
// Restricted to http(s) so the bridge can't be used to launch file://, javascript:,
// or custom-protocol URIs from any future caller.
ipcMain.handle('open-external', async (_e, url: string): Promise<{ ok: boolean }> => {
  if (!/^https?:\/\//i.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('audio-mark-walkthrough-seen', () => audio.markWalkthroughSeen());

ipcMain.handle('settings-export', () => settings.exportToFile(childWin ?? boardWin));

ipcMain.handle('settings-reset', () => settings.reset());

ipcMain.handle('check-accessibility', () => audio.checkAccessibility());

ipcMain.handle('request-accessibility', () => audio.requestAccessibility());

// ── Global keyboard capture ──────────────────────────────────────────────────
//
// Uses node-global-key-listener (CGEventTap on macOS). Requires Accessibility
// permission — the OS will prompt on first start. Each A–Z keydown becomes an
// IPC event the board renderer plays as a sound, even when MeetingBoost is
// not the focused application.

let kbListener: GlobalKeyboardListener | null = null;
let lastFiredKey: string | null = null;
let lastFiredAt   = 0;
const KEY_REPEAT_MS = 80;          // de-bounce window when "suppressRepeat" is on

function startGlobalCapture(): void {
  if (kbListener) return;
  try {
    kbListener = new GlobalKeyboardListener();
    // Second arg is the modifier-state map: `down['LEFT META']` is true while
    // Cmd is held. Skipping when any modifier is down means Cmd+Q in another
    // app actually quits that app instead of also firing MeetingBoost's Q.
    kbListener.addListener((e, down) => {
      if (e.state !== 'DOWN') return;
      const name = (e.name || '').toLowerCase();
      if (!/^[a-z]$/.test(name)) return;

      const mods = down as Record<string, boolean>;
      if (mods['LEFT META'] || mods['RIGHT META'] ||
          mods['LEFT CTRL'] || mods['RIGHT CTRL'] ||
          mods['LEFT ALT']  || mods['RIGHT ALT']) return;

      if (settings.get('suppressRepeat', true)) {
        const now = Date.now();
        if (lastFiredKey === name && now - lastFiredAt < KEY_REPEAT_MS) return;
        lastFiredKey = name;
        lastFiredAt   = now;
      }

      boardWin?.webContents.send('global-key', name);
    });
  } catch (err) {
    // Permission denied or binary helper missing — fall through, board key
    // handlers still work when the window is focused.
    kbListener = null;
    console.warn('[meetingboost] global key listener unavailable:', (err as Error).message);
  }
}

function stopGlobalCapture(): void {
  try { kbListener?.kill(); } catch {}
  kbListener = null;
}

// ── Pack storage + YouTube + library inventory IPC ─────────────────────────
//
// Pack CRUD / read / bind / import / export — src/main/packs.ts
// Recording inventory CRUD                  — src/main/recording.ts
// YouTube snippet pipeline                  — src/main/youtube.ts
// library-* (promote prepared clips/packs)  — src/main/library.ts
//
// main.ts only wires the IPC channels. The handlers are intentionally one
// line each — every side effect (event fan-out, fs writes) lives in the
// owning module.

ipcMain.handle('yt-info',             (_e, url: string)                   => youtube.getInfo(url));
ipcMain.handle('yt-detect-snippets',  (_e, url: string)                   => youtube.detectSnippets(url));
ipcMain.handle('yt-prepare-clip',     (_e, opts: youtube.PrepareClipOpts) => youtube.prepareClip(opts));
ipcMain.handle('yt-prepare-pack',     (_e, opts: youtube.PreparePackOpts) => youtube.preparePack(opts));

ipcMain.handle('library-add-from-clip',          (_e, opts) => library.addFromClip(opts));
ipcMain.handle('library-create-pack-from-clips', (_e, opts) => library.createPackFromClips(opts));

ipcMain.handle('recording-save',   (_e, opts)               => recording.save(opts));
ipcMain.handle('recording-list',   ()                       => recording.list());
ipcMain.handle('recording-delete', (_e, id: string)         => recording.remove(id));
ipcMain.handle('recording-rename', (_e, id: string, n: string) => recording.rename(id, n));

ipcMain.handle('pack-create',     (_e, opts)                 => packs.create(opts));
ipcMain.handle('pack-delete',     (_e, id: string)           => packs.remove(id));
ipcMain.handle('pack-bind-sound', (_e, opts)                 => packs.bindSound(opts));
ipcMain.handle('pack-unbind-key', (_e, id: string, k: string) => packs.unbindKey(id, k));
ipcMain.handle('get-packs',       ()                         => packs.getAll());
ipcMain.handle('pack-export',     (_e, id: string)           => packs.exportPack(id));
ipcMain.handle('pack-import',     ()                         => packs.importPack());

function buildAppMenu(): void {
  // Frameless windows still respect application-menu accelerators. Without a
  // menu defined, Electron supplies a minimal default that doesn't always
  // route Cmd+Q/Cmd+M as users expect — especially when the focused window
  // is the frameless board. Define them explicitly.
  const focusedWin = (): BrowserWindow | null => {
    const w = BrowserWindow.getFocusedWindow();
    return w && !w.isDestroyed() ? w : (boardWin && !boardWin.isDestroyed() ? boardWin : null);
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: `Quit ${app.getName()}`,
          accelerator: 'Cmd+Q',
          click: () => { isQuitting = true; app.quit(); },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Minimize',
          accelerator: 'Cmd+M',
          click: () => {
            // Frameless windows can't classically "minimize" — hiding to the
            // tray matches user expectation for a tray-resident app.
            const w = focusedWin();
            if (!w) return;
            if (w === boardWin) w.hide();
            else                w.minimize();
          },
        },
        {
          label: 'Close',
          accelerator: 'Cmd+W',
          click: () => focusedWin()?.close(),
        },
        { type: 'separator' },
        {
          label: 'Show Board',
          accelerator: 'Alt+Shift+M',
          click: () => { boardWin?.show(); boardWin?.focus(); },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Allow getUserMedia({audio:true}) without a prompt — macOS still gates
  // access at the system level via TCC, so the user is prompted by the OS.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') return callback(true);
    callback(false);
  });

  ensureUserDirs();
  buildAppMenu();
  createBoardWindow();
  try {
    createTray();
  } catch (e) {
    console.error('createTray failed (continuing without tray):', e);
  }

  // After the board finishes loading, check for a virtual audio driver.
  // If absent and the walkthrough hasn't been seen, push an event to the renderer.
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
    boardWin!.isVisible() ? boardWin!.hide() : (boardWin!.show(), boardWin!.focus());
  });

  // Restore persisted runtime state
  if (settings.get('globalCapture', false)) startGlobalCapture();

  app.on('activate', () => { boardWin!.show(); boardWin!.focus(); });
});

app.on('window-all-closed', () => { /* tray app — stay alive until explicit quit */ });
// Anything that reaches `before-quit` (Cmd+Q, app.quit() from Playwright,
// macOS shutdown) is a real exit — flip the flag so the board's "hide on
// close" handler stops vetoing the close.
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopGlobalCapture();
});
