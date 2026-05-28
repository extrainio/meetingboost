import {
  app, BrowserWindow, ipcMain, globalShortcut,
  Tray, nativeImage, Menu, screen, session, dialog,
  shell,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { GlobalKeyboardListener } from 'node-global-key-listener';

import {
  userPacksFile, userSoundsDir,
  userRecordingsDir, customSoundsDir,
  ensureUserDirs, bundledPacksFile, bundledSoundsRoot,
} from './src/main/paths.js';
import { spawnPromise } from './src/main/tools.js';
import * as settings from './src/main/settings.js';
import * as audio from './src/main/audio.js';
import * as recording from './src/main/recording.js';
import * as youtube from './src/main/youtube.js';

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

// Recording module needs window refs (for `recordings-changed` events) and the
// pack helpers (still in main.ts; moved out in Task 6). Same getter pattern so
// the module always sees the current boardWin/childWin values.
recording.configure({
  getBoardWin: () => boardWin,
  getChildWin: () => childWin,
  readUserPacks,
  writeUserPacks,
  refreshBoardIfActivePackIs,
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

// ── Pack storage ─────────────────────────────────────────────────────────────
//
// Built-in packs ship inside the bundle (read-only inside app.asar). User-
// authored packs and the user's "custom" pack live in userData, which is
// always writable. readPacks() merges them — user wins on id collision.
//
// Source tracking is **per entry**, not per pack. When a user binds a new
// recording into an originally-bundled pack, we clone the pack into user
// storage but every untouched entry keeps `source: 'bundled'` so its audio
// file still resolves from the bundle. Only newly-bound entries point at
// userData.

type EntrySource = 'bundled' | 'user' | 'recording';

interface SoundEntry {
  label:   string;
  file:    string;     // path relative to that entry's source root
  source?: EntrySource;
}

interface PackEntry {
  id:          string;
  name:        string;
  description: string;
  keys:        Record<string, SoundEntry>;
  /** Where this pack's *metadata* lives. Set by the loader, not stored. */
  origin?: 'bundled' | 'user';
}

function slugify(name: string, fallback = 'sound'): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
}

// ── YouTube Pack helpers ───────────────────────────────────────────────────
//
// Snippet → keyboard-pack transforms (filterSnippets / mapSnippetsToKeys /
// classifyDetectResult) and the yt-dlp/ffmpeg orchestration now live in
// src/main/youtube.ts. slugifyPackName stays here because the library-*
// handlers (Task 6) still call it directly.

export function slugifyPackName(
  name: string,
  existingNames: string[]
): { finalName: string; packId: string } {
  const base = (name || '').trim() || 'YouTube Pack';

  let finalName = base;
  let n = 2;
  while (existingNames.includes(finalName)) {
    finalName = `${base} (${n})`;
    n += 1;
  }

  let slug = finalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) {
    slug = `yt-pack-${Date.now()}`;
  }

  return { finalName, packId: slug };
}

function tagBundledEntries(p: PackEntry): PackEntry {
  // Every entry in a bundled pack file is, by definition, a bundled asset.
  const keys: Record<string, SoundEntry> = {};
  for (const [k, e] of Object.entries(p.keys)) {
    keys[k] = { ...e, source: 'bundled' };
  }
  return { ...p, keys, origin: 'bundled' };
}

function readBundledPacks(): PackEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(bundledPacksFile(), 'utf8')) as PackEntry[];
    // The bundled file historically contained a "custom" pack with dev-only
    // entries. Strip it on read — custom is always user-owned now.
    return raw.filter(p => p.id !== 'custom').map(tagBundledEntries);
  } catch {
    return [];
  }
}

/**
 * Infer a missing `source` for a user-pack entry that pre-dates per-entry
 * source tracking. Older builds saved bundled-clone entries as plain paths
 * like `classics/applause.mp3` (which only exist in the bundle) and recording
 * pointers as `recordings/<file>` paths. We detect those at read time so old
 * data keeps resolving correctly without forcing the user to wipe userData.
 */
function inferEntrySource(entry: SoundEntry): SoundEntry {
  if (entry.source) return entry;
  if (entry.file.startsWith('recordings/')) {
    return { ...entry, source: 'recording', file: entry.file.slice('recordings/'.length) };
  }
  // Path that exists in the bundle? It came from a bundled clone.
  if (fs.existsSync(path.join(bundledSoundsRoot(), entry.file))) {
    return { ...entry, source: 'bundled' };
  }
  return { ...entry, source: 'user' };
}

