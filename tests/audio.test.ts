import test from 'node:test';
import assert from 'node:assert/strict';
import recordings from '../src/ui/animal-recordings.json';
import { GameAudio } from '../src/ui/audio';
import type { Rank } from '../src/game/types';

test('eight embedded recordings are distinct, short MP3 files', () => {
  const signatures = new Set<string>();
  for (let rank = 1; rank <= 8; rank++) {
    const clip = recordings[rank as Rank];
    assert.ok(clip.duration >= .3 && clip.duration <= 2.2);
    const bytes = Buffer.from(clip.mp3, 'base64');
    assert.equal(bytes.subarray(0, 3).toString(), 'ID3');
    assert.ok(bytes.length > 2000);
    signatures.add(clip.mp3);
  }
  assert.equal(signatures.size, 8);
});

test('animal playback respects mute, caches buffers, and stops previous sources', async () => {
  const original = globalThis.AudioContext;
  const sources: { started: boolean; stopped: boolean; disconnected: boolean }[] = [];
  let buffers = 0;
  class Context {
    state = 'running'; sampleRate = 24000; destination = {};
    async decodeAudioData() { buffers++; return {}; }
    createBufferSource() {
      const source = { started: false, stopped: false, disconnected: false, buffer: null, onended: null,
        connect() {}, disconnect() { this.disconnected = true; }, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  try {
    const audio = new GameAudio(false);
    await audio.playAnimal(3); assert.equal(sources.length, 0);
    audio.enabled = true; await audio.playAnimal(3); assert.equal(sources.length, 1); assert.ok(sources[0].started);
    await audio.playAnimal(3); assert.equal(buffers, 8); assert.ok(sources[0].stopped);
    audio.enabled = false; assert.ok(sources[1].stopped); assert.ok(sources[1].disconnected);
    await audio.playAnimal(8); assert.equal(sources.length, 2);
    audio.enabled = true; await audio.playAnimal(8); assert.equal(buffers, 8);
    audio.stopAnimal(); audio.stopAnimal(); assert.ok(sources[2].stopped);
  } finally { globalThis.AudioContext = original; }
});

test('missing audio hardware never prevents playing the game', () => {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { throw new Error('unavailable'); } } as unknown as typeof AudioContext;
  try { assert.doesNotThrow(() => new GameAudio(true).playAnimal(1)); }
  finally { globalThis.AudioContext = original; }
});

for (const action of ['stop', 'mute', 'newer'] as const) {
  test(`pending decoding cannot replay after ${action}`, async () => {
    const original = globalThis.AudioContext;
    const resolvers: ((buffer: object) => void)[] = [];
    const played: unknown[] = [];
    class Context {
      state = 'running'; destination = {};
      decodeAudioData() { return new Promise(resolve => resolvers.push(resolve)); }
      createBufferSource() { return { buffer: null, connect() {}, disconnect() {}, stop() {}, start() { played.push(this.buffer); } }; }
    }
    globalThis.AudioContext = Context as unknown as typeof AudioContext;
    try {
      const audio = new GameAudio(true);
      const pending = audio.playAnimal(1);
      let newer: Promise<void> | undefined;
      if (action === 'stop') audio.stopAnimal();
      if (action === 'mute') audio.enabled = false;
      if (action === 'newer') newer = audio.playAnimal(2);
      resolvers.forEach((resolve, i) => resolve({ rank: i + 1 }));
      await Promise.all([pending, newer]);
      assert.deepEqual(played, action === 'newer' ? [{ rank: 2 }] : []);
    } finally { globalThis.AudioContext = original; }
  });
}
