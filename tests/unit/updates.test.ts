import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../../src/main/updates';

describe('isNewerVersion', () => {
  it.each([
    // major / minor / patch precedence
    ['1.0.0',       '0.9.9',       true],
    ['1.0.0',       '1.0.0',       false],
    ['0.9.9',       '1.0.0',       false],
    ['1.2.0',       '1.1.9',       true],
    ['1.0.1',       '1.0.0',       true],

    // tolerates and ignores leading v
    ['v1.2.3',      '1.2.2',       true],
    ['v1.2.3',      'v1.2.3',      false],

    // prerelease handling — same MMP without pre is newer
    ['1.0.0',       '1.0.0-beta',  true],
    ['1.0.0-beta',  '1.0.0',       false],
    ['1.0.0-beta',  '1.0.0-beta',  false],
    ['1.0.0-rc1',   '1.0.0-beta',  true],   // string compare on the pre tag

    // a higher MMP outranks a missing pre tag
    ['1.0.1',       '1.0.0-beta',  true],
    ['1.0.0',       '1.0.1-beta',  false],

    // graceful with malformed pieces (parseInt → 0)
    ['1.0.x',       '1.0.0',       false],
  ])('isNewerVersion(%s, %s) -> %s', (latest, current, expected) => {
    expect(isNewerVersion(latest, current)).toBe(expected);
  });
});
