import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

// Search PATH locations where yt-dlp / ffmpeg are commonly installed on macOS
export const TOOL_PATHS = [
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
export function bundledFfmpeg(): string | null {
  if (!ffmpegStatic) return null;
  const patched = (ffmpegStatic as string).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  return fs.existsSync(patched) ? patched : null;
}

export function findBin(name: string): string {
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

// ── yt-dlp JS runtime discovery ───────────────────────────────────────────
//
// yt-dlp ≥ 2026.02 needs a JavaScript runtime to extract YouTube videos
// (see https://github.com/yt-dlp/yt-dlp/wiki/EJS). It auto-detects `deno`
// on PATH only; for `node` and `bun` it requires `--js-runtimes NAME:PATH`.
// Electron launched from Finder has a stripped PATH that often omits
// /opt/homebrew/bin, so we explicitly resolve a runtime ourselves and pass
// the absolute path.

const JS_RUNTIME_NAMES = ['deno', 'node', 'bun'] as const;
export type JsRuntimeName = (typeof JS_RUNTIME_NAMES)[number];
export interface JsRuntime { name: JsRuntimeName; path: string; }

export function findJsRuntime(): JsRuntime | null {
  for (const name of JS_RUNTIME_NAMES) {
    for (const dir of TOOL_PATHS) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return { name, path: full };
    }
  }
  return null;
}

let ytDlpSupportsJsRuntimesCache: boolean | null = null;

// Older yt-dlp builds reject `--js-runtimes` as an unknown option, so we
// feature-detect once per process via `--help` before passing the flag.
export async function ytDlpSupportsJsRuntimes(): Promise<boolean> {
  if (ytDlpSupportsJsRuntimesCache !== null) return ytDlpSupportsJsRuntimesCache;
  try {
    const help = await spawnPromise(findBin('yt-dlp'), ['--help'], { capture: true });
    ytDlpSupportsJsRuntimesCache = /--js-runtimes/.test(help);
  } catch {
    ytDlpSupportsJsRuntimesCache = false;
  }
  return ytDlpSupportsJsRuntimesCache;
}

export function spawnPromise(
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
