import { DIFFICULTIES } from '../game/types';
import type { Action, Difficulty, Observation } from '../game/types';
import InlineAiWorker from './worker?worker&inline';
import { RequestGate } from './request-gate';

export class AiClient {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gate = new RequestGate();

  cancel(): void {
    this.gate.next();
    this.worker?.terminate(); this.worker = null;
    clearTimeout(this.timer);
  }

  request(observation: Observation, difficulty: Difficulty, onAction: (action: Action) => void, onError: (message: string) => void): void {
    this.cancel();
    const id = this.gate.next();
    const fail = (message: string) => { if (this.gate.isCurrent(id)) { this.cancel(); onError(message); } };
    try {
      // 生产包内联 Worker：页面加载完成后，首步思考及悔棋重建 Worker 都无需再次联网。
      this.worker = new InlineAiWorker();
      this.worker.onmessage = ({ data }) => {
        if (!this.gate.isCurrent(id) || data.id !== id) return;
        if (!data.ok) { fail(data.error || '电脑计算失败'); return; }
        this.cancel(); onAction(data.action);
      };
      this.worker.onerror = event => { event.preventDefault(); fail('电脑计算未能完成，请重试'); };
      this.timer = setTimeout(() => fail('电脑响应超时，请重试'), DIFFICULTIES.find(d => d.id === difficulty)!.budget + 3500);
      this.worker.postMessage({ id, observation, difficulty });
    } catch { fail('无法启动电脑对手，请重试或换用支持 Web Worker 的浏览器'); }
  }
}
