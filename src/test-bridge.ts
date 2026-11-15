import type { Cell, GameState, Rank, Side } from './game/types';
import { observe, positionKey } from './game/engine';

// 只在开发构建中引入固定验收场景，不提供读取真实暗棋或任意执行代码的接口。
export function fixture(name: string): GameState {
  const board: (Cell | null)[] = Array(16).fill(null);
  const put = (index: number, side: Side, rank: Rank, revealed = true) => { board[index] = { piece: { side, rank }, revealed }; };
  let turn: 'human' | 'computer' = 'human', quietPlies = 0;
  if (name === 'last-clash-human' || name === 'last-clash-computer') {
    put(5, 'red', 7); put(6, 'blue', 7);
    if (name === 'last-clash-computer') turn = 'computer';
  } else if (name === 'quiet-draw') {
    put(0, 'red', 3); put(15, 'blue', 3); quietPlies = 19;
  } else if (name === 'quiet-hidden') {
    put(0, 'red', 8); put(15, 'blue', 1); put(12, 'blue', 2, false); quietPlies = 19;
  } else if (name === 'quiet-rank-win' || name === 'quiet-rank-loss' || name === 'quiet-repetition') {
    put(0, 'red', name === 'quiet-rank-loss' ? 2 : 7); put(15, 'blue', 3); quietPlies = 19;
  } else if (name === 'quiet-rat-win' || name === 'quiet-rat-loss') {
    put(0, 'red', name === 'quiet-rat-win' ? 1 : 8); put(15, 'blue', 8);
    if (name === 'quiet-rat-loss') put(12, 'blue', 1);
    quietPlies = 19;
  } else if (name === 'quiet-elephant-with-ally') {
    put(0, 'red', 8); put(4, 'red', 2); put(15, 'blue', 1); put(12, 'blue', 3); quietPlies = 19;
  } else if (name === 'quiet-rat-computer') {
    put(0, 'red', 8); put(15, 'blue', 1); turn = 'computer'; quietPlies = 19;
  } else if (name === 'capture') {
    put(5, 'red', 8); put(6, 'blue', 2); put(15, 'blue', 3); put(12, 'red', 1);
  } else if (name === 'failed-attack' || name === 'elephant-attacks-rat' || name === 'last-failed-attack') {
    put(5, 'red', name === 'elephant-attacks-rat' ? 8 : 2);
    put(6, 'blue', name === 'elephant-attacks-rat' ? 1 : 6);
    if (name !== 'last-failed-attack') { put(12, 'red', 3); put(15, 'blue', 4); }
    quietPlies = 19;
  } else if (name === 'forced-failed-attack-computer') {
    put(0, 'blue', 1); put(1, 'red', 2); put(4, 'red', 3); turn = 'computer';
  } else if (name === 'mixed') {
    put(0, 'blue', 8); put(1, 'red', 5, false); put(2, 'blue', 3); put(3, 'blue', 1, false);
    put(4, 'red', 3, false); put(5, 'red', 2); put(6, 'red', 8, false); put(7, 'blue', 6);
    put(8, 'red', 4); put(9, 'blue', 4, false); put(10, 'blue', 5); put(11, 'red', 6, false);
    put(12, 'blue', 7, false); put(13, 'red', 7); put(14, 'blue', 2, false); put(15, 'red', 1);
  } else throw new Error('未知验收场景');
  const state: GameState = { board, humanSide: 'red', turn, ply: name.startsWith('quiet-') ? quietPlies : 12, quietPlies, repetitions: {}, lastAction: null, result: null };
  state.repetitions[positionKey(observe(state))] = 1;
  if (name === 'quiet-repetition') {
    const next = observe(state);
    next.board[1] = next.board[0]; next.board[0] = null; next.turn = 'computer';
    state.repetitions[positionKey(next)] = 2;
  }
  return state;
}

export function installTestBridge(load: (state: GameState) => void) {
  Object.assign(window, { __loadTestFixture: (name: string) => load(fixture(name)) });
}
