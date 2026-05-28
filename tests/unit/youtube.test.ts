import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  filterSnippets, mapSnippetsToKeys, classifyDetectResult,
  cacheKey,
  MIN_SNIPPET_SEC, MAX_SNIPPET_SEC_AUTOCHECK, MAX_KEYS, KEY_ORDER,
} from '../../src/main/youtube';

// Tests mirror the Python source-of-truth suite in tests/test_youtube_pack.py
// so the TS implementation and the Python mirror stay byte-equivalent in
// behaviour. If you change one, change the other.

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('youtube module', () => {
  it('exports the expected surface', async () => {
    const m = await import('../../src/main/youtube');
    for (const fn of [
      'filterSnippets', 'mapSnippetsToKeys', 'classifyDetectResult',
      'cacheDir', 'cacheKey',
      'getInfo', 'detectSnippets', 'prepareClip', 'preparePack',
    ]) {
      expect(typeof m[fn as keyof typeof m]).toBe('function');
    }
  });

  it('exposes the snippet constants', () => {
    expect(MIN_SNIPPET_SEC).toBe(0.3);
    expect(MAX_SNIPPET_SEC_AUTOCHECK).toBe(30.0);
    expect(MAX_KEYS).toBe(15);
    expect(KEY_ORDER).toEqual(['q','w','e','r','t','a','s','d','f','g','z','x','c','v','b']);
  });
});

