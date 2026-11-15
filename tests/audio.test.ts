import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeAnimalCall } from '../src/ui/animal-calls';
import { GameAudio } from '../src/ui/audio';
import type { Rank } from '../src/game/types';

test('eight original calls are short, deterministic, distinct and safely bounded', () => {
  const signatures = new Set<string>();
  for (let rank = 1; rank <= 8; rank++) {
    const call = synthesizeAnimalCall(rank as Rank, 24000);
    assert.ok(call.length >= 24000 * .3 && call.length <= 24000);
    assert.equal(call[0], 0); assert.equal(call.at(-1), 0);
    assert.ok(call.every(value => Number.isFinite(value) && Math.abs(value) <= .231));
    assert.ok(call.some(value => Math.abs(value) > .2));
    assert.deepEqual(call, synthesizeAnimalCall(rank as Rank, 24000));
    signatures.add(Array.from(call.slice(100, 110)).join(','));
  }
  assert.equal(signatures.size, 8);
});

test('animal playback respects mute, caches buffers, and stops previous sources', () => {
  const original = globalThis.AudioContext;
  const sources: { started: boolean; stopped: boolean; disconnected: boolean }[] = [];
  let buffers = 0;
  class Context {
    state = 'running'; sampleRate = 24000; destination = {};
    createBuffer(_channels: number, length: number) { buffers++; return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      const source = { started: false, stopped: false, disconnected: false, buffer: null, onended: null,
        connect() {}, disconnect() { this.disconnected = true; }, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  try {
    const audio = new GameAudio(false);
    audio.playAnimal(3); assert.equal(sources.length, 0);
    audio.enabled = true; audio.playAnimal(3); assert.equal(sources.length, 1); assert.ok(sources[0].started);
    audio.playAnimal(3); assert.equal(buffers, 1); assert.ok(sources[0].stopped);
    audio.enabled = false; assert.ok(sources[1].stopped); assert.ok(sources[1].disconnected);
    audio.playAnimal(8); assert.equal(sources.length, 2);
    audio.enabled = true; audio.playAnimal(8); assert.equal(buffers, 2);
    audio.stopAnimal(); audio.stopAnimal(); assert.ok(sources[2].stopped);
  } finally { globalThis.AudioContext = original; }
});

test('missing audio hardware never prevents playing the game', () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { throw new Error('unavailable'); } } as unknown as typeof AudioContext;
  try { assert.doesNotThrow(() => new GameAudio(true).playAnimal(1)); }
  finally { globalThis.AudioContext = original; }
});
