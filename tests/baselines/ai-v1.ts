// 升级前的决策实现，仅用于新旧对战；参数冻结，避免新难度配置改变对照组。
import { advanceObservation, captureKind, legalActions, neighbors, positionKey } from '../../src/game/engine';
import { actionKey, pieceKey, sideOf } from '../../src/game/types';
import type { Action, Difficulty, Observation, Piece, Side } from '../../src/game/types';
const DIFFICULTIES = [
  { id: 'beginner', depth: 0, budget: 0 }, { id: 'easy', depth: 1, budget: 100 },
  { id: 'normal', depth: 2, budget: 250 }, { id: 'hard', depth: 4, budget: 1000 },
  { id: 'expert', depth: 6, budget: 2000 },
];

export interface SearchOptions { random?: () => number; maxNodes?: number; timeLimit?: number }
export interface SearchResult { action: Action; depth: number; nodes: number; elapsed: number }
const VALUES = [0, 5, 7, 10, 13, 17, 22, 29, 36];
const STOP = Symbol('搜索预算已用完');

function threatened(position: Observation, at: number, piece: Piece): boolean {
  return neighbors(at).some(index => {
    const cell = position.board[index];
    return cell?.kind === 'piece' && captureKind(cell.piece, piece) !== null;
  });
}

/** 评价只依赖公开棋子、公开剩余集合和当前已知位置。 */
function evaluate(position: Observation, perspective: Side): number {
  if (position.result) return position.result.winner === null ? 0
    : sideOf(position, position.result.winner) === perspective ? 10000 : -10000;
  let score = 0;
  for (const piece of position.unseen) score += (piece.side === perspective ? 1 : -1) * VALUES[piece.rank];
  position.board.forEach((cell, index) => {
    if (cell?.kind !== 'piece') return;
    const sign = cell.piece.side === perspective ? 1 : -1;
    const options = neighbors(index).filter(i => position.board[i] === null).length;
    const vulnerable = threatened(position, index, cell.piece);
    // 轮到的一方仍有机会脱离威胁；不能把双方的即时威胁视为同时吃子。
    const danger = cell.piece.side === sideOf(position, position.turn) ? 0.18 : 0.52;
    score += sign * (VALUES[cell.piece.rank] + options * 0.45 - (vulnerable ? VALUES[cell.piece.rank] * danger : 0));
  });
  return score;
}

function expected(position: Observation, action: Action, value: (next: Observation) => number): number {
  if (action.type === 'move') return value(advanceObservation(position, action));
  // 每种尚未公开的棋子在该暗格具有相同概率，绝不使用真实棋盘填充搜索。
  let total = 0;
  for (const piece of position.unseen) total += value(advanceObservation(position, action, piece));
  return total / position.unseen.length;
}

export function chooseAction(position: Observation, difficulty: Difficulty, options: SearchOptions = {}): SearchResult {
  const start = performance.now();
  const config = DIFFICULTIES.find(item => item.id === difficulty)!;
  const actions = legalActions(position);
  if (!actions.length) throw new Error('当前局面没有合法行动');
  const random = options.random ?? Math.random;
  if (difficulty === 'beginner') return { action: actions[Math.floor(random() * actions.length)], depth: 0, nodes: 0, elapsed: performance.now() - start };
  const perspective = sideOf(position, position.turn);
  if (!perspective) throw new Error('电脑阵营尚未确定');
  const deadline = start + (options.timeLimit ?? config.budget);
  let nodes = 0;
  const maxNodes = options.maxNodes ?? Infinity;
  function checkpoint() {
    nodes++;
    if (nodes > maxNodes || performance.now() >= deadline) throw STOP;
  }
  const ranked = actions.map(action => ({ action, value: expected(position, action, next => evaluate(next, perspective)), tie: random() }))
    .sort((a, b) => b.value - a.value || a.tie - b.tie);
  let best = ranked[0].action, completedDepth = 1;
  if (difficulty === 'easy') {
    if (random() < 0.24) best = actions[Math.floor(random() * actions.length)];
    return { action: best, depth: 1, nodes, elapsed: performance.now() - start };
  }
  const cache = new Map<string, number>();
  function search(current: Observation, depth: number): number {
    checkpoint();
    if (depth === 0 || current.result) return evaluate(current, perspective!);
    // 判和与路径有关，缓存键包含重复记录和静步数，避免复用错误的终局评价。
    const cacheKey = `${positionKey(current)}|${current.unseen.map(pieceKey).join(',')}|${current.quietPlies}|${depth}|${JSON.stringify(current.repetitions)}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const maximizing = sideOf(current, current.turn) === perspective;
    let bestValue = maximizing ? -Infinity : Infinity;
    const moves = legalActions(current).sort((a, b) => Number(b.type === 'move' && current.board[b.to] !== null) - Number(a.type === 'move' && current.board[a.to] !== null));
    for (const action of moves) {
      checkpoint();
      const value = expected(current, action, next => search(next, depth - 1));
      bestValue = maximizing ? Math.max(bestValue, value) : Math.min(bestValue, value);
    }
    if (cache.size < 30000) cache.set(cacheKey, bestValue);
    return bestValue;
  }
  try {
    for (let depth = 2; depth <= config.depth; depth++) {
      let iterationBest = best, bestValue = -Infinity;
      const order = [...ranked].sort((a, b) => Number(actionKey(b.action) === actionKey(best)) - Number(actionKey(a.action) === actionKey(best)));
      for (const { action } of order) {
        checkpoint();
        const value = expected(position, action, next => search(next, depth - 1));
        if (value > bestValue) { bestValue = value; iterationBest = action; }
      }
      best = iterationBest; completedDepth = depth;
      if (bestValue >= 10000) break;
    }
  } catch (error) { if (error !== STOP) throw error; }
  return { action: best, depth: completedDepth, nodes, elapsed: performance.now() - start };
}
