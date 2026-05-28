import { app, dialog, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as packs from './packs.js';

// ── mbpack:// protocol handler — install packs from a public URL ──────────
//
// Wire format:  mbpack://import?url=<urlencoded https URL to .mbpack>
//
// Two reasons to gate this behind explicit confirmation:
//   1. Code-running risk is low (we only unzip + copy mp3s + write a manifest),
//      but the user is downloading arbitrary content that will play through
//      their meeting audio. Consent makes that obvious.
//   2. URL-scheme handlers are an attack surface — any webpage can call
//      window.location='mbpack://...'. Confirmation prevents drive-by installs.

interface Deps {
  getBoardWin: () => BrowserWindow | null;
  getChildWin: () => BrowserWindow | null;
}

let deps: Deps = {
  getBoardWin: () => null,
  getChildWin: () => null,
};

export function configure(d: Partial<Deps>): void {
  deps = { ...deps, ...d };
}

let pendingUrl: string | null = null;

export function parseMbpackUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'mbpack:') return null;
  // Both `mbpack://import?url=...` and `mbpack:import?url=...` show up depending
  // on how the URL was constructed; `host` populates inconsistently. Accept either.
  const action = u.host || u.pathname.replace(/^\/+/, '');
  if (action !== 'import') return null;
  const inner = u.searchParams.get('url');
  if (!inner || !/^https:\/\//i.test(inner)) return null;
  return inner;
}

function downloadHttps(url: string, dest: string, redirectsLeft = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': `MeetingBoost/${app.getVersion()}` },
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308)
          && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!/^https:\/\//i.test(next)) { reject(new Error('redirect to non-https')); return; }
        downloadHttps(next, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close((err) => err ? reject(err) : resolve()));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('download timeout')));
  });
}

async function confirmAndInstall(httpsUrl: string): Promise<void> {
  const childWin = deps.getChildWin();
  const boardWin = deps.getBoardWin();
  const parent = childWin && !childWin.isDestroyed()
    ? childWin
    : (boardWin && !boardWin.isDestroyed() ? boardWin : undefined);

  const confirm = await dialog.showMessageBox(parent!, {
    type: 'question',
    message: 'Install pack from the web?',
    detail:  `${httpsUrl}\n\nMeetingBoost will download a .mbpack archive from this URL and add its sounds to your library. Only proceed if you trust the source.`,
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId:  1,
  });
  if (confirm.response !== 0) return;

  const tmp = path.join(app.getPath('temp'), `mb_dl_${Date.now()}.mbpack`);
  try {
    await downloadHttps(httpsUrl, tmp);
    const r = await packs.installFromArchive(tmp);
    if (r.ok) {
      await dialog.showMessageBox(parent!, {
        type: 'info',
        message: `Installed "${r.name}"`,
        detail:  `${r.soundCount} sound${r.soundCount === 1 ? '' : 's'} added.`,
        buttons: ['OK'],
      });
    } else {
      await dialog.showMessageBox(parent!, {
        type: 'error',
        message: 'Install failed',
        detail:  r.error ?? 'Unknown error',
        buttons: ['OK'],
      });
    }
  } catch (e) {
    await dialog.showMessageBox(parent!, {
      type: 'error',
      message: 'Download failed',
      detail:  (e as Error).message,
      buttons: ['OK'],
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function handleMbpackUrl(raw: string): void {
  const inner = parseMbpackUrl(raw);
  if (!inner) return;
  if (app.isReady()) void confirmAndInstall(inner);
  else pendingUrl = inner;
}

// Drain a URL that arrived during cold-start, before whenReady fired.
export function drainPending(): void {
  if (!pendingUrl) return;
  const url = pendingUrl;
  pendingUrl = null;
  void confirmAndInstall(url);
}
