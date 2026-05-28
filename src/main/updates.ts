import { app, dialog, shell } from 'electron';
import * as https from 'https';

// ── Update check (notify-only; pre-Developer-ID-cert) ─────────────────────
//
// Polls the GitHub Releases API for the latest published tag and compares
// against app.getVersion(). If newer, surfaces it via the tray menu (caller
// rebuilds via onPendingUpdateChanged) and via Settings → About. Does NOT
// download or install — that requires a signed build (see SHIPPING.md). The
// dialog opens the release page in the user's browser; they replace the .app
// manually.

const RELEASES_URL =
  'https://api.github.com/repos/extrainio/meetingboost/releases/latest';

export type UpdateStatus =
  | { status: 'up-to-date'; current: string; latest: string }
  | { status: 'available';  current: string; latest: string; url: string }
  | { status: 'error';      current: string; reason: string };

interface Deps {
  onPendingUpdateChanged: () => void;
}

let deps: Deps = { onPendingUpdateChanged: () => {} };

export function configure(d: Partial<Deps>): void {
  deps = { ...deps, ...d };
}

let pendingUpdate: { latest: string; url: string } | null = null;

export function getPendingUpdate(): { latest: string; url: string } | null {
  return pendingUpdate;
}

// Crude but sufficient semver compare — handles MAJOR.MINOR.PATCH and treats
// any prerelease (e.g. -beta) as lower than the same MMP without one. Avoids
// pulling in `semver` for ~30 lines of code.
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre = ''] = v.replace(/^v/i, '').split('-');
    const [maj = 0, min = 0, patch = 0] = core.split('.').map(n => parseInt(n, 10) || 0);
    return { maj, min, patch, pre };
  };
  const a = parse(latest), b = parse(current);
  if (a.maj   !== b.maj)   return a.maj   > b.maj;
  if (a.min   !== b.min)   return a.min   > b.min;
  if (a.patch !== b.patch) return a.patch > b.patch;
  if (!a.pre &&  b.pre) return true;
  if ( a.pre && !b.pre) return false;
  return a.pre > b.pre;
}

function fetchLatestRelease(): Promise<{ tag: string; url: string } | { error: string }> {
  return new Promise((resolve) => {
    const req = https.request(
      RELEASES_URL,
      {
        method: 'GET',
        headers: {
          'User-Agent': `MeetingBoost/${app.getVersion()}`,
          'Accept':     'application/vnd.github+json',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ error: `HTTP ${res.statusCode}` });
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body) as { tag_name?: string; html_url?: string };
            if (!j.tag_name || !j.html_url) { resolve({ error: 'malformed response' }); return; }
            resolve({ tag: j.tag_name, url: j.html_url });
          } catch {
            resolve({ error: 'parse failed' });
          }
        });
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const current = app.getVersion();
  const r = await fetchLatestRelease();
  if ('error' in r) return { status: 'error', current, reason: r.error };
  const latest = r.tag.replace(/^v/i, '');
  if (isNewerVersion(latest, current)) {
    pendingUpdate = { latest, url: r.url };
    deps.onPendingUpdateChanged();
    return { status: 'available', current, latest, url: r.url };
  }
  pendingUpdate = null;
  deps.onPendingUpdateChanged();
  return { status: 'up-to-date', current, latest };
}

export async function checkForUpdateInteractive(): Promise<void> {
  const r = await checkForUpdate();
  if (r.status === 'available') {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `MeetingBoost ${r.latest} is available`,
      detail:  `You're running ${r.current}. Open the download page to grab the new build.`,
      buttons: ['Open Download Page', 'Later'],
      defaultId: 0,
      cancelId:  1,
    });
    if (response === 0) await shell.openExternal(r.url);
  } else if (r.status === 'up-to-date') {
    await dialog.showMessageBox({
      type: 'info',
      message: "You're up to date",
      detail:  `MeetingBoost ${r.current} is the latest version.`,
      buttons: ['OK'],
    });
  } else {
    await dialog.showMessageBox({
      type: 'warning',
      message: 'Update check failed',
      detail:  `Could not reach GitHub (${r.reason}). Try again later.`,
      buttons: ['OK'],
    });
  }
}
