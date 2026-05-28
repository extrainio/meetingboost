import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { userRoot } from './paths.js';
import { findBin, spawnPromise } from './tools.js';

// ── YouTube snippet / pack pipeline ────────────────────────────────────────
//
// Pure helpers (filterSnippets / mapSnippetsToKeys / classifyDetectResult)
// describe the snippet → keyboard-pack transformation. They have no I/O so
// they're trivially testable. IPC-backing functions below orchestrate
// yt-dlp + ffmpeg through `spawnPromise` and surface the results to the
// renderer; they're invoked from main.ts via thin `ipcMain.handle` wrappers.
//
// Cache layout: userData/.cache/yt/<hash>.mp3 keyed by url+start+end so a
// Preview click followed by "+ Add to Library" is free. The same cache is
// shared between yt-prepare-clip (single-cut) and yt-prepare-pack (multi-cut).

// ── Constants ──────────────────────────────────────────────────────────────

export const MIN_SNIPPET_SEC = 0.3;
export const MAX_SNIPPET_SEC_AUTOCHECK = 30.0;
export const MAX_KEYS = 15;
export const KEY_ORDER = ['q','w','e','r','t','a','s','d','f','g','z','x','c','v','b'];

// ── Types ──────────────────────────────────────────────────────────────────

export interface RawChapter { title: string; start: number; end: number; }
export interface FilteredSnippet {
  title: string; start: number; end: number; dur: number;
  autoCheck: boolean; reason: 'too_long' | null;
}

export interface KeyAssignment<T> { snippet: T; key: string; }

export interface DetectMeta { title: string; thumbnail: string; duration?: number; }

export interface PlaylistItem { videoId: string; title: string; duration?: number; }
export interface ChapterItem  { title: string; start: number; end: number; }

export type DetectResult =
  | { kind: 'playlist';  items:    PlaylistItem[]; meta: DetectMeta }
  | { kind: 'chapters';  chapters: ChapterItem[];  meta: DetectMeta }
  | { kind: 'none';      meta: DetectMeta };

export interface PrepareClipOpts {
  url:    string;
  start:  number;   // seconds
  end:    number;   // seconds
}

export interface PreparePackSegment { title: string; start: number; end: number; }
export interface PreparePackOpts    { url: string; segments: PreparePackSegment[]; }

// ── Pure helpers ───────────────────────────────────────────────────────────

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

// ── Cache helpers ──────────────────────────────────────────────────────────

export function cacheDir(): string {
  const d = path.join(userRoot(), '.cache', 'yt');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function cacheKey(url: string, start: number, end: number): string {
  // crypto.createHash would be ideal but we don't need cryptographic strength.
  let h = 0;
  const str = `${url}|${start}|${end}`;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ── Source-download helper (shared by prepareClip / preparePack) ───────────

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

// ── IPC-backing functions ─────────────────────────────────────────────────

export async function getInfo(url: string): Promise<
  | { ok: true; title: string; duration: number; thumbnail: string; uploader: string; videoId: string }
  | { ok: false; error: string }
> {
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
}

/**
 * Detect what kind of source the URL points to: a playlist (multiple videos),
 * a single video with chapters, or a single video without chapters.
 *
 * One yt-dlp call per URL. Caller (renderer) decides what to do with each
 * shape — for 'none' we route the user to the existing single-clip flow.
 */
export async function detectSnippets(url: string): Promise<
  { ok: true; result: DetectResult } | { ok: false; error: string }
> {
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
}

/**
 * Download + ffmpeg-cut a YouTube excerpt into the cache, returning a playable
 * file:// URL. Cached by (url, start, end) so a Preview click followed by
 * "+ Add to Library" doesn't re-download — the cached file just gets moved.
 */
export async function prepareClip(opts: PrepareClipOpts): Promise<
  | { ok: true; cachePath: string; url: string; cached: boolean }
  | { ok: false; error: string }
> {
  const { url, start, end } = opts;
  if (end <= start) return { ok: false, error: 'End time must be after start time' };

  const duration = Math.max(0.1, end - start);
  const key      = cacheKey(url, start, end);
  const outFile  = path.join(cacheDir(), `${key}.mp3`);

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
}

/**
 * Bulk-prepare N snippets from one YouTube source. Downloads the source
 * mp3 once (or skips the download entirely if every requested segment is
 * already cached), then ffmpeg-cuts each segment into the same .cache/yt/
 * directory that yt-prepare-clip uses. Cache key matches: cacheKey(url,
 * start, end). Repeated invocations with overlapping segments are free.
 *
 * Partial failure tolerated: a failed cut is reported in `failed[]`; the
 * remaining cuts still complete. Caller decides whether to retry the
 * failures or proceed without them.
 *
 * Defensive caps: rejects > 100 segments or any segment outside [0.1, 60]s.
 */
export async function preparePack(opts: PreparePackOpts): Promise<
  | { ok: true;  prepared: { title: string; cachePath: string; durationMs: number }[]; failed: { title: string; error: string }[] }
  | { ok: false; error: string; prepared?: { title: string; cachePath: string; durationMs: number }[]; failed?: { title: string; error: string }[] }
> {
  const { url, segments } = opts;

  if (segments.length > 100) {
    return { ok: false, error: 'Too many segments (max 100).' };
  }

  // Per-segment duration is validated below in the cut loop and pushed to
  // failed[] rather than rejecting the whole batch — playlist mode in the
  // renderer cannot know exact video durations up-front.

  const dir = cacheDir();
  const planned = segments.map(s => {
    const key       = cacheKey(url, s.start, s.end);
    const cachePath = path.join(dir, `${key}.mp3`);
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
}
