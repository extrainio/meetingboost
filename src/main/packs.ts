import { app, dialog, type BrowserWindow as BrowserWindowType } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  userPacksFile, userSoundsDir, userRecordingsDir,
  ensureUserDirs, bundledPacksFile, bundledSoundsRoot,
} from './paths.js';
import { spawnPromise } from './tools.js';
import * as settings from './settings.js';
import * as recording from './recording.js';

// ── DI ─────────────────────────────────────────────────────────────────────
//
// Window getters mirror settings.ts / recording.ts: main.ts re-assigns its
// boardWin/childWin lets during the lifecycle, so we read via getters to
// always see the current value. Used to fan out `pack-selected` and
// `packs-changed` events directly from CRUD handlers.

interface PacksDeps {
  getBoardWin: () => BrowserWindowType | null;
  getChildWin: () => BrowserWindowType | null;
}

const deps: PacksDeps = {
  getBoardWin: () => null,
  getChildWin: () => null,
};

export function configure(d: Partial<PacksDeps>): void {
  Object.assign(deps, d);
}

// ── Pack storage ─────────────────────────────────────────────────────────────
//
// Built-in packs ship inside the bundle (read-only inside app.asar). User-
// authored packs and the user's "custom" pack live in userData, which is
// always writable. readAll() merges them — user wins on id collision.
//
// Source tracking is **per entry**, not per pack. When a user binds a new
// recording into an originally-bundled pack, we clone the pack into user
// storage but every untouched entry keeps `source: 'bundled'` so its audio
// file still resolves from the bundle. Only newly-bound entries point at
// userData.

export type EntrySource = 'bundled' | 'user' | 'recording';

export interface SoundEntry {
  label:   string;
  file:    string;     // path relative to that entry's source root
  source?: EntrySource;
}

export interface PackEntry {
  id:          string;
  name:        string;
  description: string;
  keys:        Record<string, SoundEntry>;
  /** Where this pack's *metadata* lives. Set by the loader, not stored. */
  origin?: 'bundled' | 'user';
}

export function slugify(name: string, fallback = 'sound'): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
}

// ── YouTube Pack helpers ───────────────────────────────────────────────────
//
// slugifyPackName lives here because library-create-pack-from-clips uses it
// to derive a unique id+name from a user-supplied label.

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

export function tagBundledEntries(p: PackEntry): PackEntry {
  // Every entry in a bundled pack file is, by definition, a bundled asset.
  const keys: Record<string, SoundEntry> = {};
  for (const [k, e] of Object.entries(p.keys)) {
    keys[k] = { ...e, source: 'bundled' };
  }
  return { ...p, keys, origin: 'bundled' };
}

