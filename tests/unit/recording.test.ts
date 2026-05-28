import { describe, it, expect } from 'vitest';

describe('recording module', () => {
  it('exports the expected surface', async () => {
    const m = await import('../../src/main/recording');
    for (const fn of ['save', 'readAll', 'remove', 'rename']) {
      expect(typeof m[fn as keyof typeof m]).toBe('function');
    }
  });
});
