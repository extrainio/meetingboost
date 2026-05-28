import { type BrowserWindow as BrowserWindowType } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  userRecordingsDir, customSoundsDir, ensureUserDirs,
} from './paths.js';
import * as packs from './packs.js';
import * as recording from './recording.js';
import * as youtube from './youtube.js';

// ── DI ─────────────────────────────────────────────────────────────────────
//
// Both handlers below fire `recordings-changed` / `packs-changed` events to
// the renderer windows. main.ts re-assigns its boardWin/childWin lets during
// the window lifecycle, so we read via getters (same pattern as settings.ts /
// recording.ts / packs.ts).

interface LibraryDeps {
  getBoardWin: () => BrowserWindowType | null;
  getChildWin: () => BrowserWindowType | null;
}

const deps: LibraryDeps = {
  getBoardWin: () => null,
  getChildWin: () => null,
};

export function configure(d: Partial<LibraryDeps>): void {
  Object.assign(deps, d);
}

// ── Library handlers ───────────────────────────────────────────────────────

interface AddFromClipOpts {
  cachePath: string; name: string; sourceUrl?: string; durationMs?: number;
}

/**
 * Promote a previously-prepared clip into the library inventory. Idempotent
 * for repeated clicks: copies the cache file into the library dir under a
 * stable name and registers the metadata. Caller should pass `cachePath`
 * from yt-prepare-clip.
 */
export async function addFromClip(opts: AddFromClipOpts): Promise<{
  ok: boolean; error?: string; item?: recording.RecordingMeta & { url: string };
}> {
  const { cachePath, name, sourceUrl, durationMs } = opts;
  if (!fs.existsSync(cachePath)) {
    return { ok: false, error: 'Clip cache is gone — click Preview again to redownload.' };
  }

  ensureUserDirs();
  const id       = `yt_${Date.now()}`;
  const safeName = packs.slugify(name, 'clip');
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

  deps.getBoardWin()?.webContents.send('recordings-changed');
  deps.getChildWin()?.webContents.send('recordings-changed');

  return { ok: true, item: { ...meta, url: pathToFileURL(outFile).href } };
}

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
export async function createPackFromClips(opts: CreatePackOpts): Promise<{
  ok: boolean; error?: string;
  packId?: string; finalName?: string; keysAssigned?: number;
}> {
  const { url, packName, clips } = opts;
  if (clips.length === 0) {
    return { ok: false, error: 'No clips selected.' };
  }
  if (clips.length > youtube.MAX_KEYS) {
    return { ok: false, error: `Too many clips (max ${youtube.MAX_KEYS}).` };
  }

  ensureUserDirs();
  const customDir = customSoundsDir();

  const userPacks  = packs.readUser();
  const existing   = userPacks.map(p => p.name);
  const { finalName, packId } = packs.slugifyPackName(packName, existing);

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
    packs.writeUser(userPacks);
  } catch (e) {
    for (const p of copied) { try { fs.unlinkSync(p); } catch {} }
    return { ok: false, error: (e as Error).message };
  }

  // Step 3 — notify
  deps.getBoardWin()?.webContents.send('packs-changed');
  deps.getChildWin()?.webContents.send('packs-changed');

  return {
    ok: true,
    packId,
    finalName,
    keysAssigned: keyMap.mapped.length,
  };
}
