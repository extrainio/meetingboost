import { describe, it, expect } from 'vitest';
import * as path from 'path';

import {
  slugify, slugifyPackName, inferEntrySource,
  tagBundledEntries, resolveEntryPath,
} from '../../src/main/packs';
import { bundledSoundsRoot } from '../../src/main/paths';

// These tests cover the pure helpers in packs.ts that don't reach into
// electron's `app.getPath('userData')`. FS-touching paths (read/write of
// packs.json, .mbpack import/export) are integration concerns covered by
// tests/test_pack_format.py against the on-disk format.

describe('slugify', () => {
  it.each([
    ['Hello World',         'hello-world'],
    ['  spaces  ',          'spaces'],
    ['émojis 🎉 strip',     'mojis-strip'],   // non-[a-z0-9] runs collapse to one dash; é is non-ASCII so it's stripped
    ['',                    'sound'],         // empty input -> default fallback
    ['---',                 'sound'],         // only separators -> fallback
    ['ALL CAPS',            'all-caps'],
    ['multi  spaces',       'multi-spaces'],  // runs collapse to single dash
    ['a-b_c.d',             'a-b-c-d'],       // _ and . both become dashes
  ])('slugify(%j) === %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('uses a custom fallback when provided', () => {
    expect(slugify('', 'clip')).toBe('clip');
    expect(slugify('!!!', 'pack')).toBe('pack');
  });
});

describe('slugifyPackName', () => {
  it('returns the base name and slug for a fresh name', () => {
    const out = slugifyPackName('My Pack', []);
    expect(out).toEqual({ finalName: 'My Pack', packId: 'my-pack' });
  });

  it('disambiguates on collision by appending (n) to the name', () => {
    const out = slugifyPackName('My Pack', ['My Pack']);
    expect(out.finalName).toBe('My Pack (2)');
    expect(out.packId).toBe('my-pack-2');
  });

  it('keeps disambiguating until unique', () => {
    const out = slugifyPackName('My Pack', ['My Pack', 'My Pack (2)']);
    expect(out.finalName).toBe('My Pack (3)');
  });

  it('falls back to "YouTube Pack" for blank input', () => {
    const out = slugifyPackName('   ', []);
    expect(out.finalName).toBe('YouTube Pack');
    expect(out.packId).toBe('youtube-pack');
  });

  it('falls back to yt-pack-<timestamp> if the slug would be empty', () => {
    // A name made of only non-alphanumeric chars produces an empty slug
    // after the regex; the fallback uses Date.now().
    const out = slugifyPackName('!!!', []);
    expect(out.finalName).toBe('!!!');
    expect(out.packId).toMatch(/^yt-pack-\d+$/);
  });
});

describe('inferEntrySource', () => {
  it('preserves an explicit `source: recording`', () => {
    const out = inferEntrySource({ label: 'x', file: 'foo.mp3', source: 'recording' });
    expect(out.source).toBe('recording');
    expect(out.file).toBe('foo.mp3');   // path is left alone when source is already set
  });

  it('preserves an explicit `source: user`', () => {
    const out = inferEntrySource({ label: 'x', file: 'custom/foo.mp3', source: 'user' });
    expect(out.source).toBe('user');
  });

  it('preserves an explicit `source: bundled`', () => {
    const out = inferEntrySource({ label: 'x', file: 'classics/a.mp3', source: 'bundled' });
    expect(out.source).toBe('bundled');
  });

  it('rewrites recordings/-prefixed paths into source=recording + stripped file', () => {
    const out = inferEntrySource({ label: 'x', file: 'recordings/foo.mp3' });
    expect(out.source).toBe('recording');
    expect(out.file).toBe('foo.mp3');
  });

  it('infers source=bundled when the file exists under bundledSoundsRoot()', () => {
    // We don't hard-code a fixture mp3; instead scan the bundled tree for a
    // real file so this test stays in sync with what ships. If the bundle has
    // any mp3 at all, this branch should fire.
    const fs = require('fs');
    const root = bundledSoundsRoot();
    if (!fs.existsSync(root)) return;   // headless build skip — still safe
    // Walk one level deep for any *.mp3
    let sample: string | null = null;
    for (const dir of fs.readdirSync(root)) {
      const sub = path.join(root, dir);
      if (!fs.statSync(sub).isDirectory()) continue;
      const mp3 = fs.readdirSync(sub).find((f: string) => f.endsWith('.mp3'));
      if (mp3) { sample = `${dir}/${mp3}`; break; }
    }
    if (!sample) return;   // empty bundle in this dev tree — skip rather than fail
    const out = inferEntrySource({ label: 'x', file: sample });
    expect(out.source).toBe('bundled');
  });

  it('defaults to source=user for an unknown path', () => {
    const out = inferEntrySource({ label: 'x', file: 'not-a-real-pack/missing.mp3' });
    expect(out.source).toBe('user');
  });
});

describe('tagBundledEntries', () => {
  it('forces every key to source=bundled and origin=bundled', () => {
    const out = tagBundledEntries({
      id: 'p', name: 'p', description: '',
      keys: {
        a: { label: 'A', file: 'a.mp3' },
        b: { label: 'B', file: 'b.mp3', source: 'user' },   // overridden
      },
    });
    expect(out.origin).toBe('bundled');
    expect(out.keys.a.source).toBe('bundled');
    expect(out.keys.b.source).toBe('bundled');
  });
});

describe('resolveEntryPath', () => {
  it('routes bundled entries through bundledSoundsRoot()', () => {
    const p = resolveEntryPath({ label: 'x', file: 'classics/a.mp3', source: 'bundled' });
    expect(p).toBe(path.join(bundledSoundsRoot(), 'classics/a.mp3'));
  });

  it('treats undefined source as bundled', () => {
    const p = resolveEntryPath({ label: 'x', file: 'classics/a.mp3' });
    expect(p).toBe(path.join(bundledSoundsRoot(), 'classics/a.mp3'));
  });
});
