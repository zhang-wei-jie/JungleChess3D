import { advanceObservation, captureKind, legalActions, positionKey } from '../game/engine';
import { actionKey, DIFFICULTIES, pieceKey, sideOf } from '../game/types';
import type { Action, Difficulty, Observation, Piece } from '../game/types';
import { ADJACENT, evaluate, terminalValue, WIN } from './evaluate';

export interface SearchOptions { random?: () => number; maxNodes?: number; timeLimit?: number }
export interface SearchResult {
  action: Action;
  /** 明棋为完整迭代深度，暗棋为实际探访的最大路径长度，不混称穷尽深度。 */
  depth: number;
  nodes: number;
  elapsed: number;
  mode: 'tactical' | 'probability' | 'alphabeta';
  simulations: number;
  cacheHits: number;
  candidates: { action: Action; value: number; visits: number }[];
}
const STOP = Symbol('计算预算耗尽');
interface Entry { depth: number; value: number; flag: 'exact' | 'lower' | 'upper' }
interface Edge { action: Action; prior: number; visits: number; total: number; outcomes: Map<string, TreeNode>; chance?: Piece[] }
interface TreeNode { position: Observation; visits: number; edges: Edge[] | null }

export function chooseAction(position: Observation, difficulty: Difficulty, options: SearchOptions = {}): SearchResult {
  const start = performance.now();
  const config = DIFFICULTIES.find(item => item.id === difficulty)!;
  const deadline = start + (options.timeLimit ?? config.budget);
  const maxNodes = options.maxNodes ?? Infinity;
  const random = options.random ?? Math.random;
  const actions = legalActions(position);
  if (!actions.length) throw new Error('当前局面没有合法行动');
  const perspective = sideOf(position, position.turn);
  if (!perspective) throw new Error('电脑阵营尚未确定');
  let nodes = 0, depth = 0, simulations = 0, cacheHits = 0;
  let best = actions[0];
  let mode: SearchResult['mode'] = 'tactical';
  const result = (): SearchResult => ({ action: best, depth, nodes, elapsed: performance.now() - start, mode,
    simulations, cacheHits, candidates: root.filter(item => Number.isFinite(item.value)).map(item => ({ action: item.action, value: item.value, visits: item.visits })) });
  function tick() {
    if (nodes >= maxNodes || performance.now() >= deadline) throw STOP;
    nodes++;
  }
  const evalCache = new Map<string, number>();
  const moveOrderCache = new Map<string, string>();
  const table = new Map<string, Entry>();
  function staticValue(current: Observation): number {
    const terminal = terminalValue(current, perspective!);
    if (terminal !== null) return terminal;
    const key = `${positionKey(current)}|${current.unseen.map(pieceKey).join(',')}|${current.quietPlies}`;
    const hit = evalCache.get(key);
    if (hit !== undefined) { cacheHits++; return hit; }
    const score = evaluate(current, perspective!).score;
    if (evalCache.size < 12000) evalCache.set(key, score);
    return score;
  }
  function signedTerminal(current: Observation, ply: number): number | null {
    const value = terminalValue(current, perspective!);
    return value === null ? null : value === 0 ? 0 : value - Math.sign(value) * ply;
  }
  function orderValue(current: Observation, action: Action): number {
    if (action.type === 'flip') {
      // 相邻己方可接应，但同样检查敌方占位；最终风险由概率节点中的真实规则判定。
      const side = sideOf(current, current.turn);
      return ADJACENT[action.at].reduce((sum, at) => {
        const neighbor = current.board[at];
        return sum + (neighbor?.kind === 'piece' ? neighbor.piece.side === side ? 2 : -2 : 0);
      }, 0);
    }
    const from = current.board[action.from], to = current.board[action.to];
    if (from?.kind !== 'piece') return -Infinity;
    if (to?.kind === 'piece') {
      const capture = captureKind(from.piece, to.piece);
      // 失败攻击可以搜索，但不能把对方的子力当成收益；优先检查能存活或换子的走法。
      return capture === null ? -100 - from.piece.rank * 4 : 100 + to.piece.rank * 4 - (capture === 'mutual' ? from.piece.rank * 4 : 0);
    }
    const danger = ADJACENT[action.from].some(at => {
      const enemy = current.board[at]; return enemy?.kind === 'piece' && captureKind(enemy.piece, from.piece) !== null;
    });
    return danger ? 30 : 0;
  }
  function ordered(current: Observation): Action[] {
    const hint = moveOrderCache.get(positionKey(current));
    return legalActions(current).sort((a, b) => (actionKey(b) === hint ? 1000 : orderValue(current, b)) - (actionKey(a) === hint ? 1000 : orderValue(current, a)));
  }
  function captures(current: Observation): Action[] {
    return ordered(current).filter(action => action.type === 'move' && current.board[action.to]?.kind === 'piece');
  }
  /** 静态叶子继续验证交战（含失败攻击），避免在“刚吃到但马上被反吃”的瞬间停止计算。 */
  function quiet(current: Observation, remaining: number, alpha = -Infinity, beta = Infinity, ply = 0): number {
    tick();
    const terminal = signedTerminal(current, ply);
    if (terminal !== null) return terminal;
    const maximizing = sideOf(current, current.turn) === perspective;
    let value = staticValue(current);
    if (remaining === 0) return value;
    if (maximizing) { if (value >= beta) return value; alpha = Math.max(alpha, value); }
    else { if (value <= alpha) return value; beta = Math.min(beta, value); }
    for (const action of captures(current)) {
      const score = quiet(advanceObservation(current, action), remaining - 1, alpha, beta, ply + 1);
      value = maximizing ? Math.max(value, score) : Math.min(value, score);
      if (maximizing) alpha = Math.max(alpha, value); else beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    return value;
  }
  function historyKey(current: Observation): string {
    // 只有仍可能再次到达的局面影响判和。吃子/翻牌后，存活数或暗牌数变少，旧阶段不可能返回。
    const hidden = current.board.filter(cell => cell?.kind === 'hidden').length;
    const occupied = current.board.filter(Boolean).length;
    const history = Object.entries(current.repetitions).filter(([key]) => {
      const cells = key.slice(key.lastIndexOf('|') + 1).split(',');
      return cells.filter(cell => cell === '?').length === hidden && cells.filter(cell => cell !== '.').length === occupied;
    }).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(history);
  }
  function alphaBeta(current: Observation, remaining: number, alpha: number, beta: number, ply: number): number {
    tick();
    const terminal = signedTerminal(current, ply);
    if (terminal !== null) return terminal;
    if (remaining <= 0) return quiet(current, 3, alpha, beta, ply);
    const key = `${positionKey(current)}|${current.quietPlies}|${ply}|${historyKey(current)}`;
    const cached = table.get(key), alphaStart = alpha, betaStart = beta;
    if (cached && cached.depth >= remaining) {
      cacheHits++;
      if (cached.flag === 'exact') return cached.value;
      if (cached.flag === 'lower') alpha = Math.max(alpha, cached.value); else beta = Math.min(beta, cached.value);
      if (alpha >= beta) return cached.value;
    }
    const maximizing = sideOf(current, current.turn) === perspective;
    let value = maximizing ? -Infinity : Infinity;
    let bestMove: Action | null = null;
    for (const action of ordered(current)) {
      const next = advanceObservation(current, action);
      const score = alphaBeta(next, remaining - 1, alpha, beta, ply + 1);
      if (maximizing ? score > value : score < value) { value = score; bestMove = action; }
      if (maximizing) alpha = Math.max(alpha, value); else beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    if (bestMove) moveOrderCache.set(positionKey(current), actionKey(bestMove));
    if (table.size < 8000) table.set(key, { depth: remaining, value,
      flag: value <= alphaStart ? 'upper' : value >= betaStart ? 'lower' : 'exact' });
    return value;
  }
  interface Candidate { action: Action; value: number; visits: number; tie: number }
  let root: Candidate[] = actions.map(action => ({ action, value: -Infinity, visits: 0, tie: random() }));
  const tacticalDepth = difficulty === 'beginner' ? 0 : difficulty === 'easy' ? 1 : 3;
  try {
    // 全部档位都优先抓直接胜机，预算也覆盖这一步与最初的候选评分。
    for (const action of actions) {
      tick();
      if (action.type !== 'move') continue;
      const next = advanceObservation(position, action);
      if (next.result?.winner === position.turn) { best = action; depth = 1; return result(); }
    }
    for (const candidate of root) {
      const outcomes = candidate.action.type === 'flip' ? position.unseen : [undefined];
      let sum = 0;
      for (const piece of outcomes) {
        tick();
        const next = advanceObservation(position, candidate.action, piece);
        sum += tacticalDepth ? quiet(next, tacticalDepth) : staticValue(next);
      }
      candidate.value = sum / outcomes.length;
      candidate.visits = 1;
      const completed = root.filter(item => item.visits > 0);
      best = completed.reduce((a, b) => b.value > a.value ? b : a).action;
    }
    root.sort((a, b) => b.value - a.value || a.tie - b.tie);
    best = root[0].action; depth = 1;
    if (difficulty === 'beginner') {
      const close = root.filter(item => item.value >= root[0].value - 22);
      best = close[Math.floor(random() * close.length)].action;
      return result();
    }
    if (difficulty === 'easy' && position.unseen.length > 0) {
      const close = root.filter(item => item.value >= root[0].value - 8);
      best = close[Math.floor(random() * close.length)].action;
      return result();
    }
    if (position.unseen.length === 0) {
      mode = 'alphabeta';
      for (let target = 2; target <= config.depth; target++) {
        let iterationBest = best, value = -Infinity;
        const previous = root.find(item => actionKey(item.action) === actionKey(best));
        const order = previous ? [previous, ...root.filter(item => item !== previous)] : root;
        for (const candidate of order) {
          tick();
          const score = alphaBeta(advanceObservation(position, candidate.action), target - 1, value, Infinity, 1);
          if (score > value) { value = score; iterationBest = candidate.action; }
        }
        best = iterationBest; depth = target;
        if (Math.abs(value) > WIN - 100) break;
      }
      return result();
    }

    mode = 'probability';
    const horizon = difficulty === 'normal' ? 6 : difficulty === 'hard' ? 10 : 16;
    // 用有界收益统计胜负和非终局评价，避免一次偶然的终局大分淹没大量不利样本。
    const utility = (score: number) => Math.tanh(score / 300);
    const rootNode: TreeNode = { position, visits: 0, edges: root.map(candidate => ({ action: candidate.action,
      prior: utility(candidate.value), visits: 0, total: 0, outcomes: new Map() })) };
    let retainedNodes = 1;
    function expand(node: TreeNode) {
      const current = node.position, maximizing = sideOf(current, current.turn) === perspective;
      const candidates = ordered(current);
      const base = staticValue(current);
      node.edges = candidates.map(action => ({ action, prior: utility(base + (maximizing ? 1 : -1) * orderValue(current, action)),
        visits: 0, total: 0, outcomes: new Map() }));
    }
    function sample(node: TreeNode, ply: number): number {
      tick(); depth = Math.max(depth, ply);
      const terminal = signedTerminal(node.position, ply);
      if (terminal !== null) return utility(terminal);
      if (ply >= horizon) return utility(quiet(node.position, 2, -Infinity, Infinity, ply));
      if (!node.edges) expand(node);
      const maximizing = sideOf(node.position, node.position.turn) === perspective;
      const sign = maximizing ? 1 : -1;
      // 带先验的 UCB：前期优先战术合理的走法，所有行动仍有被探索的机会。
      let edge = node.edges![0], priority = -Infinity;
      for (const item of node.edges!) {
        const mean = item.visits ? item.total / item.visits : item.prior;
        const score = sign * mean + 1.15 * Math.sqrt(Math.log(node.visits + 2) / (item.visits + 1)) + sign * item.prior * 2 / (item.visits + 2);
        if (score > priority) { priority = score; edge = item; }
      }
      const current = node.position;
      let piece: Piece | undefined;
      if (edge.action.type === 'flip') {
        // 分层采样：一轮覆盖每种剩余身份再重洗，减少少量样本漏看天敌造成的冒进。
        // 这里只打乱公开集合的采样次序，与真实暗格的排列没有关系。
        if (!edge.chance?.length) {
          edge.chance = current.unseen.slice();
          for (let i = edge.chance.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [edge.chance[i], edge.chance[j]] = [edge.chance[j], edge.chance[i]];
          }
        }
        piece = edge.chance.pop();
      }
      const outcomeKey = piece ? pieceKey(piece) : 'move';
      let child = edge.outcomes.get(outcomeKey);
      let score: number;
      if (!child) {
        child = { position: advanceObservation(current, edge.action, piece), visits: 0, edges: null };
        // 搜索有时间与保留树规模双重限制；到上限后仍采样评价，但不继续增长手机内存。
        if (retainedNodes < 12000) { edge.outcomes.set(outcomeKey, child); retainedNodes++; }
        depth = Math.max(depth, ply + 1);
        score = utility(quiet(child.position, 2, -Infinity, Infinity, ply + 1));
      } else score = sample(child, ply + 1);
      node.visits++; edge.visits++; edge.total += score;
      return score;
    }
    while (true) {
      sample(rootNode, 0); simulations++;
      // 每个完成的模拟立刻参与决策，不必等待整层完成；先验随样本增加逐渐退场。
      let value = -Infinity;
      for (let i = 0; i < rootNode.edges!.length; i++) {
        const edge = rootNode.edges![i];
        const mean = (edge.total + edge.prior * 6) / (edge.visits + 6);
        root[i].visits = edge.visits; root[i].value = mean * 300;
        if (mean > value) { value = mean; best = edge.action; }
      }
    }
  } catch (error) { if (error !== STOP) throw error; }
  return result();
}