function readUserPacks(): PackEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(userPacksFile(), 'utf8')) as PackEntry[];
    return raw.map(p => {
      const keys: Record<string, SoundEntry> = {};
      for (const [k, e] of Object.entries(p.keys)) keys[k] = inferEntrySource(e);
      return { ...p, keys, origin: 'user' };
    });
  } catch {
    return [];
  }
}

function writeUserPacks(packs: PackEntry[]): void {
  ensureUserDirs();
  // Strip the transient `origin` tag before persisting; entry-level `source`
  // is intentionally kept on disk so we don't have to re-infer next read.
  const clean = packs.map(({ origin: _ignored, ...rest }) => rest);
  fs.writeFileSync(userPacksFile(), JSON.stringify(clean, null, 2));
}

/** Merged view: bundled first, then user — user packs override bundled on id. */
function readPacks(): PackEntry[] {
  const bundled = readBundledPacks();
  const user    = readUserPacks();
  const byId    = new Map<string, PackEntry>();
  for (const p of bundled) byId.set(p.id, p);
  for (const p of user)    byId.set(p.id, p);
  return [...byId.values()];
}

/** Resolve an entry to its absolute path on disk based on per-entry source. */
function resolveEntryPath(entry: SoundEntry): string {
  switch (entry.source) {
    case 'recording': return path.join(userRecordingsDir(), entry.file);
    case 'user':      return path.join(userSoundsDir(),     entry.file);
    case 'bundled':
    default:          return path.join(bundledSoundsRoot(), entry.file);
  }
}

function upsertUserCustomSound(key: string, label: string, relFile: string): void {
  const userPacks = readUserPacks();
  let custom = userPacks.find(p => p.id === 'custom');
  if (!custom) {
    custom = {
      id: 'custom', name: 'My Sounds', description: 'Custom sounds',
      keys: {}, origin: 'user',
    };
    userPacks.push(custom);
  }
  custom.keys[key] = { label, file: relFile, source: 'user' };
  writeUserPacks(userPacks);
}

function refreshBoardIfActivePackIs(packId: string): void {
  if (settings.get<string>('activePack', 'classics') === packId) {
    boardWin?.webContents.send('pack-selected', packId);
  }
}

// ── YouTube IPC ────────────────────────────────────────────────────────────
//
// All four yt-* handlers delegate to src/main/youtube.ts. The library-* paths
// below (Task 6) still call youtube.cacheDir/cacheKey/prepareClip/preparePack
// directly when they need to promote a previously-prepared clip.

ipcMain.handle('yt-info',             (_e, url: string)                  => youtube.getInfo(url));
ipcMain.handle('yt-detect-snippets',  (_e, url: string)                  => youtube.detectSnippets(url));
ipcMain.handle('yt-prepare-clip',     (_e, opts: youtube.PrepareClipOpts) => youtube.prepareClip(opts));
ipcMain.handle('yt-prepare-pack',     (_e, opts: youtube.PreparePackOpts) => youtube.preparePack(opts));

/**
 * Promote a previously-prepared clip into the library inventory. Idempotent
 * for repeated clicks: copies the cache file into the library dir under a
 * stable name and registers the metadata. Caller should pass `cachePath`
 * from yt-prepare-clip.
 */
