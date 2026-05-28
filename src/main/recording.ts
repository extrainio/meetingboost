import { app, type BrowserWindow as BrowserWindowType } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  userRecordingsDir, userRecordingsFile,
  ensureUserDirs,
} from './paths.js';
import { findBin, spawnPromise } from './tools.js';
import * as settings from './settings.js';

// ── Voice recording inventory ──────────────────────────────────────────────
//
// Library inventory — anything the user has captured or downloaded that isn't
// yet bound to a pack key. `kind` distinguishes mic recordings from YouTube
// clips; the dir + json file are shared so the renderer sees one unified list.

export interface RecordingMeta {
  id:          string;
  name:        string;
  file:        string;       // basename inside userData/recordings/
  createdAt:   string;
  durationMs?: number;
  kind?:       'mic' | 'youtube';
  sourceUrl?:  string;       // original URL for youtube clips
}

interface RecordSaveOpts {
  name:   string;
  buffer: Uint8Array;   // WebM/Opus payload from MediaRecorder
  durationMs?: number;
}

// Pack-level types — kept structural so we don't pull main.ts's full type set
// into this module. Mirrors `SoundEntry` / `PackEntry` from main.ts.
type EntrySource = 'bundled' | 'user' | 'recording';
interface SoundEntry {
  label:   string;
  file:    string;
  source?: EntrySource;
}
interface PackEntry {
  id:          string;
  name:        string;
  description: string;
  keys:        Record<string, SoundEntry>;
  origin?: 'bundled' | 'user';
}

// ── DI ─────────────────────────────────────────────────────────────────────
//
// Window getters mirror Task 2's settings.ts pattern: main.ts re-assigns its
// boardWin/childWin lets during the lifecycle, so we read via getters to
// always see the current value. readUserPacks / writeUserPacks /
// refreshBoardIfActivePackIs are still owned by main.ts (slated for Task 6
// packs.ts) — inject them rather than circular-import.

interface RecordingDeps {
  getBoardWin: () => BrowserWindowType | null;
  getChildWin: () => BrowserWindowType | null;
  readUserPacks: () => PackEntry[];
  writeUserPacks: (packs: PackEntry[]) => void;
  refreshBoardIfActivePackIs: (packId: string) => void;
}

const deps: RecordingDeps = {
  getBoardWin: () => null,
  getChildWin: () => null,
  readUserPacks: () => [],
  writeUserPacks: () => {},
  refreshBoardIfActivePackIs: () => {},
};

export function configure(d: Partial<RecordingDeps>): void {
  Object.assign(deps, d);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string, fallback = 'sound'): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
}

// ── Inventory R/W ──────────────────────────────────────────────────────────

export function readAll(): RecordingMeta[] {
  try {
    const raw = JSON.parse(fs.readFileSync(userRecordingsFile(), 'utf8')) as RecordingMeta[];
    // Old entries without kind default to 'mic' — the only kind that existed before.
    return raw.map(r => ({ kind: 'mic', ...r }));
  } catch { return []; }
}

function writeAll(list: RecordingMeta[]): void {
  ensureUserDirs();
  fs.writeFileSync(userRecordingsFile(), JSON.stringify(list, null, 2));
}

/** Prepend a freshly-captured/imported meta to the inventory. Used by
 *  recording-save here and by library-add-from-clip (YouTube; Task 5) in main.ts.
 */
export function add(meta: RecordingMeta): void {
  const list = readAll();
  list.unshift(meta);
  writeAll(list);
}

/** Inventory with file:// URLs resolved — what the renderer expects from the
 *  `recording-list` IPC. */
export function list(): Array<RecordingMeta & { url: string; kind: 'mic' | 'youtube' }> {
  const items = readAll();
  return items.map(m => ({
    ...m,
    kind: m.kind ?? 'mic',
    url:  pathToFileURL(path.join(userRecordingsDir(), m.file)).href,
  }));
}

// ── IPC bodies ─────────────────────────────────────────────────────────────

export async function save(opts: RecordSaveOpts): Promise<{ ok: boolean; recording?: RecordingMeta & { url: string }; error?: string }> {
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
    const items = readAll();
    items.unshift(meta);
    writeAll(items);

    deps.getBoardWin()?.webContents.send('recordings-changed');
    deps.getChildWin()?.webContents.send('recordings-changed');

    return { ok: true, recording: { ...meta, url: pathToFileURL(outFile).href } };
  } catch (e) {
    try { fs.unlinkSync(tmpWebm); } catch {}
    return { ok: false, error: (e as Error).message };
  }
}

export function remove(id: string): { ok: boolean; error?: string } {
  const items = readAll();
  const idx  = items.findIndex(r => r.id === id);
  if (idx < 0) return { ok: false, error: 'Recording not found' };

  // Detach from any user packs first so the board doesn't hold a dead path.
  const packs   = deps.readUserPacks();
  const target  = items[idx].file;
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
  if (changed) deps.writeUserPacks(packs);

  try { fs.unlinkSync(path.join(userRecordingsDir(), target)); } catch {}
  items.splice(idx, 1);
  writeAll(items);

  deps.getBoardWin()?.webContents.send('recordings-changed');
  deps.getChildWin()?.webContents.send('recordings-changed');
  if (changed) deps.refreshBoardIfActivePackIs(settings.get('activePack', 'classics'));
  return { ok: true };
}

export function rename(id: string, name: string): { ok: boolean; error?: string } {
  const items = readAll();
  const r    = items.find(x => x.id === id);
  if (!r) return { ok: false, error: 'Recording not found' };
  r.name = name.trim() || r.name;
  writeAll(items);
  deps.getBoardWin()?.webContents.send('recordings-changed');
  deps.getChildWin()?.webContents.send('recordings-changed');
  return { ok: true };
}
