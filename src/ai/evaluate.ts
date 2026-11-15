import { captureKind, neighbors } from '../game/engine';
import { otherSide, pieceKey, sideOf } from '../game/types';
import type { Observation, Piece, PublicCell, Side } from '../game/types';

export const WIN = 100000;
export const ADJACENT = Array.from({ length: 16 }, (_, index) => neighbors(index));
export interface Evaluation {
  material: number;
  safety: number;
  mobility: number;
  coordination: number;
  pursuit: number;
  score: number;
}

export function terminalValue(position: Observation, side: Side): number | null {
  if (!position.result) return null;
  return position.result.winner === null ? 0 : sideOf(position, position.result.winner) === side ? WIN : -WIN;
}

/** 随剩余克制关系变化：鼠不是永远最弱，消失的对手也不再构成战略威胁。 */
export function materialValues(position: Observation): Map<string, number> {
  const remaining = [...position.unseen, ...position.board.flatMap(cell => cell?.kind === 'piece' ? [cell.piece] : [])];
  const values = new Map<string, number>();
  for (const piece of remaining) {
    const enemies = remaining.filter(other => other.side !== piece.side);
    const prey = enemies.filter(other => captureKind(piece, other) === 'single').length;
    const hunters = enemies.filter(other => captureKind(other, piece) === 'single').length;
    const peers = enemies.some(other => other.rank === piece.rank);
    const invulnerable = hunters === 0 ? (peers ? 45 : 85) : 0;
    values.set(pieceKey(piece), 90 + prey * 17 + invulnerable + 24 / (1 + hunters));
  }
  return values;
}

function attackers(board: PublicCell[], index: number, piece: Piece): number[] {
  return ADJACENT[index].filter(from => {
    const cell = board[from];
    return cell?.kind === 'piece' && captureKind(cell.piece, piece) !== null;
  });
}

/** 评价整张公开棋盘；调试分项也不读取任何真实暗格身份。 */
export function evaluate(position: Observation, perspective: Side): Evaluation {
  const terminal = terminalValue(position, perspective);
  if (terminal !== null) return { material: 0, safety: 0, mobility: 0, coordination: 0, pursuit: 0, score: terminal };
  const values = materialValues(position);
  const value = (piece: Piece) => values.get(pieceKey(piece))!;
  const board = position.board;
  const visible = board.flatMap((cell, index) => cell?.kind === 'piece' ? [{ piece: cell.piece, index }] : []);
  const turn = sideOf(position, position.turn);
  const terms = { material: 0, safety: 0, mobility: 0, coordination: 0, pursuit: 0, score: 0 };
  for (const piece of position.unseen) terms.material += (piece.side === perspective ? 1 : -1) * value(piece);
  for (const { piece, index } of visible) {
    const sign = piece.side === perspective ? 1 : -1;
    const worth = value(piece), threats = attackers(board, index, piece);
    terms.material += sign * worth;
    let safeMoves = 0, exits = 0, supported = 0;
    for (const to of ADJACENT[index]) {
      if (board[to] === null) {
        exits++;
        if (attackers(board, to, piece).length === 0) safeMoves++;
      }
      const friend = board[to];
      if (friend?.kind === 'piece' && friend.piece.side === piece.side) {
        // 只有能对当前攻击者形成回击的邻子才算协防，不能用“挨在一起”代替配合。
        if (threats.some(from => {
          const enemy = board[from];
          return enemy?.kind === 'piece' && captureKind(friend.piece, enemy.piece) !== null;
        })) supported++;
      }
    }
    terms.mobility += sign * (safeMoves * 8 + exits * 1.2);
    if (threats.length) {
      let loss = 0;
      for (const from of threats) {
        const enemy = board[from] as Extract<PublicCell, { kind: 'piece' }>;
        const mutual = enemy.piece.rank === piece.rank;
        const defended = ADJACENT[index].some(defender => {
          const friend = board[defender];
          return defender !== from && friend?.kind === 'piece' && friend.piece.side === piece.side && captureKind(friend.piece, enemy.piece) !== null;
        });
        const exchange = worth - (mutual || defended ? value(enemy.piece) : 0);
        loss = Math.max(loss, exchange);
      }
      const urgency = turn !== piece.side ? .76 : safeMoves ? .17 : .52;
      terms.safety -= sign * (loss * urgency + Math.max(0, threats.length - 1) * 9);
      if (safeMoves === 0) terms.safety -= sign * 18;
    }
    terms.coordination += sign * Math.min(supported, 2) * 9;

    // 在可通行的空格上寻找安全路线，不能隔着暗棋或己方棋子按直线“追击”。
    const distance = new Int8Array(16).fill(-1), queue = [index]; distance[index] = 0;
    for (let head = 0; head < queue.length; head++) {
      const from = queue[head];
      for (const to of ADJACENT[from]) {
        if (distance[to] !== -1 || board[to] !== null) continue;
        if (attackers(board, to, piece).length > 0) continue;
        distance[to] = distance[from] + 1; queue.push(to);
      }
    }
    let pressure = 0;
    for (const enemy of visible) {
      if (enemy.piece.side === piece.side || captureKind(piece, enemy.piece) === null) continue;
      let approach = 20;
      for (const adj of ADJACENT[enemy.index]) if (distance[adj] >= 0) approach = Math.min(approach, distance[adj] + 1);
      if (approach < 20) {
        const gain = piece.rank === enemy.piece.rank ? Math.max(10, value(enemy.piece) - worth + 25) : value(enemy.piece);
        pressure = Math.max(pressure, gain * .24 / approach);
      }
    }
    terms.pursuit += sign * pressure;
    // 每个敌方可用出口被己方控制时计入围堵，不把没有可达性的中心站位当优势。
    const enemySide = otherSide(piece.side);
    for (const to of ADJACENT[index]) {
      if (board[to] !== null) continue;
      const targets = visible.filter(enemy => enemy.piece.side === enemySide && ADJACENT[enemy.index].includes(to) && captureKind(piece, enemy.piece) !== null);
      terms.coordination += sign * targets.length * 3;
    }
  }
  let score = terms.material + terms.safety + terms.mobility + terms.coordination + terms.pursuit;
  // 临近静步结算时，未能兑现的静态优势估计逐渐收缩；终局胜负由共用规则引擎决定。
  if (position.quietPlies > 10) score *= Math.max(.15, (20 - position.quietPlies) / 10);
  terms.score = score;
  return terms;
}