describe('filterSnippets', () => {
  it('drops entries shorter than MIN_SNIPPET_SEC', () => {
    const result = filterSnippets([
      { title: 'tiny', start: 0,    end: 0.1 },
      { title: 'ok',   start: 0.1,  end: 5.0 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('ok');
  });

  it('marks entries longer than MAX_SNIPPET_SEC_AUTOCHECK with autoCheck=false', () => {
    const result = filterSnippets([
      { title: 'short', start: 0, end: 5 },
      { title: 'long',  start: 5, end: 50 },
    ]);
    expect(result[0].autoCheck).toBe(true);
    expect(result[0].reason).toBeNull();
    expect(result[1].autoCheck).toBe(false);
    expect(result[1].reason).toBe('too_long');
  });

  it('preserves input order', () => {
    const result = filterSnippets([
      { title: 'a', start: 0, end: 1 },
      { title: 'b', start: 1, end: 2 },
      { title: 'c', start: 2, end: 3 },
    ]);
    expect(result.map(r => r.title)).toEqual(['a', 'b', 'c']);
  });

  it('keeps duration exactly equal to MIN_SNIPPET_SEC (boundary < 0.3)', () => {
    // Guard is strict `<`, so dur === 0.3 is kept.
    const result = filterSnippets([
      { title: 'edge', start: 0, end: 0.3 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('edge');
  });

  it('treats duration exactly equal to MAX_SNIPPET_SEC_AUTOCHECK as autoCheck (boundary > 30)', () => {
    // Guard is strict `>`, so dur === 30 stays autoCheck=true.
    const result = filterSnippets([
      { title: 'edge', start: 0, end: 30.0 },
    ]);
    expect(result[0].autoCheck).toBe(true);
    expect(result[0].reason).toBeNull();
  });

  it('returns empty array when given empty input', () => {
    expect(filterSnippets([])).toEqual([]);
  });

  it('computes dur as end minus start', () => {
    const result = filterSnippets([
      { title: 'x', start: 1.25, end: 4.5 },
    ]);
    expect(result[0].dur).toBeCloseTo(3.25, 5);
  });
});

describe('mapSnippetsToKeys', () => {
  it('assigns keys to the first N snippets in KEY_ORDER', () => {
    const snippets = [
      { title: 'snip0' }, { title: 'snip1' }, { title: 'snip2' },
      { title: 'snip3' }, { title: 'snip4' },
    ];
    const result = mapSnippetsToKeys(snippets);
    expect(result.mapped.map(m => m.key)).toEqual(['q','w','e','r','t']);
    expect(result.overflowCount).toBe(0);
    expect(result.mapped[0].snippet).toBe(snippets[0]);
  });

  it('truncates at MAX_KEYS (15) and reports overflow', () => {
    const snippets = Array.from({ length: 20 }, (_, i) => ({ title: `snip${i}` }));
    const result = mapSnippetsToKeys(snippets);
    expect(result.mapped).toHaveLength(15);
    expect(result.overflowCount).toBe(5);
    // Last assigned key should be the final entry in KEY_ORDER.
    expect(result.mapped[result.mapped.length - 1].key).toBe('b');
  });

  it('returns empty mapped array and zero overflow for empty input', () => {
    const result = mapSnippetsToKeys([]);
    expect(result.mapped).toEqual([]);
    expect(result.overflowCount).toBe(0);
  });

  it('assigns keys in KEY_ORDER even when input length equals MAX_KEYS exactly', () => {
    const snippets = Array.from({ length: 15 }, (_, i) => ({ title: `snip${i}` }));
    const result = mapSnippetsToKeys(snippets);
    expect(result.mapped).toHaveLength(15);
    expect(result.overflowCount).toBe(0);
    expect(result.mapped.map(m => m.key)).toEqual(KEY_ORDER);
  });
});

describe('classifyDetectResult', () => {
  it('classifies a chapters fixture as kind=chapters with meta', () => {
    const raw = loadFixture('yt_detect_chapters.json');
    const result = classifyDetectResult(raw);
    expect(result.kind).toBe('chapters');
    if (result.kind !== 'chapters') throw new Error('expected chapters');
    expect(result.chapters).toHaveLength(5);
    expect(result.chapters[0].title).toBe('Intro Sting');
    expect(result.chapters[0].start).toBe(0);
    expect(result.chapters[0].end).toBe(6);
    expect(result.meta.title).toBe('Sound Effects Compilation');
  });

  it('classifies a playlist fixture as kind=playlist with items', () => {
    const raw = loadFixture('yt_detect_playlist.json');
    const result = classifyDetectResult(raw);
    expect(result.kind).toBe('playlist');
    if (result.kind !== 'playlist') throw new Error('expected playlist');
    expect(result.items).toHaveLength(3);
    expect(result.items[0].videoId).toBe('vidA');
    expect(result.items[0].title).toBe('Airhorn');
    expect(result.items[0].duration).toBe(4);
  });

  it('classifies a chapter-less video as kind=none', () => {
    const raw = loadFixture('yt_detect_none.json');
    const result = classifyDetectResult(raw);
    expect(result.kind).toBe('none');
    expect(result.meta.title).toBe('Single Plain Video');
  });

  it('treats an empty chapters[] as kind=none rather than kind=chapters', () => {
    // Defensive: yt-dlp emits `chapters: []` on some videos.
    const result = classifyDetectResult({ _type: 'video', title: 'X', chapters: [] });
    expect(result.kind).toBe('none');
  });

  it('treats an empty entries[] as kind=none rather than kind=playlist', () => {
    const result = classifyDetectResult({ _type: 'playlist', title: 'Empty', entries: [] });
    expect(result.kind).toBe('none');
  });

  it('defaults missing chapter timestamps to 0 and missing titles to "Untitled"', () => {
    const result = classifyDetectResult({
      _type: 'video', title: 'X',
      chapters: [
        { title: null, start_time: null, end_time: null },
        { title: 'Real', start_time: 5, end_time: 10 },
      ],
    });
    expect(result.kind).toBe('chapters');
    if (result.kind !== 'chapters') throw new Error('expected chapters');
    expect(result.chapters[0].title).toBe('Untitled');
    expect(result.chapters[0].start).toBe(0);
    expect(result.chapters[0].end).toBe(0);
    expect(result.chapters[1].title).toBe('Real');
  });

  it('handles a totally empty input as kind=none with empty meta', () => {
    const result = classifyDetectResult({});
    expect(result.kind).toBe('none');
    expect(result.meta.title).toBe('');
    expect(result.meta.thumbnail).toBe('');
    expect(result.meta.duration).toBeUndefined();
  });
});

describe('cacheKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = cacheKey('https://youtu.be/abc', 1.0, 5.5);
    const b = cacheKey('https://youtu.be/abc', 1.0, 5.5);
    expect(a).toBe(b);
  });

  it('differs when the URL differs', () => {
    const a = cacheKey('https://youtu.be/abc', 1.0, 5.5);
    const b = cacheKey('https://youtu.be/def', 1.0, 5.5);
    expect(a).not.toBe(b);
  });

  it('differs when the start differs', () => {
    const a = cacheKey('https://youtu.be/abc', 1.0, 5.5);
    const b = cacheKey('https://youtu.be/abc', 1.5, 5.5);
    expect(a).not.toBe(b);
  });

  it('differs when the end differs', () => {
    const a = cacheKey('https://youtu.be/abc', 1.0, 5.5);
    const b = cacheKey('https://youtu.be/abc', 1.0, 6.0);
    expect(a).not.toBe(b);
  });

  it('returns a non-empty filesystem-safe string (base36)', () => {
    const key = cacheKey('https://youtu.be/abc', 1.0, 5.5);
    expect(key.length).toBeGreaterThan(0);
    expect(key).toMatch(/^[0-9a-z]+$/);
  });
});
