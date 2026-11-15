import type { Action, GameState } from './types';
import { applyAction, newGame } from './engine';

export class GameSession {
  state: GameState;
  undosLeft = 3;
  revision = 0;
  private history: GameState[] = [];

  constructor(state = newGame()) { this.state = state; }

  play(action: Action, actor: 'human' | 'computer'): void {
    if (this.state.turn !== actor || this.state.result) throw new Error('当前不能行动');
    const before = this.state;
    const next = applyAction(before, action);
    if (actor === 'human') this.history.push(before);
    this.state = next;
    this.revision++;
  }

  get canUndo(): boolean { return !this.state.result && this.undosLeft > 0 && this.history.length > 0; }

  undo(): boolean {
    if (!this.canUndo) return false;
    // 额度不属于快照：恢复棋局不能恢复已经消耗的悔棋机会。
    this.state = this.history.pop()!;
    this.undosLeft--;
    this.revision++;
    return true;
  }
}
