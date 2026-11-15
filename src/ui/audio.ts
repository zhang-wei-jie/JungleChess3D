export class GameAudio {
  enabled: boolean;
  private context: AudioContext | null = null;
  constructor(enabled: boolean) { this.enabled = enabled; }
  unlock() {
    if (!this.enabled) return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
    } catch { /* 无音频设备时仍保留完整棋局操作。 */ }
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
