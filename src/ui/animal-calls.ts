import type { Rank } from '../game/types';

// Original, lightweight cartoon calls, synthesized locally rather than downloaded.
// Each voice uses a different pitch contour, rhythm and harmonic/noise mix.
interface Syllable { start: number; length: number; pitch: number[] }
interface Voice { syllables: Syllable[]; roughness: number; brightness: number; vibrato: number }
export const ANIMAL_VOICES: Record<Rank, Voice> = {
  1: { syllables: [{ start: 0, length: .13, pitch: [2300, 3300, 2500] }, { start: .18, length: .15, pitch: [2700, 3700, 2600] }], roughness: .02, brightness: .08, vibrato: 22 }, // squeak
  2: { syllables: [{ start: 0, length: .58, pitch: [520, 840, 650, 290] }], roughness: .06, brightness: .45, vibrato: 6 }, // meow
  3: { syllables: [{ start: 0, length: .18, pitch: [350, 190, 110] }, { start: .25, length: .2, pitch: [380, 180, 100] }], roughness: .35, brightness: .7, vibrato: 34 }, // woof woof
  4: { syllables: [{ start: 0, length: .85, pitch: [270, 510, 540, 440, 290] }], roughness: .04, brightness: .2, vibrato: 5 }, // howl
  5: { syllables: [{ start: 0, length: .16, pitch: [190, 130, 100] }, { start: .22, length: .18, pitch: [170, 115, 90] }, { start: .46, length: .22, pitch: [150, 100, 75] }], roughness: .48, brightness: .65, vibrato: 28 }, // rasping leopard coughs
  6: { syllables: [{ start: 0, length: .68, pitch: [150, 210, 130, 65] }], roughness: .45, brightness: .7, vibrato: 25 }, // tiger snarl
  7: { syllables: [{ start: 0, length: .8, pitch: [90, 155, 115, 55] }], roughness: .38, brightness: .85, vibrato: 18 }, // deep lion roar
  8: { syllables: [{ start: 0, length: .72, pitch: [380, 850, 720, 430] }], roughness: .12, brightness: 1, vibrato: 11 }, // trumpet
};

export function synthesizeAnimalCall(rank: Rank, sampleRate: number): Float32Array {
  const voice = ANIMAL_VOICES[rank];
  const duration = Math.max(...voice.syllables.map(s => s.start + s.length));
  const samples = new Float32Array(Math.ceil((duration + .02) * sampleRate));
  let seed = rank * 7919, peak = 0;
  for (const syllable of voice.syllables) {
    let phase = 0, noise = 0;
    const start = Math.floor(syllable.start * sampleRate);
    for (let i = 0; i < Math.floor(syllable.length * sampleRate); i++) {
      const t = i / sampleRate, progress = t / syllable.length;
      const position = progress * (syllable.pitch.length - 1), index = Math.floor(position);
      const pitch = syllable.pitch[index] + (syllable.pitch[Math.min(index + 1, syllable.pitch.length - 1)] - syllable.pitch[index]) * (position - index);
      phase += 2 * Math.PI * pitch * (1 + .025 * Math.sin(2 * Math.PI * voice.vibrato * t)) / sampleRate;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise = noise * .65 + (seed / 0xffffffff * 2 - 1) * .35;
      const harmonic = Math.sin(phase) + voice.brightness * (.5 * Math.sin(phase * 2) + .3 * Math.sin(phase * 3) + .15 * Math.sin(phase * 5));
      const rasp = 1 - voice.roughness * .6 + voice.roughness * .6 * Math.sin(2 * Math.PI * voice.vibrato * t);
      const envelope = Math.min(1, t / .018) * Math.pow(Math.max(0, Math.sin(Math.PI * progress)), .65) * Math.min(1, (syllable.length - t) / .04);
      samples[start + i] = (harmonic * rasp + noise * voice.roughness * 2) * envelope;
      peak = Math.max(peak, Math.abs(samples[start + i]));
    }
  }
  // Equal peak loudness and a conservative gain keep larger animals from startling.
  if (peak > 0) for (let i = 0; i < samples.length; i++) samples[i] *= .23 / peak;
  return samples;
}
