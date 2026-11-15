import type { Action, Actor, GameState, Observation, Piece, PublicCell, Rank, Side } from './types';
import { otherActor, otherSide, pieceKey, sideOf } from './types';

export function neighbors(index: number): number[] {
  const row = Math.floor(index / 4), col = index % 4;
  return [row > 0 ? index - 4 : -1, col < 3 ? index + 1 : -1,
    row < 3 ? index + 4 : -1, col > 0 ? index - 1 : -1].filter(i => i >= 0);
}

/** 判断攻击能否消灭守方；null 表示吃不掉，不代表不能发起攻击。友方也返回 null，合法性另行判断。 */
export function captureKind(attacker: Piece, defender: Piece): 'single' | 'mutual' | null {
  if (attacker.side === defender.side) return null;
  if (attacker.rank === defender.rank) return 'mutual';
  if (attacker.rank === 1 && defender.rank === 8) return 'single';
  if (attacker.rank === 8 && defender.rank === 1) return null;
  return attacker.rank > defender.rank ? 'single' : null;
}

export function positionKey(position: Pick<Observation, 'board' | 'turn' | 'humanSide'>): string {
  return `${position.humanSide ?? '-'}|${position.turn}|${position.board.map(cell =>
    cell === null ? '.' : cell.kind === 'hidden' ? '?' : pieceKey(cell.piece)).join(',')}`;
}

export function observe(state: GameState): Observation {
  // 仅公开剩余集合；必须规范排序，不能把真实暗棋在棋盘上的顺序传给 AI。
  const unseen = state.board.filter(cell => cell && !cell.revealed).map(cell => ({ ...cell!.piece }))
    .sort((a, b) => pieceKey(a).localeCompare(pieceKey(b)));
  return {
    ...state,
    board: state.board.map(cell => cell === null ? null : cell.revealed
      ? { kind: 'piece', piece: { ...cell.piece } } : { kind: 'hidden' }),
    unseen,
    repetitions: { ...state.repetitions },
  };
}

export function newGame(random: () => number = Math.random): GameState {
  const pieces: Piece[] = [];
  for (const side of ['red', 'blue'] as const) {
    for (let rank = 1; rank <= 8; rank++) pieces.push({ side, rank: rank as Rank });
  }
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }
  const state: GameState = {
    board: pieces.map(piece => ({ piece, revealed: false })), humanSide: null,
    turn: 'human', ply: 0, quietPlies: 0, repetitions: {}, result: null, lastAction: null,
  };
  state.repetitions[positionKey(observe(state))] = 1;
  return state;
}

export function isLegal(position: Observation, action: Action): boolean {
  if (position.result) return false;
  if (action.type === 'flip') return Number.isInteger(action.at) && position.board[action.at]?.kind === 'hidden';
  if (!Number.isInteger(action.from) || !Number.isInteger(action.to) || !neighbors(action.from).includes(action.to)) return false;
  const source = position.board[action.from], target = position.board[action.to];
  if (source?.kind !== 'piece' || source.piece.side !== sideOf(position, position.turn) || target === undefined) return false;
  return target === null || (target.kind === 'piece' && source.piece.side !== target.piece.side);
}

export function legalActions(position: Observation): Action[] {
  if (position.result) return [];
  const actions: Action[] = [];
  position.board.forEach((cell, index) => {
    if (cell?.kind === 'hidden') actions.push({ type: 'flip', at: index });
    if (cell?.kind === 'piece' && cell.piece.side === sideOf(position, position.turn)) {
      for (const to of neighbors(index)) {
        const action: Action = { type: 'move', from: index, to };
        if (isLegal(position, action)) actions.push(action);
      }
    }
  });
  return actions;
}

export function pieceCounts(position: Observation): Record<Side, number> {
  const counts = { red: 0, blue: 0 };
  for (const piece of position.unseen) counts[piece.side]++;
  for (const cell of position.board) if (cell?.kind === 'piece') counts[cell.piece.side]++;
  return counts;
}

