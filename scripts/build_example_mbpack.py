#!/usr/bin/env python3
"""
Build assets/classics.mbpack — a real, importable .mbpack example.

Mirrors the export logic in main.ts ipcMain.handle('pack-export') so that
re-running this script produces an archive byte-compatible with what the
running Electron app produces. Re-run any time the classics pack changes.

Usage:  python3 scripts/build_example_mbpack.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

ROOT        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS_JSON  = os.path.join(ROOT, 'src', 'packs.json')
SOUNDS_ROOT = os.path.join(ROOT, 'src', 'sounds')
OUT_PATH    = os.path.join(ROOT, 'assets', 'classics.mbpack')

MBPACK_VERSION = 1
PACK_ID        = 'classics'


def main() -> int:
    if not shutil.which('zip'):
        print('error: `zip` not on PATH', file=sys.stderr)
        return 1

    with open(PACKS_JSON) as f:
        packs = json.load(f)

    pack = next((p for p in packs if p['id'] == PACK_ID), None)
    if not pack:
        print(f'error: pack "{PACK_ID}" not found in packs.json', file=sys.stderr)
        return 1

    staging = tempfile.mkdtemp(prefix='mb_export_')
    try:
        sounds_dir = os.path.join(staging, 'sounds')
        os.makedirs(sounds_dir, exist_ok=True)

        exported_keys = {}
        for key, entry in pack['keys'].items():
            src = os.path.join(SOUNDS_ROOT, entry['file'])
            if not os.path.exists(src):
                print(f'  warn: skipping {entry["file"]} (file missing)', file=sys.stderr)
                continue
            base = os.path.basename(entry['file'])
            shutil.copyfile(src, os.path.join(sounds_dir, base))
            exported_keys[key] = {'label': entry['label'], 'file': f'sounds/{base}'}

        manifest = {
            'mbpackVersion': MBPACK_VERSION,
            'id':            pack['id'],
            'name':          pack['name'],
            'description':   pack['description'],
            'keys':          exported_keys,
            'exportedAt':    datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
        }
        with open(os.path.join(staging, 'manifest.json'), 'w') as f:
            json.dump(manifest, f, indent=2)

        # Always rebuild fresh — `zip` would otherwise update in place
        if os.path.exists(OUT_PATH):
            os.unlink(OUT_PATH)
        os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)

        subprocess.run(
            ['zip', '-r', '-q', OUT_PATH, 'manifest.json', 'sounds'],
            cwd=staging, check=True,
        )

        size_kb = os.path.getsize(OUT_PATH) / 1024
        print(f'  built  {OUT_PATH}  ({len(exported_keys)} sounds, {size_kb:.1f} KB)')
        return 0
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
