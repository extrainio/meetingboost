import { describe, it, expect } from 'vitest';
import { parseMbpackUrl } from '../../src/main/protocol';

// parseMbpackUrl gates which URLs are allowed to drive the install flow.
// Reject path: wrong scheme, wrong action, non-https inner URL, malformed
// outer URL. Accept path: valid https inner URL on `import` action.

describe('parseMbpackUrl', () => {
  it('accepts mbpack://import?url=https://...', () => {
    expect(parseMbpackUrl('mbpack://import?url=https%3A%2F%2Fexample.com%2Fpack.mbpack'))
      .toBe('https://example.com/pack.mbpack');
  });

  it('accepts the host-less form mbpack:import?url=https://...', () => {
    expect(parseMbpackUrl('mbpack:import?url=https%3A%2F%2Fexample.com%2Fp.mbpack'))
      .toBe('https://example.com/p.mbpack');
  });

  it('rejects non-mbpack scheme', () => {
    expect(parseMbpackUrl('https://example.com/import?url=https://x.com')).toBeNull();
  });

  it('rejects an unknown action', () => {
    expect(parseMbpackUrl('mbpack://run?url=https%3A%2F%2Fexample.com%2Fp.mbpack')).toBeNull();
  });

  it('rejects non-https inner URLs', () => {
    expect(parseMbpackUrl('mbpack://import?url=http%3A%2F%2Fexample.com%2Fp.mbpack')).toBeNull();
    expect(parseMbpackUrl('mbpack://import?url=file%3A%2F%2F%2Fetc%2Fpasswd')).toBeNull();
    expect(parseMbpackUrl('mbpack://import?url=javascript%3Aalert(1)')).toBeNull();
  });

  it('rejects missing inner URL', () => {
    expect(parseMbpackUrl('mbpack://import')).toBeNull();
    expect(parseMbpackUrl('mbpack://import?url=')).toBeNull();
  });

  it('rejects malformed outer URLs', () => {
    expect(parseMbpackUrl('not a url')).toBeNull();
    expect(parseMbpackUrl('')).toBeNull();
  });
});
