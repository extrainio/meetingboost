import { describe, it, expect } from 'vitest';
import { bundledPacksFile, bundledSoundsRoot } from '../../src/main/paths';

describe('paths', () => {
  it('points bundled paths at the src/ tree relative to compiled main', () => {
    expect(bundledPacksFile()).toMatch(/src[\\\/]packs\.json$/);
    expect(bundledSoundsRoot()).toMatch(/src[\\\/]sounds$/);
  });
});