ipcMain.handle('library-add-from-clip', async (_e, opts: {
  cachePath: string; name: string; sourceUrl?: string; durationMs?: number;
}) => {
  const { cachePath, name, sourceUrl, durationMs } = opts;
  if (!fs.existsSync(cachePath)) {
    return { ok: false, error: 'Clip cache is gone — click Preview again to redownload.' };
  }

  ensureUserDirs();
  const id       = `yt_${Date.now()}`;
  const safeName = slugify(name, 'clip');
  const baseName = `${safeName}-${id}.mp3`;
  const outFile  = path.join(userRecordingsDir(), baseName);
  try {
    fs.copyFileSync(cachePath, outFile);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const meta: recording.RecordingMeta = {
    id, name: name.trim() || 'Clip',
    file: baseName,
    createdAt: new Date().toISOString(),
    durationMs,
    kind: 'youtube',
    sourceUrl,
  };
  recording.add(meta);

  boardWin?.webContents.send('recordings-changed');
  childWin?.webContents.send('recordings-changed');

  return { ok: true, item: { ...meta, url: pathToFileURL(outFile).href } };
});

interface CreatePackClip {
  cachePath:  string;
  title:      string;
  durationMs: number;
}
interface CreatePackOpts {
  url:        string;
  packName:   string;
  clips:      CreatePackClip[];
}

/**
 * Atomically (with rollback) create a new user pack from prepared clip
 * cache files. Steps:
 *   1. for each clip: copy cachePath → userSoundsDir()/custom/yt-<id>.mp3
 *   2. write user packs.json with the new pack entry
 *   3. emit packs-changed
 * On any step-1 failure, deletes already-copied files and returns error.
 * On step-2 failure, deletes ALL step-1 files. packs.json is written last
 * so a crash between 1 and 2 leaks orphaned mp3s rather than leaving a
 * pack referencing missing files.
 *
 * Defensive cap: rejects > 15 clips (keyboard layout cap).
 */
ipcMain.handle('library-create-pack-from-clips', async (_e, opts: CreatePackOpts) => {
  const { url, packName, clips } = opts;
  if (clips.length === 0) {
    return { ok: false, error: 'No clips selected.' };
  }
  if (clips.length > youtube.MAX_KEYS) {
    return { ok: false, error: `Too many clips (max ${youtube.MAX_KEYS}).` };
  }

  ensureUserDirs();
  const customDir = customSoundsDir();

  const userPacks  = readUserPacks();
  const existing   = userPacks.map(p => p.name);
  const { finalName, packId } = slugifyPackName(packName, existing);

  // Step 1 — copy each clip into custom/yt-<id>.mp3
  const copied: string[] = [];
  const keyMap = youtube.mapSnippetsToKeys(clips);
  const packKeys: Record<string, { label: string; file: string; source: 'user' }> = {};

  try {
    for (const km of keyMap.mapped) {
      const clip   = km.snippet as CreatePackClip;
      const id     = `yt_${Date.now()}_${km.key}`;
      const file   = `yt-${id}.mp3`;
      const dest   = path.join(customDir, file);
      fs.copyFileSync(clip.cachePath, dest);
      copied.push(dest);
      packKeys[km.key] = {
        label:  clip.title,
        file:   `custom/${file}`,
        source: 'user',
      };
    }
  } catch (e) {
    for (const p of copied) { try { fs.unlinkSync(p); } catch {} }
    return { ok: false, error: (e as Error).message };
  }

  // Step 2 — append to user packs.json
  try {
    const newPack = {
      id: packId,
      name: finalName,
      description: `Imported from YouTube`,
      keys: packKeys,
      origin: 'user' as const,
      sourceUrl: url,
    };
    userPacks.push(newPack);
    writeUserPacks(userPacks);
  } catch (e) {
    for (const p of copied) { try { fs.unlinkSync(p); } catch {} }
    return { ok: false, error: (e as Error).message };
  }

  // Step 3 — notify
  boardWin?.webContents.send('packs-changed');
  childWin?.webContents.send('packs-changed');

  return {
    ok: true,
    packId,
    finalName,
    keysAssigned: keyMap.mapped.length,
  };
});

// ── Voice recording / library inventory ────────────────────────────────────
//
// CRUD for the recordings inventory now lives in src/main/recording.ts. The
// IPC handlers are wired below; library-add-from-clip + library-create-pack-
// from-clips (above) still live here pending Task 6 but go through
// recording.add() and youtube.* respectively.

ipcMain.handle('recording-save', (_e, opts) => recording.save(opts));
ipcMain.handle('recording-list', () => recording.list());

/**
 * Create a brand-new empty user pack. Generates a unique id from the name if
 * none was supplied. Used by the "+ New Pack" UI in packs.html.
 */
ipcMain.handle('pack-create', (_e, opts: { name: string; description?: string; id?: string }) => {
  const name = (opts?.name || '').trim();
  if (!name) return { ok: false, error: 'Name is required' };

  const merged    = readPacks();
  const baseId    = opts.id?.trim() || slugify(name, 'pack');
  let finalId     = baseId;
  let n           = 1;
  while (merged.some(p => p.id === finalId)) { n++; finalId = `${baseId}-${n}`; }

  const userPacks = readUserPacks();
  userPacks.push({
    id:          finalId,
    name,
    description: (opts.description || '').trim() || 'My pack',
    keys:        {},
    origin:      'user',
  });
  writeUserPacks(userPacks);

  boardWin?.webContents.send('packs-changed');
  childWin?.webContents.send('packs-changed');

  return { ok: true, id: finalId, name };
});

/**
 * Delete a user-owned pack. Bundled packs cannot be deleted (they're shipped
 * with the app). If the active pack is the one being deleted, the board
 * falls back to 'classics'.
 */
ipcMain.handle('pack-delete', (_e, packId: string) => {
  if (!packId) return { ok: false, error: 'Missing pack id' };
  const userPacks = readUserPacks();
  const idx       = userPacks.findIndex(p => p.id === packId);
  if (idx < 0) return { ok: false, error: 'Pack not found in user storage (built-in packs cannot be deleted)' };

  userPacks.splice(idx, 1);
  writeUserPacks(userPacks);

  if (settings.get<string>('activePack', 'classics') === packId) {
    settings.save('activePack', 'classics');
    boardWin?.webContents.send('pack-selected', 'classics');
  }
  boardWin?.webContents.send('packs-changed');
  childWin?.webContents.send('packs-changed');
  return { ok: true };
});

ipcMain.handle('recording-delete', (_e, id: string) => recording.remove(id));
ipcMain.handle('recording-rename', (_e, id: string, name: string) => recording.rename(id, name));

/**
 * Bind a library item (recording or YouTube clip) to a pack/key. If the
 * target pack is bundled, we clone it into user storage but **preserve each
 * cloned entry's `source: 'bundled'` tag** — that way the bundled audio still
 * resolves from the bundle. Only the new entry we just bound points at the
 * user's recordings dir.
 */
ipcMain.handle('pack-bind-sound', (_e, opts: {
  packId: string; key: string; recordingId?: string; label?: string;
}) => {
  const { packId, key, recordingId, label } = opts;
  if (!/^[a-z]$/.test(key)) return { ok: false, error: 'Invalid key' };

  const recordings = recordingId ? recording.readAll() : [];
  const rec        = recordingId ? recordings.find(r => r.id === recordingId) : null;
  if (recordingId && !rec) return { ok: false, error: 'Recording not found' };

  const userPacks = readUserPacks();
  let target = userPacks.find(p => p.id === packId);

  if (!target) {
    const bundled = readBundledPacks().find(p => p.id === packId);
    if (bundled) {
      // Deep-copy entries with their original source tag intact.
      const keys: Record<string, SoundEntry> = {};
      for (const [k, e] of Object.entries(bundled.keys)) keys[k] = { ...e };
      target = { id: bundled.id, name: bundled.name, description: bundled.description, keys, origin: 'user' };
    } else {
      target = { id: packId, name: packId, description: '', keys: {}, origin: 'user' };
    }
    userPacks.push(target);
  }

  if (rec) {
    target.keys[key] = { label: label || rec.name, file: rec.file, source: 'recording' };
  } else {
    delete target.keys[key];
  }
  writeUserPacks(userPacks);
  refreshBoardIfActivePackIs(packId);
  return { ok: true };
});

ipcMain.handle('pack-unbind-key', (_e, packId: string, key: string) => {
  if (!/^[a-z]$/.test(key)) return { ok: false, error: 'Invalid key' };

  const userPacks = readUserPacks();
  let target = userPacks.find(x => x.id === packId);

  // Clone-on-write for bundled packs — mirrors pack-bind-sound so clearing a
  // pad on Classics works the same as overwriting one (creates a user-side
  // override of the bundled pack with the cleared entry removed).
  if (!target) {
    const bundled = readBundledPacks().find(p => p.id === packId);
    if (!bundled) return { ok: false, error: 'Pack not found' };
    const keys: Record<string, SoundEntry> = {};
    for (const [k, e] of Object.entries(bundled.keys)) keys[k] = { ...e };
    target = { id: bundled.id, name: bundled.name, description: bundled.description, keys, origin: 'user' };
    userPacks.push(target);
  }

  if (!(key in target.keys)) return { ok: true, changed: false };

  delete target.keys[key];
  writeUserPacks(userPacks);
  refreshBoardIfActivePackIs(packId);
  return { ok: true, changed: true };
});

/** Returns merged packs with each entry's `url` resolved to a playable file://. */
ipcMain.handle('get-packs', () => {
  const packs = readPacks();
  return packs.map(p => {
    const keys: Record<string, SoundEntry & { url: string }> = {};
    for (const [k, e] of Object.entries(p.keys)) {
      keys[k] = { ...e, url: pathToFileURL(resolveEntryPath(e)).href };
    }
    return { id: p.id, name: p.name, description: p.description, origin: p.origin, keys };
  });
});

// ── Pack export/import (.mbpack — zip-shadowed format) ──────────────────────
//
// .mbpack file structure:
//   manifest.json           — { mbpackVersion, id, name, description, keys, exportedAt }
//   sounds/<basename>.mp3   — each referenced audio file, flat
//
// Built and read with system zip/unzip. No JS dependencies.

const MBPACK_VERSION = 1;

interface PackManifest {
  mbpackVersion: number;
  id:            string;
  name:          string;
  description:   string;
  keys:          Record<string, { label: string; file: string }>;
  exportedAt?:   string;
}

ipcMain.handle('pack-export', async (_e, packId: string) => {
  const pack = readPacks().find(p => p.id === packId);
  if (!pack) return { ok: false, error: `Pack '${packId}' not found` };

  const win = childWin && !childWin.isDestroyed() ? childWin : boardWin!;
  const dlg = await dialog.showSaveDialog(win, {
    title:       'Export Pack',
    defaultPath: `${pack.id}.mbpack`,
    filters:     [{ name: 'MeetingBoost Pack', extensions: ['mbpack'] }],
  });
  if (dlg.canceled || !dlg.filePath) return { ok: false, error: 'Cancelled' };

  const stagingDir = path.join(app.getPath('temp'), `mb_export_${Date.now()}`);
  const stagingSnd = path.join(stagingDir, 'sounds');
  fs.mkdirSync(stagingSnd, { recursive: true });

  try {
    const exportedKeys: PackManifest['keys'] = {};

    for (const [key, entry] of Object.entries(pack.keys)) {
      const src = resolveEntryPath(entry);
      if (!fs.existsSync(src)) continue;
      const base = path.basename(src);
      fs.copyFileSync(src, path.join(stagingSnd, base));
      exportedKeys[key] = { label: entry.label, file: `sounds/${base}` };
    }

    const manifest: PackManifest = {
      mbpackVersion: MBPACK_VERSION,
      id:            pack.id,
      name:          pack.name,
      description:   pack.description,
      keys:          exportedKeys,
      exportedAt:    new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(stagingDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    // Remove an existing target — `zip` would otherwise update in place
    try { fs.unlinkSync(dlg.filePath); } catch {}
    await spawnPromise('zip', ['-r', '-q', dlg.filePath, 'manifest.json', 'sounds'],
      { cwd: stagingDir });

    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: true, file: dlg.filePath, soundCount: Object.keys(exportedKeys).length };
  } catch (e) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle('pack-import', async () => {
  const win = childWin && !childWin.isDestroyed() ? childWin : boardWin!;
  const dlg = await dialog.showOpenDialog(win, {
    title:      'Import Pack',
    filters:    [{ name: 'MeetingBoost Pack', extensions: ['mbpack'] }],
    properties: ['openFile'],
  });
  if (dlg.canceled || !dlg.filePaths?.[0]) return { ok: false, error: 'Cancelled' };

  const archive    = dlg.filePaths[0];
  const stagingDir = path.join(app.getPath('temp'), `mb_import_${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    await spawnPromise('unzip', ['-o', '-q', archive, '-d', stagingDir]);

    const manifestPath = path.join(stagingDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Not a valid .mbpack — manifest.json missing');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackManifest;
    if (!manifest.id || !manifest.keys) {
      throw new Error('Not a valid .mbpack — manifest is malformed');
    }
    if (manifest.mbpackVersion && manifest.mbpackVersion > MBPACK_VERSION) {
      throw new Error(`Pack format v${manifest.mbpackVersion} is newer than this build (v${MBPACK_VERSION})`);
    }

    // Resolve a non-colliding pack id
    const packs = readPacks();
    let finalId = manifest.id;
    let n = 1;
    while (packs.some(p => p.id === finalId)) { n++; finalId = `${manifest.id}-${n}`; }

    // Imported packs always become user-owned content under userData/sounds/.
    const destDir = path.join(userSoundsDir(), finalId);
    fs.mkdirSync(destDir, { recursive: true });

    const newKeys: Record<string, SoundEntry> = {};
    let copied = 0;
    for (const [key, entry] of Object.entries(manifest.keys)) {
      const src = path.join(stagingDir, entry.file);
      if (!fs.existsSync(src)) continue;
      const base = path.basename(entry.file);
      fs.copyFileSync(src, path.join(destDir, base));
      newKeys[key] = { label: entry.label, file: `${finalId}/${base}`, source: 'user' };
      copied++;
    }
    if (copied === 0) throw new Error('No sound files were found in the pack');

    const userPacks = readUserPacks();
    userPacks.push({
      id:          finalId,
      name:        n > 1 ? `${manifest.name} (${n})` : manifest.name,
      description: manifest.description || 'Imported pack',
      keys:        newKeys,
      origin:      'user',
    });
    writeUserPacks(userPacks);

    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: true, id: finalId, name: manifest.name, soundCount: copied };
  } catch (e) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, error: (e as Error).message };
  }
});

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
