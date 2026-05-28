import { describe, it, expect } from 'vitest';
import { isVirtualAudioDevice } from '../../src/main/audio';

describe('isVirtualAudioDevice', () => {
  it.each([
    ['BlackHole 2ch', true],
    ['BlackHole 16ch', true],
    ['VB-Cable A', true],
    ['Soundflower (2ch)', true],
    ['Loopback Audio', true],
    ['MacBook Pro Speakers', false],
    ['AirPods Pro', false],
    ['External Headphones', false],
    ['', false],
  ])('matches %s -> %s', (name, expected) => {
    expect(isVirtualAudioDevice(name)).toBe(expected);
  });
});
