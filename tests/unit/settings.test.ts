import { describe, it, expect } from 'vitest';

describe('settings module shape', () => {
  it('exports the expected surface', async () => {
    const m = await import('../../src/main/settings');
    for (const fn of ['get', 'save', 'readAll', 'writeAll', 'exportToFile', 'reset', 'applySideEffect']) {
      expect(typeof m[fn as keyof typeof m]).toBe('function');
    }
  });
});
