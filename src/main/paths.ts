import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export const storeFile = (): string =>
  path.join(app.getPath('userData'), 'settings.json');

export const userRoot           = (): string => app.getPath('userData');
export const userPacksFile      = (): string => path.join(userRoot(), 'packs.json');
export const userSoundsDir      = (): string => path.join(userRoot(), 'sounds');
export const userRecordingsDir  = (): string => path.join(userRoot(), 'recordings');
export const userRecordingsFile = (): string => path.join(userRoot(), 'recordings.json');

export function ensureUserDirs(): void {
  fs.mkdirSync(userSoundsDir(),     { recursive: true });
  fs.mkdirSync(userRecordingsDir(), { recursive: true });
}

export function customSoundsDir(): string {
  const dir = path.join(userSoundsDir(), 'custom');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// __dirname here resolves to <root>/src/main (or inside app.asar in packaged
// builds). Bundled assets live at <root>/src/{packs.json,sounds}, so we step
// up two directories and back into src/.
export function bundledPacksFile(): string {
  return path.join(__dirname, '..', '..', 'src', 'packs.json');
}

export function bundledSoundsRoot(): string {
  return path.join(__dirname, '..', '..', 'src', 'sounds');
}
