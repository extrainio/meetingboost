import {
  app, BrowserWindow, ipcMain, globalShortcut,
  Tray, nativeImage, Menu, screen, session, dialog,
  systemPreferences,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { GlobalKeyboardListener } from 'node-global-key-listener';

const isDev = process.env.ELECTRON_IS_DEV === '1';
const storeFile = path.join(app.getPath('userData'), 'settings.json');

// User-writable roots — never use __dirname for these. In packaged builds,
// __dirname resolves inside app.asar (read-only); user content must live in
// app.getPath('userData').
const userRoot         = (): string => app.getPath('userData');
const userPacksFile    = (): string => path.join(userRoot(), 'packs.json');
const userSoundsDir    = (): string => path.join(userRoot(), 'sounds');
const userRecordingsDir   = (): string => path.join(userRoot(), 'recordings');
const userRecordingsFile  = (): string => path.join(userRoot(), 'recordings.json');

function ensureUserDirs(): void {
  fs.mkdirSync(userSoundsDir(),     { recursive: true });
  fs.mkdirSync(userRecordingsDir(), { recursive: true });
}

type Store = Record<string, unknown>;

function readStore(): Store {
  try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')) as Store; }
  catch { return {}; }
}
function writeStore(data: Store): void {
  try { fs.writeFileSync(storeFile, JSON.stringify(data, null, 2)); } catch {}
}
function getSetting<T>(key: string, fallback: T): T {
  return (readStore()[key] as T) ?? fallback;
}
function setSetting(key: string, val: unknown): void {
  const s = readStore(); s[key] = val; writeStore(s);
}

// ── Virtual driver detection ───────────────────────────────────────────────
//
// Mirrored in tests/test_blackhole_detection.py.

const VIRTUAL_DRIVER_RE = /BlackHole|VB-Cable|Soundflower|Loopback Audio/i;

export function isVirtualAudioDevice(name: string): boolean {
  return VIRTUAL_DRIVER_RE.test(name);
}

let boardWin: BrowserWindow | null = null;
let childWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createBoardWindow(): void {
  const saved = (readStore().boardPosition ?? {}) as { x?: number; y?: number };
  const startHidden  = getSetting('startHidden',  false);
  const windowOpacity = clamp01(getSetting<number>('windowOpacity', 100) / 100);

  boardWin = new BrowserWindow({
    width:     520,
    height:    580,
    minWidth:  520,
    maxWidth:  520,
    resizable: false,
    x: saved.x,
    y: saved.y,
    alwaysOnTop: getSetting('alwaysOnTop', true),
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
    setSetting('boardPosition', { x, y });
  });

  boardWin.on('close', (e) => {
    if (!isQuitting && getSetting('hideOnClose', true)) {
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
    alwaysOnTop: getSetting('alwaysOnTop', true),
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
ipcMain.on('set-volume',   (_e, v: number)               => setSetting('volume', v));
ipcMain.on('select-pack',  (_e, packId: string) => {
  setSetting('activePack', packId);
  boardWin?.webContents.send('pack-selected', packId);
});
ipcMain.on('save-setting', (_e, key: string, val: unknown) => {
  setSetting(key, val);
  applySettingSideEffect(key, val);
});

ipcMain.handle('get-setting',      (_e, key: string, fb: unknown) => getSetting(key, fb));
ipcMain.handle('get-all-settings', () => readStore());
ipcMain.handle('app-version',      () => app.getVersion());

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

// Write firstRun.blackholeWalkthroughSeen = true.
// Uses the flat key naming convention of the existing settings store.
// Errors are caught by writeStore() internally — fail open.
ipcMain.handle('audio-mark-walkthrough-seen', (): { ok: boolean } => {
  setSetting('firstRun.blackholeWalkthroughSeen', true);
  return { ok: true };
});

// Export the raw settings.json via Save dialog. Scope is intentionally just
// preferences (not custom packs / recordings) — those move via .mbpack.
ipcMain.handle('settings-export', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? childWin ?? boardWin ?? undefined;
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win!, {
    title:       'Export MeetingBoost settings',
    defaultPath: `meetingboost-settings-${stamp}.json`,
    filters:     [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(readStore(), null, 2));
    return { ok: true, file: res.filePath };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

// Wipe settings.json. Live windows fall back to defaults on next read; we
// re-broadcast a few effects (theme, opacity, alwaysOnTop) so the open
// windows reflect the reset without a manual reload.
ipcMain.handle('settings-reset', () => {
  try { fs.unlinkSync(storeFile); } catch {}
  for (const k of ['theme', 'windowOpacity', 'alwaysOnTop']) {
    applySettingSideEffect(k, getSetting(k, k === 'alwaysOnTop' ? true : k === 'windowOpacity' ? 100 : 'dark'));
  }
  return { ok: true };
});

ipcMain.handle('check-accessibility', () =>
  process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : true);

ipcMain.handle('request-accessibility', () => {
  if (process.platform === 'darwin') {
    // Triggers the macOS prompt — user must grant in System Settings, then restart MB
    systemPreferences.isTrustedAccessibilityClient(true);
  }
  return true;
});

// One place for all "this setting changes app behaviour at runtime" effects.
function applySettingSideEffect(key: string, val: unknown): void {
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
      const op = clamp01(Number(val) / 100);
      boardWin?.setOpacity(op);
      break;
    }
    case 'launchAtLogin':
      app.setLoginItemSettings({ openAtLogin: !!val, openAsHidden: getSetting('startHidden', false) });
      break;
    case 'startHidden':
      app.setLoginItemSettings({ openAtLogin: getSetting('launchAtLogin', false), openAsHidden: !!val });
      break;
    case 'globalCapture':
      val ? startGlobalCapture() : stopGlobalCapture();
      break;
    case 'outputDeviceId':
      boardWin?.webContents.send('output-device-changed', val);
      break;
  }
}

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

      if (getSetting('suppressRepeat', true)) {
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

// ── External-tool helpers ────────────────────────────────────────────────────

// Search PATH locations where yt-dlp / ffmpeg are commonly installed on macOS
const TOOL_PATHS = [
  '/opt/homebrew/bin', '/usr/local/bin', '/opt/miniconda3/bin',
  '/usr/bin', '/bin',
];

/**
 * Returns the absolute path to the ffmpeg binary bundled via `ffmpeg-static`.
 * In packaged builds the file lives inside `app.asar.unpacked` (we configure
 * electron-builder to unpack node_modules/ffmpeg-static, since asar contents
 * cannot be exec'd). The npm package returns the in-asar path at require time;
 * we patch it to the unpacked location at runtime.
 */
function bundledFfmpeg(): string | null {
  if (!ffmpegStatic) return null;
  const patched = (ffmpegStatic as string).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  return fs.existsSync(patched) ? patched : null;
}

function findBin(name: string): string {
  if (name === 'ffmpeg') {
    const bundled = bundledFfmpeg();
    if (bundled) return bundled;
  }
  for (const dir of TOOL_PATHS) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return name; // fall back to PATH lookup
}

function spawnPromise(
  bin: string, args: string[],
  opts: { capture?: boolean; cwd?: string } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, opts.cwd ? { cwd: opts.cwd } : {});
    let out = '';
    let err = '';
    if (opts.capture) proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer)  => { err += d.toString(); });
    // Without an 'error' handler, missing binaries (ENOENT) silently leave the
    // promise pending — that was the "Saving…" hang in packaged builds.
    proc.on('error', (e) => {
      const msg = (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Required tool '${path.basename(bin)}' was not found. Install it and retry.`
        : (e as Error).message;
      reject(new Error(msg));
    });
    proc.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.slice(0, 400) || `exit ${code}`))
    );
  });
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
// Pure functions used by yt-detect-snippets / yt-prepare-pack / library-
// create-pack-from-clips. Mirrored in tests/test_youtube_pack.py — note the
// Python mirror uses snake_case keys (overflow_count) per Python convention;
// these helpers' return shapes are not part of any IPC contract.

const MIN_SNIPPET_SEC = 0.3;
const MAX_SNIPPET_SEC_AUTOCHECK = 30.0;
const MAX_KEYS = 15;
const KEY_ORDER = ['q','w','e','r','t','a','s','d','f','g','z','x','c','v','b'];

interface RawChapter { title: string; start: number; end: number; }
interface FilteredSnippet {
  title: string; start: number; end: number; dur: number;
  autoCheck: boolean; reason: 'too_long' | null;
}

export function filterSnippets(chapters: RawChapter[]): FilteredSnippet[] {
  const out: FilteredSnippet[] = [];
  for (const ch of chapters) {
    const dur = ch.end - ch.start;
    if (dur < MIN_SNIPPET_SEC) continue;
    const tooLong = dur > MAX_SNIPPET_SEC_AUTOCHECK;
    out.push({
      title: ch.title,
      start: ch.start,
      end: ch.end,
      dur,
      autoCheck: !tooLong,
      reason: tooLong ? 'too_long' : null,
    });
  }
  return out;
}

interface KeyAssignment<T> { snippet: T; key: string; }

export function mapSnippetsToKeys<T>(
  snippets: T[]
): { mapped: KeyAssignment<T>[]; overflowCount: number } {
  const mapped: KeyAssignment<T>[] = [];
  for (let i = 0; i < Math.min(snippets.length, MAX_KEYS); i++) {
    mapped.push({ snippet: snippets[i], key: KEY_ORDER[i] });
  }
  return {
    mapped,
    overflowCount: Math.max(0, snippets.length - MAX_KEYS),
  };
}

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

interface DetectMeta { title: string; thumbnail: string; duration?: number; }

interface PlaylistItem { videoId: string; title: string; duration?: number; }
interface ChapterItem  { title: string; start: number; end: number; }

type DetectResult =
  | { kind: 'playlist';  items:    PlaylistItem[]; meta: DetectMeta }
  | { kind: 'chapters';  chapters: ChapterItem[];  meta: DetectMeta }
  | { kind: 'none';      meta: DetectMeta };

export function classifyDetectResult(raw: Record<string, unknown>): DetectResult {
  const meta: DetectMeta = {
    title:     (raw.title as string)     ?? '',
    thumbnail: (raw.thumbnail as string) ?? '',
    duration:  raw.duration as number | undefined,
  };

  if (raw._type === 'playlist' && Array.isArray(raw.entries) && raw.entries.length > 0) {
    const items: PlaylistItem[] = (raw.entries as Record<string, unknown>[]).map(e => ({
      videoId:  (e.id as string)    ?? '',
      title:    (e.title as string) ?? '',
      duration: e.duration as number | undefined,
    }));
    return { kind: 'playlist', items, meta };
  }

  const chapters = raw.chapters;
  if (Array.isArray(chapters) && chapters.length > 0) {
    const out: ChapterItem[] = (chapters as Record<string, unknown>[]).map(c => ({
      title: (c.title as string) ?? 'Untitled',
      start: Number(c.start_time ?? 0),
      end:   Number(c.end_time ?? 0),
    }));
    return { kind: 'chapters', chapters: out, meta };
  }

  return { kind: 'none', meta };
}

function bundledPacksFile(): string {
  return path.join(__dirname, 'src', 'packs.json');
}
function bundledSoundsRoot(): string {
  return path.join(__dirname, 'src', 'sounds');
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
  if (getSetting<string>('activePack', 'classics') === packId) {
    boardWin?.webContents.send('pack-selected', packId);
  }
}

function customSoundsDir(): string {
  const dir = path.join(userSoundsDir(), 'custom');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('yt-info', async (_e, url: string) => {
  try {
    const ytdlp = findBin('yt-dlp');
    const raw   = await spawnPromise(ytdlp, ['--dump-json', '--no-playlist', url], { capture: true });
    const info  = JSON.parse(raw) as Record<string, unknown>;
    return {
      ok:        true,
      title:     info.title     as string,
      duration:  info.duration  as number,
      thumbnail: info.thumbnail as string,
      uploader:  (info.uploader ?? info.channel ?? 'Unknown') as string,
      videoId:   info.id        as string,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

/**
 * Detect what kind of source the URL points to: a playlist (multiple videos),
 * a single video with chapters, or a single video without chapters.
 *
 * One yt-dlp call per URL. Caller (renderer) decides what to do with each
 * shape — for 'none' we route the user to the existing single-clip flow.
 */
ipcMain.handle('yt-detect-snippets', async (_e, url: string) => {
  try {
    const ytdlp = findBin('yt-dlp');

    // For URLs with list= we want playlist info; for plain video URLs we
    // want chapters. yt-dlp behavior:
    //   --no-playlist → ignores list=, returns single-video json
    //   --flat-playlist → playlist wrapper with thin entries[]
    const isPlaylist = /[?&]list=/.test(url);
    const args = isPlaylist
      ? ['--dump-single-json', '--flat-playlist', url]
      : ['--dump-single-json', '--no-playlist',   url];

    const raw = await spawnPromise(ytdlp, args, { capture: true });
    const json = JSON.parse(raw) as Record<string, unknown>;
    const result = classifyDetectResult(json);

    return { ok: true, result };
  } catch (e) {
    const msg = (e as Error).message;
    let friendly = msg;
    if (/Private video/i.test(msg))             friendly = 'This video is private.';
    else if (/age-?restrict|Sign in to confirm your age/i.test(msg))
                                                friendly = 'Age-restricted video — yt-dlp cannot fetch it.';
    else if (/HTTP Error 429/.test(msg))        friendly = 'YouTube rate-limited — try again in a minute.';
    else if (/Video unavailable/i.test(msg))    friendly = 'Video unavailable.';

    return { ok: false, error: friendly };
  }
});

interface PrepareClipOpts {
  url:    string;
  start:  number;   // seconds
  end:    number;   // seconds
}

/**
 * Download a YouTube source as a temp mp3. Returns the temp file path.
 * Caller is responsible for unlinking the temp file when done. Used by
 * yt-prepare-clip (single-cut) and yt-prepare-pack (multi-cut).
 */
async function downloadSourceMp3(url: string): Promise<string> {
  const tmpPath = path.join(app.getPath('temp'), `mb_yt_${Date.now()}.%(ext)s`);
  const tmpMp3  = tmpPath.replace('%(ext)s', 'mp3');
  const ytdlp   = findBin('yt-dlp');
  await spawnPromise(ytdlp, [
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--no-playlist', '-o', tmpPath, url,
  ]);
  return tmpMp3;
}

/**
 * Download + ffmpeg-cut a YouTube excerpt into the cache, returning a playable
 * file:// URL. Cached by (url, start, end) so a Preview click followed by
 * "+ Add to Library" doesn't re-download — the cached file just gets moved.
 */
ipcMain.handle('yt-prepare-clip', async (_e, opts: PrepareClipOpts) => {
  const { url, start, end } = opts;
  if (end <= start) return { ok: false, error: 'End time must be after start time' };

  const duration = Math.max(0.1, end - start);
  const cacheKey = ytCacheKey(url, start, end);
  const outFile  = path.join(ytCacheDir(), `${cacheKey}.mp3`);

  if (fs.existsSync(outFile)) {
    return { ok: true, cachePath: outFile, url: pathToFileURL(outFile).href, cached: true };
  }

  let tmpMp3: string | null = null;
  try {
    tmpMp3 = await downloadSourceMp3(url);
    const ffmpeg = findBin('ffmpeg');

    await spawnPromise(ffmpeg, [
      '-y', '-ss', String(start), '-t', String(duration),
      '-i', tmpMp3, '-acodec', 'libmp3lame', '-q:a', '2', outFile,
    ]);
    if (tmpMp3) { try { fs.unlinkSync(tmpMp3); } catch {} }

    return { ok: true, cachePath: outFile, url: pathToFileURL(outFile).href, cached: false };
  } catch (e) {
    if (tmpMp3) { try { fs.unlinkSync(tmpMp3); } catch {} }
    try { fs.unlinkSync(outFile); } catch {}
    return { ok: false, error: (e as Error).message };
  }
});

interface PreparePackSegment { title: string; start: number; end: number; }
interface PreparePackOpts    { url: string; segments: PreparePackSegment[]; }

/**
 * Bulk-prepare N snippets from one YouTube source. Downloads the source
 * mp3 once (or skips the download entirely if every requested segment is
 * already cached), then ffmpeg-cuts each segment into the same .cache/yt/
 * directory that yt-prepare-clip uses. Cache key matches: ytCacheKey(url,
 * start, end). Repeated invocations with overlapping segments are free.
 *
 * Partial failure tolerated: a failed cut is reported in `failed[]`; the
 * remaining cuts still complete. Caller decides whether to retry the
 * failures or proceed without them.
 *
 * Defensive caps: rejects > 100 segments or any segment outside [0.1, 60]s.
 */
ipcMain.handle('yt-prepare-pack', async (_e, opts: PreparePackOpts) => {
  const { url, segments } = opts;

  if (segments.length > 100) {
    return { ok: false, error: 'Too many segments (max 100).' };
  }

  // Per-segment duration is validated below in the cut loop and pushed to
  // failed[] rather than rejecting the whole batch — playlist mode in the
  // renderer cannot know exact video durations up-front.

  const cacheDir = ytCacheDir();
  const planned = segments.map(s => {
    const key       = ytCacheKey(url, s.start, s.end);
    const cachePath = path.join(cacheDir, `${key}.mp3`);
    return { ...s, cachePath, cached: fs.existsSync(cachePath) };
  });

  const needsCut = planned.filter(p => !p.cached);
  let tmpMp3: string | null = null;
  const prepared: { title: string; cachePath: string; durationMs: number }[] = [];
  const failed:   { title: string; error: string }[] = [];

  try {
    if (needsCut.length > 0) {
      tmpMp3 = await downloadSourceMp3(url);
    }

    const ffmpeg = findBin('ffmpeg');
    for (const p of planned) {
      const dur = p.end - p.start;
      if (dur < 0.1 || dur > 60) {
        failed.push({ title: p.title, error: `Invalid duration (${dur.toFixed(2)}s) — must be 0.1–60s.` });
        continue;
      }
      if (p.cached) {
        prepared.push({
          title: p.title, cachePath: p.cachePath,
          durationMs: Math.round((p.end - p.start) * 1000),
        });
        continue;
      }
      try {
        await spawnPromise(ffmpeg, [
          '-y', '-ss', String(p.start), '-t', String(p.end - p.start),
          '-i', tmpMp3!, '-acodec', 'libmp3lame', '-q:a', '2', p.cachePath,
        ]);
        prepared.push({
          title: p.title, cachePath: p.cachePath,
          durationMs: Math.round((p.end - p.start) * 1000),
        });
      } catch (e) {
        try { fs.unlinkSync(p.cachePath); } catch {}
        failed.push({ title: p.title, error: (e as Error).message });
      }
    }

    if (tmpMp3) { try { fs.unlinkSync(tmpMp3); } catch {} }

    return { ok: true, prepared, failed };
  } catch (e) {
    if (tmpMp3) { try { fs.unlinkSync(tmpMp3); } catch {} }
    return { ok: false, error: (e as Error).message, prepared, failed };
  }
});

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

  const meta: RecordingMeta = {
    id, name: name.trim() || 'Clip',
    file: baseName,
    createdAt: new Date().toISOString(),
    durationMs,
    kind: 'youtube',
    sourceUrl,
  };
  const list = readRecordings();
  list.unshift(meta);
  writeRecordings(list);

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
  if (clips.length > MAX_KEYS) {
    return { ok: false, error: `Too many clips (max ${MAX_KEYS}).` };
  }

  ensureUserDirs();
  const customDir = customSoundsDir();

  const userPacks  = readUserPacks();
  const existing   = userPacks.map(p => p.name);
  const { finalName, packId } = slugifyPackName(packName, existing);

  // Step 1 — copy each clip into custom/yt-<id>.mp3
  const copied: string[] = [];
  const keyMap = mapSnippetsToKeys(clips);
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

// ── Voice recording: WebM/Opus blob from renderer → MP3 in inventory ────────
//
// Recordings are saved into a flat inventory under userData/recordings without
// a key binding. Users assign them to a pack/key later via drag-drop. Storing
// metadata in recordings.json keeps file names slug-collision-safe and lets
// us track display name + creation time.

/**
 * Library inventory — anything the user has captured or downloaded that isn't
 * yet bound to a pack key. `kind` distinguishes mic recordings from YouTube
 * clips; the dir + json file are shared so the renderer sees one unified list.
 */
interface RecordingMeta {
  id:          string;
  name:        string;
  file:        string;       // basename inside userData/recordings/
  createdAt:   string;
  durationMs?: number;
  kind?:       'mic' | 'youtube';
  sourceUrl?:  string;       // original URL for youtube clips
}

function readRecordings(): RecordingMeta[] {
  try {
    const raw = JSON.parse(fs.readFileSync(userRecordingsFile(), 'utf8')) as RecordingMeta[];
    // Old entries without kind default to 'mic' — the only kind that existed before.
    return raw.map(r => ({ kind: 'mic', ...r }));
  } catch { return []; }
}
function writeRecordings(list: RecordingMeta[]): void {
  ensureUserDirs();
  fs.writeFileSync(userRecordingsFile(), JSON.stringify(list, null, 2));
}

// ── YouTube clip cache ─────────────────────────────────────────────────────
//
// Preview-then-add flow: a Preview click downloads + cuts the excerpt into
// userData/.cache/yt/<hash>.mp3, keyed by url+start+end so repeated previews
// are instant and "+ Add to Library" doesn't re-download. Cached file gets
// moved into the library on add, and old cache files are cleaned up lazily.

function ytCacheDir(): string {
  const d = path.join(userRoot(), '.cache', 'yt');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function ytCacheKey(url: string, start: number, end: number): string {
  // crypto.createHash would be ideal but we don't need cryptographic strength.
  let h = 0;
  const str = `${url}|${start}|${end}`;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

interface RecordSaveOpts {
  name:   string;
  buffer: Uint8Array;   // WebM/Opus payload from MediaRecorder
  durationMs?: number;
}

ipcMain.handle('recording-save', async (_e, opts: RecordSaveOpts) => {
  const { name, buffer, durationMs } = opts;
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'Empty recording — try again.' };
  }

  ensureUserDirs();
  const id       = `rec_${Date.now()}`;
  const safeName = slugify(name, 'recording');
  const baseName = `${safeName}-${id}.mp3`;
  const outFile  = path.join(userRecordingsDir(), baseName);
  const tmpWebm  = path.join(app.getPath('temp'), `mb_rec_${Date.now()}.webm`);

  try {
    fs.writeFileSync(tmpWebm, Buffer.from(buffer));

    const ffmpeg = findBin('ffmpeg');
    await spawnPromise(ffmpeg, [
      '-y', '-i', tmpWebm,
      '-acodec', 'libmp3lame', '-q:a', '2',
      outFile,
    ]);

    try { fs.unlinkSync(tmpWebm); } catch {}

    const meta: RecordingMeta = {
      id, name: name.trim() || 'Recording',
      file: baseName,
      createdAt: new Date().toISOString(),
      durationMs,
    };
    const list = readRecordings();
    list.unshift(meta);
    writeRecordings(list);

    boardWin?.webContents.send('recordings-changed');
    childWin?.webContents.send('recordings-changed');

    return { ok: true, recording: { ...meta, url: pathToFileURL(outFile).href } };
  } catch (e) {
    try { fs.unlinkSync(tmpWebm); } catch {}
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle('recording-list', () => {
  const list = readRecordings();
  return list.map(m => ({
    ...m,
    kind: m.kind ?? 'mic',
    url:  pathToFileURL(path.join(userRecordingsDir(), m.file)).href,
  }));
});

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

  if (getSetting<string>('activePack', 'classics') === packId) {
    setSetting('activePack', 'classics');
    boardWin?.webContents.send('pack-selected', 'classics');
  }
  boardWin?.webContents.send('packs-changed');
  childWin?.webContents.send('packs-changed');
  return { ok: true };
});

ipcMain.handle('recording-delete', (_e, id: string) => {
  const list = readRecordings();
  const idx  = list.findIndex(r => r.id === id);
  if (idx < 0) return { ok: false, error: 'Recording not found' };

  // Detach from any user packs first so the board doesn't hold a dead path.
  const packs   = readUserPacks();
  const target  = list[idx].file;
  let changed   = false;
  for (const p of packs) {
    for (const k of Object.keys(p.keys)) {
      const e = p.keys[k];
      if (e.source === 'recording' && e.file === target) {
        delete p.keys[k];
        changed = true;
      }
    }
  }
  if (changed) writeUserPacks(packs);

  try { fs.unlinkSync(path.join(userRecordingsDir(), target)); } catch {}
  list.splice(idx, 1);
  writeRecordings(list);

  boardWin?.webContents.send('recordings-changed');
  childWin?.webContents.send('recordings-changed');
  if (changed) refreshBoardIfActivePackIs(getSetting('activePack', 'classics'));
  return { ok: true };
});

ipcMain.handle('recording-rename', (_e, id: string, name: string) => {
  const list = readRecordings();
  const r    = list.find(x => x.id === id);
  if (!r) return { ok: false, error: 'Recording not found' };
  r.name = name.trim() || r.name;
  writeRecordings(list);
  boardWin?.webContents.send('recordings-changed');
  childWin?.webContents.send('recordings-changed');
  return { ok: true };
});

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

  const recordings = recordingId ? readRecordings() : [];
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
  createTray();

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

  globalShortcut.register('Alt+Shift+M', () => {
    boardWin!.isVisible() ? boardWin!.hide() : (boardWin!.show(), boardWin!.focus());
  });

  // Restore persisted runtime state
  if (getSetting('globalCapture', false)) startGlobalCapture();

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