export function readBundled(): PackEntry[] {
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
export function inferEntrySource(entry: SoundEntry): SoundEntry {
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

export function readUser(): PackEntry[] {
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

export function writeUser(packs: PackEntry[]): void {
  ensureUserDirs();
  // Strip the transient `origin` tag before persisting; entry-level `source`
  // is intentionally kept on disk so we don't have to re-infer next read.
  const clean = packs.map(({ origin: _ignored, ...rest }) => rest);
  fs.writeFileSync(userPacksFile(), JSON.stringify(clean, null, 2));
}

/** Merged view: bundled first, then user — user packs override bundled on id. */
export function readAll(): PackEntry[] {
  const bundled = readBundled();
  const user    = readUser();
  const byId    = new Map<string, PackEntry>();
  for (const p of bundled) byId.set(p.id, p);
  for (const p of user)    byId.set(p.id, p);
  return [...byId.values()];
}

/** Resolve an entry to its absolute path on disk based on per-entry source. */
export function resolveEntryPath(entry: SoundEntry): string {
  switch (entry.source) {
    case 'recording': return path.join(userRecordingsDir(), entry.file);
    case 'user':      return path.join(userSoundsDir(),     entry.file);
    case 'bundled':
    default:          return path.join(bundledSoundsRoot(), entry.file);
  }
}

export function upsertUserCustomSound(key: string, label: string, relFile: string): void {
  const userPacks = readUser();
  let custom = userPacks.find(p => p.id === 'custom');
  if (!custom) {
    custom = {
      id: 'custom', name: 'My Sounds', description: 'Custom sounds',
      keys: {}, origin: 'user',
    };
    userPacks.push(custom);
  }
  custom.keys[key] = { label, file: relFile, source: 'user' };
  writeUser(userPacks);
}

/**
 * Tell the board renderer to reload the pack if the one passed in is the
 * currently-active pack. Resolves boardWin via DI getter so callers
 * (including recording.ts) don't have to thread it through every site.
 */
export function refreshBoardIfActivePackIs(packId: string): void {
  if (settings.get<string>('activePack', 'classics') === packId) {
    deps.getBoardWin()?.webContents.send('pack-selected', packId);
  }
}

// ── Pack CRUD ──────────────────────────────────────────────────────────────

/**
 * Create a brand-new empty user pack. Generates a unique id from the name if
 * none was supplied. Used by the "+ New Pack" UI in packs.html.
 */
export function create(opts: { name: string; description?: string; id?: string }): {
  ok: boolean; id?: string; name?: string; error?: string;
} {
  const name = (opts?.name || '').trim();
  if (!name) return { ok: false, error: 'Name is required' };

  const merged    = readAll();
  const baseId    = opts.id?.trim() || slugify(name, 'pack');
  let finalId     = baseId;
  let n           = 1;
  while (merged.some(p => p.id === finalId)) { n++; finalId = `${baseId}-${n}`; }

  const userPacks = readUser();
  userPacks.push({
    id:          finalId,
    name,
    description: (opts.description || '').trim() || 'My pack',
    keys:        {},
    origin:      'user',
  });
  writeUser(userPacks);

  deps.getBoardWin()?.webContents.send('packs-changed');
  deps.getChildWin()?.webContents.send('packs-changed');

  return { ok: true, id: finalId, name };
}

/**
 * Delete a user-owned pack. Bundled packs cannot be deleted (they're shipped
 * with the app). If the active pack is the one being deleted, the board
 * falls back to 'classics'.
 */
export function remove(packId: string): { ok: boolean; error?: string } {
  if (!packId) return { ok: false, error: 'Missing pack id' };
  const userPacks = readUser();
  const idx       = userPacks.findIndex(p => p.id === packId);
  if (idx < 0) return { ok: false, error: 'Pack not found in user storage (built-in packs cannot be deleted)' };

  userPacks.splice(idx, 1);
  writeUser(userPacks);

  if (settings.get<string>('activePack', 'classics') === packId) {
    settings.save('activePack', 'classics');
    deps.getBoardWin()?.webContents.send('pack-selected', 'classics');
  }
  deps.getBoardWin()?.webContents.send('packs-changed');
  deps.getChildWin()?.webContents.send('packs-changed');
  return { ok: true };
}

/**
 * Bind a library item (recording or YouTube clip) to a pack/key. If the
 * target pack is bundled, we clone it into user storage but **preserve each
 * cloned entry's `source: 'bundled'` tag** — that way the bundled audio still
 * resolves from the bundle. Only the new entry we just bound points at the
 * user's recordings dir.
 */
export function bindSound(opts: {
  packId: string; key: string; recordingId?: string; label?: string;
}): { ok: boolean; error?: string } {
  const { packId, key, recordingId, label } = opts;
  if (!/^[a-z]$/.test(key)) return { ok: false, error: 'Invalid key' };

  const recordings = recordingId ? recording.readAll() : [];
  const rec        = recordingId ? recordings.find(r => r.id === recordingId) : null;
  if (recordingId && !rec) return { ok: false, error: 'Recording not found' };

  const userPacks = readUser();
  let target = userPacks.find(p => p.id === packId);

  if (!target) {
    const bundled = readBundled().find(p => p.id === packId);
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
  writeUser(userPacks);
  refreshBoardIfActivePackIs(packId);
  return { ok: true };
}

export function unbindKey(packId: string, key: string): {
  ok: boolean; error?: string; changed?: boolean;
} {
  if (!/^[a-z]$/.test(key)) return { ok: false, error: 'Invalid key' };

  const userPacks = readUser();
  let target = userPacks.find(x => x.id === packId);

  // Clone-on-write for bundled packs — mirrors bindSound so clearing a
  // pad on Classics works the same as overwriting one (creates a user-side
  // override of the bundled pack with the cleared entry removed).
  if (!target) {
    const bundled = readBundled().find(p => p.id === packId);
    if (!bundled) return { ok: false, error: 'Pack not found' };
    const keys: Record<string, SoundEntry> = {};
    for (const [k, e] of Object.entries(bundled.keys)) keys[k] = { ...e };
    target = { id: bundled.id, name: bundled.name, description: bundled.description, keys, origin: 'user' };
    userPacks.push(target);
  }

  if (!(key in target.keys)) return { ok: true, changed: false };

  delete target.keys[key];
  writeUser(userPacks);
  refreshBoardIfActivePackIs(packId);
  return { ok: true, changed: true };
}

/** Returns merged packs with each entry's `url` resolved to a playable file://. */
export function getAll(): Array<{
  id: string; name: string; description: string;
  origin?: 'bundled' | 'user';
  keys: Record<string, SoundEntry & { url: string }>;
}> {
  const packs = readAll();
  return packs.map(p => {
    const keys: Record<string, SoundEntry & { url: string }> = {};
    for (const [k, e] of Object.entries(p.keys)) {
      keys[k] = { ...e, url: pathToFileURL(resolveEntryPath(e)).href };
    }
    return { id: p.id, name: p.name, description: p.description, origin: p.origin, keys };
  });
}

// ── Pack export/import (.mbpack — zip-shadowed format) ──────────────────────
//
// .mbpack file structure:
//   manifest.json           — { mbpackVersion, id, name, description, keys, exportedAt }
//   sounds/<basename>.mp3   — each referenced audio file, flat
//
// Built and read with system zip/unzip. No JS dependencies.

export const MBPACK_VERSION = 1;

export interface PackManifest {
  mbpackVersion: number;
  id:            string;
  name:          string;
  description:   string;
  keys:          Record<string, { label: string; file: string }>;
  exportedAt?:   string;
}

export async function exportPack(
  packId: string,
): Promise<{ ok: boolean; error?: string; file?: string; soundCount?: number }> {
  const pack = readAll().find(p => p.id === packId);
  if (!pack) return { ok: false, error: `Pack '${packId}' not found` };

  const childWin = deps.getChildWin();
  const boardWin = deps.getBoardWin();
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
}

export async function importPack(): Promise<{
  ok: boolean; error?: string; id?: string; name?: string; soundCount?: number
}> {
  const childWin = deps.getChildWin();
  const boardWin = deps.getBoardWin();
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
    const packs = readAll();
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

    const userPacks = readUser();
    userPacks.push({
      id:          finalId,
      name:        n > 1 ? `${manifest.name} (${n})` : manifest.name,
      description: manifest.description || 'Imported pack',
      keys:        newKeys,
      origin:      'user',
    });
    writeUser(userPacks);

    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: true, id: finalId, name: manifest.name, soundCount: copied };
  } catch (e) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, error: (e as Error).message };
  }
}
