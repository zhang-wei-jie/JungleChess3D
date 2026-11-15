import type { Rank } from '../game/types';
import recordings from './animal-recordings.json';

export class GameAudio {
  private soundEnabled: boolean;
  private animalSource: AudioBufferSourceNode | null = null;
  private animalBuffers = new Map<Rank, Promise<AudioBuffer | null>>();
  private animalGeneration = 0;
  get enabled() { return this.soundEnabled; }
  set enabled(value: boolean) { this.soundEnabled = value; if (!value) this.stopAnimal(); }
  private context: AudioContext | null = null;
  constructor(enabled: boolean) { this.soundEnabled = enabled; }
  unlock() {
    if (!this.enabled) return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
      this.prepareAnimals(this.context);
    } catch { /* 无音频设备时仍保留完整棋局操作。 */ }
  }
  stopAnimal() {
    this.animalGeneration++;
    if (!this.animalSource) return;
    this.animalSource.stop(); this.animalSource.disconnect(); this.animalSource = null;
  }
  private prepareAnimals(ctx: AudioContext) {
    for (let rank = 1; rank <= 8; rank++) {
      const key = rank as Rank;
      if (this.animalBuffers.has(key)) continue;
      // Embedded MP3 recordings keep the first call and offline play network-free.
      const bytes = Uint8Array.from(atob(recordings[key].mp3), char => char.charCodeAt(0));
      this.animalBuffers.set(key, ctx.decodeAudioData(bytes.buffer).catch(() => null));
    }
  }
  async playAnimal(rank: Rank) {
    if (!this.enabled) return;
    this.unlock();
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    this.stopAnimal();
    const generation = this.animalGeneration;
    try {
      const buffer = await this.animalBuffers.get(rank);
      // Never replay a late decode after mute, undo, exit or a newer reveal.
      if (!buffer || !this.enabled || generation !== this.animalGeneration || ctx.state !== 'running') return;
      const source = ctx.createBufferSource();
      source.buffer = buffer; source.connect(ctx.destination);
      source.onended = () => { source.disconnect(); if (this.animalSource === source) this.animalSource = null; };
      this.animalSource = source; source.start();
    } catch { /* Audio failures must never interrupt a turn. */ }
  }
  play(kind: 'flip' | 'move' | 'capture' | 'mutual' | 'win' | 'lose' | 'draw') {
    if (!this.enabled) return;
    this.unlock();
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    const melodies = { flip: [523, 784], move: [440], capture: [659, 880, 1047], mutual: [587, 392],
      win: [523, 659, 784, 1047], lose: [440, 392, 330], draw: [523, 587, 523] };
    melodies[kind].forEach((frequency, index) => {
      const start = ctx.currentTime + index * .085;
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.065, start + .012);
      gain.gain.exponentialRampToValueAtTime(.001, start + .19);
      oscillator.connect(gain); gain.connect(ctx.destination);
      oscillator.start(start); oscillator.stop(start + .21);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
  }
}