/** 真实对局与概率搜索共用的规则转换；暗棋结果只能作为本次翻牌的显式参数传入。 */
export function advanceObservation(position: Observation, action: Action, flipped?: Piece): Observation {
  if (!isLegal(position, action)) throw new Error('不是合法行动');
  const board: PublicCell[] = position.board.slice();
  let unseen = position.unseen;
  let humanSide = position.humanSide;
  let progress = action.type === 'flip';
  if (action.type === 'flip') {
    const index = flipped ? unseen.findIndex(piece => piece.side === flipped.side && piece.rank === flipped.rank) : -1;
    if (index < 0 || !flipped) throw new Error('翻牌结果不在未公开棋子集合中');
    unseen = unseen.filter((_, i) => i !== index);
    board[action.at] = { kind: 'piece', piece: { ...flipped } };
    if (humanSide === null) humanSide = flipped.side;
  } else {
    const source = board[action.from] as Extract<PublicCell, { kind: 'piece' }>;
    const target = board[action.to];
    progress = target !== null;
    const capture = target?.kind === 'piece' ? captureKind(source.piece, target.piece) : 'single';
    // 攻击失败同样消耗回合并减少棋子：进攻者退场，守方留在原格，静步也归零。
    board[action.to] = capture === 'mutual' ? null : capture === 'single' ? source : target;
    board[action.from] = null;
  }
  const next: Observation = {
    ...position, board, unseen, humanSide, turn: otherActor(position.turn), ply: position.ply + 1,
    quietPlies: progress ? 0 : position.quietPlies + 1, lastAction: action,
    repetitions: { ...position.repetitions }, result: null,
  };
  const key = positionKey(next);
  next.repetitions[key] = (next.repetitions[key] ?? 0) + 1;
  const counts = pieceCounts(next);
  const winnerForSide = (side: Side): Actor => side === humanSide ? 'human' : 'computer';
  // 常规胜负、重复局面优先于静步结算；最后同级双消必须保留进攻方。
  if (counts.red === 0 && counts.blue === 0) next.result = { winner: position.turn, reason: 'last-clash' };
  else if (counts.red === 0 || counts.blue === 0) next.result = { winner: winnerForSide(counts.red === 0 ? 'blue' : 'red'), reason: 'elimination' };
  else if (unseen.length === 0 && legalActions(next).length === 0) next.result = { winner: position.turn, reason: 'blocked' };
  else if (next.repetitions[key] >= 3) next.result = { winner: null, reason: 'repetition' };
  else if (next.quietPlies >= 20) {
    // 只要还有暗棋就判和，不使用未公开身份比较大小或触发鼠象例外。
    if (board.some(cell => cell?.kind === 'hidden')) next.result = { winner: null, reason: 'quiet-hidden' };
    else {
      const ranks: Record<Side, Rank[]> = { red: [], blue: [] };
      for (const cell of board) if (cell?.kind === 'piece') ranks[cell.piece.side].push(cell.piece.rank);
      const largest = { red: Math.max(...ranks.red), blue: Math.max(...ranks.blue) };
      // 仅剩一只象的一方遇到敌鼠即败；象方还有其他棋子时仍按固定等级比较。
      const ratWinner: Side | null = counts.red === 1 && largest.red === 8 && ranks.blue.includes(1) ? 'blue'
        : counts.blue === 1 && largest.blue === 8 && ranks.red.includes(1) ? 'red' : null;
      const winner = ratWinner ?? (largest.red === largest.blue ? null : largest.red > largest.blue ? 'red' : 'blue');
      next.result = { winner: winner === null ? null : winnerForSide(winner), reason: ratWinner ? 'quiet-rat' : 'quiet' };
    }
  }
  return next;
}

export function applyAction(state: GameState, action: Action): GameState {
  const flipped = action.type === 'flip' ? state.board[action.at]?.piece : undefined;
  const next = advanceObservation(observe(state), action, flipped);
  const board = state.board.slice();
  if (action.type === 'flip') board[action.at] = { piece: { ...flipped! }, revealed: true };
  else {
    const target = next.board[action.to];
    // 采用公开规则结算后的实际存活者，不能默认目标格总是由进攻者占据。
    board[action.to] = target?.kind === 'piece' ? { piece: { ...target.piece }, revealed: true } : null;
    board[action.from] = null;
  }
  const { unseen: _unseen, ...shared } = next;
  return { ...shared, board };
}

export function actionDescription(position: Observation, action: Action): string {
  if (action.type === 'flip') return '翻开一枚暗棋';
  const target = position.board[action.to];
  const source = position.board[action.from];
  if (source?.kind === 'piece' && target?.kind === 'piece') {
    const capture = captureKind(source.piece, target.piece);
    return capture === 'mutual' ? '同级相遇，双方退场' : capture === 'single' ? '吃掉对方棋子' : '攻击失败，己方棋子被吃掉';
  }
  return '移动一枚棋子';
}

export { otherSide };
