export type Side = 'red' | 'blue';
export type Actor = 'human' | 'computer';
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type Difficulty = 'beginner' | 'easy' | 'normal' | 'hard' | 'expert';
export interface Piece { side: Side; rank: Rank }
export interface Cell { piece: Piece; revealed: boolean }
export type PublicCell = { kind: 'hidden' } | { kind: 'piece'; piece: Piece } | null;
export type Action = { type: 'flip'; at: number } | { type: 'move'; from: number; to: number };
export type ResultReason = 'elimination' | 'last-clash' | 'blocked' | 'repetition' | 'quiet' | 'quiet-hidden' | 'quiet-rat';
export interface Result { winner: Actor | null; reason: ResultReason }
export interface Position<C> {
  board: C[];
  humanSide: Side | null;
  turn: Actor;
  ply: number;
  quietPlies: number;
  repetitions: Record<string, number>;
  result: Result | null;
  lastAction: Action | null;
}
export type GameState = Position<Cell | null>;
export interface Observation extends Position<PublicCell> { unseen: Piece[] }
export const ANIMALS: Record<Rank, string> = { 1: '鼠', 2: '猫', 3: '狗', 4: '狼', 5: '豹', 6: '虎', 7: '狮', 8: '象' };
export const DIFFICULTIES: { id: Difficulty; name: string; description: string; depth: number; budget: number }[] = [
  { id: 'beginner', name: '入门', description: '轻松过招，认识森林伙伴', depth: 1, budget: 120 },
  { id: 'easy', name: '简单', description: '观察攻守，试试你的第一步策略', depth: 2, budget: 200 },
  { id: 'normal', name: '普通', description: '有来有往，享受一场棋逢对手', depth: 4, budget: 500 },
  { id: 'hard', name: '困难', description: '多想几步，寻找棋盘里的机会', depth: 8, budget: 2000 },
  { id: 'expert', name: '专家', description: '步步为营，迎接森林里的挑战', depth: 14, budget: 5000 },
];
export const otherSide = (side: Side): Side => side === 'red' ? 'blue' : 'red';
export const otherActor = (actor: Actor): Actor => actor === 'human' ? 'computer' : 'human';
export const sideOf = (position: Pick<Observation, 'humanSide'>, actor: Actor): Side | null =>
  position.humanSide === null ? null : actor === 'human' ? position.humanSide : otherSide(position.humanSide);
export const pieceKey = (piece: Piece) => `${piece.side === 'red' ? 'r' : 'b'}${piece.rank}`;
export const actionKey = (action: Action) => action.type === 'flip' ? `f${action.at}` : `m${action.from}:${action.to}`;
