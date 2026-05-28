import {
  app, BrowserWindow, Tray, nativeImage, Menu, screen,
  ipcMain,
} from 'electron';
// ipcMain is imported here intentionally — the window-coupled IPC handlers
// (open-packs, open-add-sound, open-settings, open-board, close-window,
// select-pack) are tightly bound to boardWin/childWin module state. This is
// the one documented exception to the "ipcMain only in main.ts" rule.
import * as path from 'path';
import { GlobalKeyboardListener } from 'node-global-key-listener';
import * as settings from './settings.js';

const isDev = process.env.ELECTRON_IS_DEV === '1';

// ── Module state ─────────────────────────────────────────────────────────────
let boardWin: BrowserWindow | null = null;
let childWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Global keyboard listener state
let kbListener: GlobalKeyboardListener | null = null;
let lastFiredKey: string | null = null;
let lastFiredAt   = 0;
const KEY_REPEAT_MS = 80;          // de-bounce window when "suppressRepeat" is on

// ── Getters / setters ────────────────────────────────────────────────────────
export const getBoardWin = (): BrowserWindow | null => boardWin;
export const getChildWin = (): BrowserWindow | null => childWin;
export const setIsQuitting = (v: boolean): void => { isQuitting = v; };

// ── Helpers ──────────────────────────────────────────────────────────────────
function clamp01(n: number): number {
  return Math.max(0.3, Math.min(1, isNaN(n) ? 1 : n));
}

export function createBoardWindow(): void {
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
      preload:          path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  boardWin.loadFile(path.join(__dirname, '..', '..', 'src', 'board.html'));

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

export function openChild(page: string): void {
  if (childWin && !childWin.isDestroyed()) {
    childWin.loadFile(path.join(__dirname, '..', '..', 'src', `${page}.html`));
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
      preload:          path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  childWin.loadFile(path.join(__dirname, '..', '..', 'src', `${page}.html`));
  childWin.on('closed', () => { childWin = null; });

  if (isDev) childWin.webContents.openDevTools({ mode: 'detach' });
}

// Optional builder for an extra menu section (e.g., the update item). Injected
// from main.ts via setTrayExtras; returns the items to splice in just above
// the Quit entry. Keeps windows.ts oblivious to update state.
type TrayExtrasBuilder = () => Electron.MenuItemConstructorOptions[];
let trayExtras: TrayExtrasBuilder | null = null;

export function setTrayExtras(builder: TrayExtrasBuilder | null): void {
  trayExtras = builder;
  if (tray) rebuildTrayMenu();
}

export function rebuildTrayMenu(): void {
  if (!tray) return;
  const base: Electron.MenuItemConstructorOptions[] = [
    { label: 'Show Board', click: () => { boardWin!.show(); boardWin!.focus(); } },
    { label: 'Add Sound…', click: () => openChild('sound-manager') },
    { label: 'Packs…',     click: () => openChild('packs') },
    { label: 'Settings…',  click: () => openChild('settings') },
    { type: 'separator' },
  ];
  const extras = trayExtras ? trayExtras() : [];
  const quit: Electron.MenuItemConstructorOptions[] = [
    { label: 'Quit MeetingBoost', click: () => { isQuitting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate([...base, ...extras, ...quit]));
}

export function createTray(): void {
  // Template image: macOS auto-tints it based on menu-bar light/dark state.
  // `__dirname` resolves through the asar in packaged builds.
  const trayIconPath = path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png');

  let trayImg = nativeImage.createFromPath(trayIconPath);
  if (trayImg.isEmpty()) {
    // Fallback for dev runs where the icon hasn't been generated yet
    trayImg = nativeImage.createEmpty();
  } else {
    trayImg.setTemplateImage(true);
  }

  tray = new Tray(trayImg);
  tray.setToolTip(`MeetingBoost ${app.getVersion()}`);
  rebuildTrayMenu();

  tray.on('click', () => {
    boardWin!.isVisible() ? boardWin!.hide() : (boardWin!.show(), boardWin!.focus());
  });
}

export function buildAppMenu(): void {
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

// ── Global keyboard capture ──────────────────────────────────────────────────
//
// Uses node-global-key-listener (CGEventTap on macOS). Requires Accessibility
// permission — the OS will prompt on first start. Each A–Z keydown becomes an
// IPC event the board renderer plays as a sound, even when MeetingBoost is
// not the focused application.
export function startGlobalCapture(): void {
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

export function stopGlobalCapture(): void {
  try { kbListener?.kill(); } catch {}
  kbListener = null;
}

// ── Window-coupled IPC (registered explicitly by main.ts at startup) ─────────
export function registerWindowIPC(): void {
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
  ipcMain.on('select-pack', (_e, packId: string) => {
    settings.save('activePack', packId);
    boardWin?.webContents.send('pack-selected', packId);
  });
}
