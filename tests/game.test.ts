import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionDescription, advanceObservation, applyAction, captureKind, isLegal, legalActions, newGame, observe, pieceCounts, positionKey } from '../src/game/engine';
import { GameSession } from '../src/game/session';
import { chooseAction } from '../src/ai/search';
import { RequestGate } from '../src/ai/request-gate';
import { DIFFICULTIES, actionKey, pieceKey } from '../src/game/types';
import type { Action, Cell, GameState, Rank, Side } from '../src/game/types';
import { fixture } from '../src/test-bridge';

function rng(seed: number) { return () => { seed = Math.imul(seed ^ seed >>> 15, 1 | seed); seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed); return ((seed ^ seed >>> 14) >>> 0) / 4294967296; }; }
function state(pieces: [number, Side, Rank, boolean?][], overrides: Partial<GameState> = {}): GameState {
  const board: (Cell | null)[] = Array(16).fill(null);
  for (const [at, side, rank, revealed = true] of pieces) board[at] = { piece: { side, rank }, revealed };
  const position: GameState = { board, humanSide: 'red', turn: 'human', ply: 0, quietPlies: 0, repetitions: {}, result: null, lastAction: null, ...overrides };
  position.repetitions[positionKey(observe(position))] = 1;
  return position;
}

describe('初始化、信息边界与合法行动', () => {
  it('开局恰好两方八兽，16 枚均盖住，玩家先手', () => {
    const game = newGame(rng(17));
    assert.equal(game.turn, 'human'); assert.equal(game.humanSide, null);
    assert.equal(new Set(game.board.map(cell => pieceKey(cell!.piece))).size, 16);
    assert.ok(game.board.every(cell => cell && !cell.revealed));
    assert.equal(legalActions(observe(game)).length, 16);
    assert.deepEqual(pieceCounts(observe(game)), { red: 8, blue: 8 });
  });
  it('不同随机序列产生不同开局，同一序列可复现', () => {
    assert.deepEqual(newGame(rng(42)), newGame(rng(42)));
    assert.notDeepEqual(newGame(rng(42)).board, newGame(rng(91)).board);
  });
  for (const side of ['red', 'blue'] as const) it(`首翻 ${side} 分配给玩家，翻牌后直接轮到电脑`, () => {
    const game = newGame(rng(19));
    const at = game.board.findIndex(cell => cell!.piece.side === side);
    const next = applyAction(game, { type: 'flip', at });
    assert.equal(next.humanSide, side); assert.equal(next.turn, 'computer');
    assert.equal(next.board.filter(cell => cell?.revealed).length, 1);
    assert.equal(game.board[at]!.revealed, false);
  });
  it('相同公开局面不会泄露暗棋位置或剩余数组顺序', () => {
    const first = newGame(rng(3)), second = structuredClone(first);
    second.board.reverse();
    assert.deepEqual(observe(first), observe(second));
    assert.ok(observe(first).board.every(cell => JSON.stringify(cell) === '{"kind":"hidden"}'));
  });
  it('允许上下左右一步，拒绝斜走、跨行、跳跃、友军、暗棋及越界', () => {
    const observation = observe(state([[5, 'red', 8], [6, 'red', 2], [4, 'blue', 3, false], [15, 'blue', 7]]));
    assert.ok(isLegal(observation, { type: 'move', from: 5, to: 1 }));
    assert.ok(isLegal(observation, { type: 'move', from: 5, to: 9 }));
    for (const to of [4, 6, 0, 7, 13, -1, 16]) assert.equal(isLegal(observation, { type: 'move', from: 5, to }), false);
    const edge = observe(state([[3, 'red', 8], [15, 'blue', 7]]));
    assert.equal(isLegal(edge, { type: 'move', from: 3, to: 4 }), false);
    assert.equal(isLegal(observation, { type: 'move', from: 15, to: 14 }), false);
    assert.equal(isLegal(observation, { type: 'flip', at: 5 }), false);
    assert.ok(isLegal(observation, { type: 'flip', at: 4 }));
  });
  it('非法行动抛错且不改写局面', () => {
    const game = newGame(rng(1)), before = structuredClone(game);
    assert.throws(() => applyAction(game, { type: 'move', from: 0, to: 1 }));
    assert.deepEqual(game, before);
  });
});

describe('吃子、胜负与平局', () => {
  it('完整 8×8 吃子矩阵符合大小、鼠象与同级例外', () => {
    for (let a = 1; a <= 8; a++) for (let b = 1; b <= 8; b++) {
      const expected = a === b ? 'mutual' : a === 1 && b === 8 ? 'single' : a === 8 && b === 1 ? null : a > b ? 'single' : null;
      assert.equal(captureKind({ side: 'red', rank: a as Rank }, { side: 'blue', rank: b as Rank }), expected);
      assert.equal(captureKind({ side: 'red', rank: a as Rank }, { side: 'red', rank: b as Rank }), null);
    }
  });
  it('普通吃子留下进攻者，静步归零', () => {
    const game = state([[5, 'red', 8], [6, 'blue', 2], [15, 'blue', 3]], { quietPlies: 19 });
    const next = applyAction(game, { type: 'move', from: 5, to: 6 });
    assert.equal(next.board[5], null); assert.equal(next.board[6]?.piece.rank, 8);
    assert.equal(next.quietPlies, 0); assert.equal(next.result, null);
  });
  for (const actor of ['human', 'computer'] as const) it(`${actor} 的全部 8×8 交战都合法，真实与搜索棋盘按同一规则结算`, () => {
    const side: Side = actor === 'human' ? 'red' : 'blue', enemy: Side = side === 'red' ? 'blue' : 'red';
    for (let a = 1; a <= 8; a++) for (let b = 1; b <= 8; b++) {
      const game = state([[5, side, a as Rank], [6, enemy, b as Rank]], { turn: actor, quietPlies: 19 });
      const before = structuredClone(game), visible = observe(game), action = { type: 'move', from: 5, to: 6 } as const;
      const wins = a === 1 && b === 8 || a > b && !(a === 8 && b === 1);
      assert.ok(isLegal(visible, action));
      assert.ok(legalActions(visible).some(candidate => actionKey(candidate) === actionKey(action)));
      const next = applyAction(game, action);
      assert.equal(next.board[5], null);
      assert.deepEqual(next.board[6], a === b ? null : before.board[wins ? 5 : 6]);
      assert.equal(next.turn, actor === 'human' ? 'computer' : 'human');
      assert.equal(next.ply, 1); assert.equal(next.quietPlies, 0);
      assert.deepEqual(next.result, { winner: a === b || wins ? actor : next.turn, reason: a === b ? 'last-clash' : 'elimination' });
      assert.deepEqual(observe(next), advanceObservation(visible, action));
      assert.deepEqual(game, before);
    }
  });
  it('小攻大失败后守方原位，己方暗棋仍算存活且静步归零', () => {
    const game = state([[5, 'red', 2], [6, 'blue', 6], [15, 'red', 3, false]], { quietPlies: 19 });
    const next = applyAction(game, { type: 'move', from: 5, to: 6 });
    assert.equal(next.board[5], null); assert.deepEqual(next.board[6], game.board[6]);
    assert.equal(next.result, null); assert.equal(next.quietPlies, 0);
    assert.deepEqual(next.board[15], game.board[15]);
    assert.deepEqual(pieceCounts(observe(next)), { red: 1, blue: 1 });
    assert.equal(next.repetitions[positionKey(observe(next))], 1);
    assert.equal(next.repetitions[positionKey(observe(game))], 1);
  });
  it('行动文案区分吃子、失败攻击、鼠象克制及同级双消', () => {
    const move = { type: 'move', from: 5, to: 6 } as const;
    const description = (a: Rank, b: Rank) => actionDescription(observe(state([[5, 'red', a], [6, 'blue', b]])), move);
    assert.equal(description(2, 6), '攻击失败，己方棋子被吃掉');
    assert.equal(description(8, 1), '攻击失败，己方棋子被吃掉');
    assert.equal(description(1, 8), '吃掉对方棋子');
    assert.equal(description(6, 2), '吃掉对方棋子');
    assert.equal(description(2, 2), '同级相遇，双方退场');
  });
  it('普通同级对撞两枚消失，其他棋子继续对局', () => {
    const next = applyAction(state([[5, 'red', 7], [6, 'blue', 7], [0, 'red', 2], [15, 'blue', 3]], { quietPlies: 19 }), { type: 'move', from: 5, to: 6 });
    assert.equal(next.board[5], null); assert.equal(next.board[6], null); assert.equal(next.result, null); assert.equal(next.quietPlies, 0);
  });
  for (const actor of ['human', 'computer'] as const) it(`最后同级对撞由主动 ${actor} 获胜，优先于平局`, () => {
    const game = fixture(`last-clash-${actor}`);
    game.quietPlies = 19;
    const action: Action = actor === 'human' ? { type: 'move', from: 5, to: 6 } : { type: 'move', from: 6, to: 5 };
    assert.deepEqual(applyAction(game, action).result, { winner: actor, reason: 'last-clash' });
  });
  it('最后普通吃子消灭对手时直接获胜', () => {
    const next = applyAction(state([[5, 'red', 8], [6, 'blue', 7]]), { type: 'move', from: 5, to: 6 });
    assert.deepEqual(next.result, { winner: 'human', reason: 'elimination' });
  });
  it('未翻开的己方棋子仍存活，不会过早判负', () => {
    const next = applyAction(state([[5, 'red', 8], [6, 'blue', 2], [15, 'blue', 3, false]]), { type: 'move', from: 5, to: 6 });
    assert.equal(next.result, null); assert.deepEqual(pieceCounts(observe(next)), { red: 1, blue: 1 });
    assert.ok(legalActions(observe(next)).some(action => action.type === 'flip'));
  });
  it('被强敌堵住仍可主动攻击，最后一枚攻击失败才判负', () => {
    const next = applyAction(state([[0, 'blue', 1], [4, 'red', 3], [5, 'red', 2]]), { type: 'move', from: 5, to: 1 });
    assert.equal(next.result, null);
    assert.deepEqual(legalActions(observe(next)), [{ type: 'move', from: 0, to: 1 }, { type: 'move', from: 0, to: 4 }]);
    const lost = applyAction(next, { type: 'move', from: 0, to: 1 });
    assert.deepEqual(lost.result, { winner: 'human', reason: 'elimination' });
    assert.equal(lost.board[0], null); assert.deepEqual(lost.board[1], next.board[1]);
  });
  it('还有暗棋时即使明棋被堵住，仍可翻牌', () => {
    const next = applyAction(state([[0, 'blue', 1], [4, 'red', 3], [5, 'red', 2], [15, 'blue', 8, false]]), { type: 'move', from: 5, to: 1 });
    assert.equal(next.result, null); assert.ok(isLegal(observe(next), { type: 'flip', at: 15 }));
  });
  it('第 19 个静步不结束，第 20 个静步由最大棋子较大的一方获胜', () => {
    const first = applyAction(state([[0, 'red', 2], [15, 'blue', 3]], { quietPlies: 18 }), { type: 'move', from: 0, to: 1 });
    assert.equal(first.quietPlies, 19); assert.equal(first.result, null);
    const second = applyAction(first, { type: 'move', from: 15, to: 14 });
    assert.equal(second.quietPlies, 20);
    assert.deepEqual(second.result, { winner: 'computer', reason: 'quiet' });
  });
  it('翻牌重置静步计数', () => {
    const next = applyAction(state([[0, 'red', 2], [15, 'blue', 3, false]], { quietPlies: 19 }), { type: 'flip', at: 15 });
    assert.equal(next.quietPlies, 0); assert.equal(next.result, null);
  });
  it('第三次相同局面和行棋方出现时平局', () => {
    let game = state([[0, 'red', 2], [15, 'blue', 3]]);
    const cycle: Action[] = [{ type: 'move', from: 0, to: 1 }, { type: 'move', from: 15, to: 14 }, { type: 'move', from: 1, to: 0 }, { type: 'move', from: 14, to: 15 }];
    for (const action of cycle) game = applyAction(game, action);
    assert.equal(game.result, null);
    for (const action of cycle) game = applyAction(game, action);
    assert.deepEqual(game.result, { winner: null, reason: 'repetition' });
  });
  it('棋盘相同但行棋方不同，不算同一局面', () => {
    const position = observe(state([[0, 'red', 2], [15, 'blue', 3]]));
    assert.notEqual(positionKey(position), positionKey({ ...position, turn: 'computer' }));
  });
  it('终局后拒绝继续操作', () => {
    const game = applyAction(fixture('last-clash-human'), { type: 'move', from: 5, to: 6 });
    assert.deepEqual(legalActions(observe(game)), []);
    assert.throws(() => applyAction(game, { type: 'move', from: 0, to: 1 }));
  });
});

describe('20 静步的暗棋、鼠象例外和最大棋子结算', () => {
  for (const humanSide of ['red', 'blue'] as const) for (const turn of ['human', 'computer'] as const) {
    it(`玩家执 ${humanSide}、${turn} 走第 20 步时，双方单子完整 8×8 结算且真实与搜索一致`, () => {
      for (let red = 1; red <= 8; red++) for (let blue = 1; blue <= 8; blue++) {
        const game = state([[0, 'red', red as Rank], [15, 'blue', blue as Rank]], { humanSide, turn, quietPlies: 19 });
        const redMoves = (turn === 'human') === (humanSide === 'red');
        const action: Action = { type: 'move', from: redMoves ? 0 : 15, to: redMoves ? 1 : 14 };
        const before = structuredClone(game), visible = observe(game);
        const ratException = red === 1 && blue === 8 || red === 8 && blue === 1;
        const winnerSide = red === blue ? null : ratException ? (red === 1 ? 'red' : 'blue') : red > blue ? 'red' : 'blue';
        const next = applyAction(game, action);
        assert.deepEqual(next.result, {
          winner: winnerSide === null ? null : winnerSide === humanSide ? 'human' : 'computer',
          reason: ratException ? 'quiet-rat' : 'quiet',
        }, `红${red}、蓝${blue}`);
        assert.deepEqual(observe(next), advanceObservation(visible, action));
        assert.deepEqual(game, before);
        assert.deepEqual(legalActions(observe(next)), []);
      }
    });
  }
  const cases: { name: string; red: Rank[]; blue: Rank[]; winner: Side | null; reason: 'quiet' | 'quiet-rat' }[] = [
    { name: '仅剩象对鼠加狗，鼠方获胜', red: [8], blue: [1, 3], winner: 'blue', reason: 'quiet-rat' },
    { name: '仅剩象对鼠加象，最大同级也由鼠方获胜', red: [8], blue: [1, 8], winner: 'blue', reason: 'quiet-rat' },
    { name: '象方另有猫时不触发鼠象例外', red: [8, 2], blue: [1, 3], winner: 'red', reason: 'quiet' },
    { name: '象方另有鼠时不触发鼠象例外', red: [8, 1], blue: [1, 3], winner: 'red', reason: 'quiet' },
    { name: '双方多个棋子且最大相同，不比较第二大', red: [8, 2], blue: [8, 1], winner: null, reason: 'quiet' },
    { name: '最大相同，不比较数量', red: [7], blue: [7, 3, 2], winner: null, reason: 'quiet' },
    { name: '仅剩象且对方没有鼠时按等级获胜', red: [8], blue: [7, 6], winner: 'red', reason: 'quiet' },
    { name: '普通等级较大的一方不受棋子数量影响', red: [6], blue: [5, 4, 3], winner: 'red', reason: 'quiet' },
  ];
  for (const item of cases) it(`${item.name}，换边结果对称`, () => {
    for (const swap of [false, true]) {
      const redSide = swap ? 'blue' : 'red', blueSide = swap ? 'red' : 'blue';
      const pieces: [number, Side, Rank][] = [
        ...item.red.map((rank, i): [number, Side, Rank] => [i * 4, redSide, rank]),
        ...item.blue.map((rank, i): [number, Side, Rank] => [15 - i * 4, blueSide, rank]),
      ];
      const game = state(pieces, { humanSide: redSide, quietPlies: 19 });
      const next = applyAction(game, { type: 'move', from: 0, to: 1 });
      assert.deepEqual(next.result, { winner: item.winner === null ? null : item.winner === 'red' ? 'human' : 'computer', reason: item.reason });
    }
  });
  for (const hiddenSide of ['red', 'blue'] as const) it(`${hiddenSide} 方还有暗棋时优先平局，不比较等级或应用鼠象例外`, () => {
    for (const hiddenRank of [2, 7] as const) {
      const game = state([[0, 'red', 8], [15, 'blue', 1], [12, hiddenSide, hiddenRank, false]], { quietPlies: 19 });
      const action: Action = { type: 'move', from: 0, to: 1 };
      const next = applyAction(game, action);
      assert.deepEqual(next.result, { winner: null, reason: 'quiet-hidden' });
      assert.deepEqual(observe(next), advanceObservation(observe(game), action));
      assert.deepEqual(next.board[12], game.board[12]);
    }
  });
  it('对方仅剩暗棋时仍按 20 静步平局，不误判全灭', () => {
    const game = state([[0, 'red', 8], [15, 'blue', 1, false]], { quietPlies: 19 });
    assert.deepEqual(applyAction(game, { type: 'move', from: 0, to: 1 }).result, { winner: null, reason: 'quiet-hidden' });
  });
  it('第三次重复与 20 静步同时触发时，优先重复平局', () => {
    for (const [red, blue] of [[7, 3], [8, 1]] as const) {
      const game = state([[0, 'red', red], [15, 'blue', blue]], { quietPlies: 19 });
      const action: Action = { type: 'move', from: 0, to: 1 };
      const key = positionKey(observe(applyAction(game, action)));
      game.repetitions[key] = 2;
      assert.deepEqual(applyAction(game, action).result, { winner: null, reason: 'repetition' });
    }
  });
  it('20 静步胜负结算后不可悔棋或继续行动', () => {
    const session = new GameSession(fixture('quiet-rat-win'));
    session.play({ type: 'move', from: 0, to: 1 }, 'human');
    assert.deepEqual(session.state.result, { winner: 'human', reason: 'quiet-rat' });
    assert.equal(session.undo(), false);
    assert.throws(() => session.play({ type: 'move', from: 15, to: 14 }, 'computer'));
  });
});

describe('悔棋额度、状态恢复和取消边界', () => {
  it('首翻后立即悔棋，阵营、暗牌原位置和全部记录恢复', () => {
    const game = newGame(rng(9)), session = new GameSession(game);
    session.play({ type: 'flip', at: 4 }, 'human');
    assert.equal(session.undo(), true); assert.deepEqual(session.state, game);
    assert.equal(session.undosLeft, 2); assert.equal(session.canUndo, false);
  });
  it('一次悔棋撤销玩家及电脑两步，最多 3 次且额度不随快照恢复', () => {
    const game = newGame(rng(13)), session = new GameSession(game);
    for (let i = 0; i < 3; i++) {
      session.play({ type: 'flip', at: 0 }, 'human');
      session.play({ type: 'flip', at: 1 }, 'computer');
      assert.equal(session.undo(), true); assert.deepEqual(session.state, game);
      assert.equal(session.undosLeft, 2 - i);
    }
    session.play({ type: 'flip', at: 0 }, 'human');
    assert.equal(session.undo(), false); assert.equal(session.state.ply, 1);
    assert.equal(new GameSession().undosLeft, 3);
  });
  it('静步和重复记录随悔棋准确恢复', () => {
    const game = state([[0, 'red', 2], [15, 'blue', 3]], { quietPlies: 8 });
    const session = new GameSession(game);
    session.play({ type: 'move', from: 0, to: 1 }, 'human');
    session.play({ type: 'move', from: 15, to: 14 }, 'computer');
    session.undo(); assert.deepEqual(session.state, game);
  });
  for (const computerReply of [false, true]) it(`失败攻击${computerReply ? '及电脑回应后' : '立即'}悔棋恢复棋子、回合与历史`, () => {
    const game = fixture('failed-attack'), session = new GameSession(game);
    session.play({ type: 'move', from: 5, to: 6 }, 'human');
    assert.equal(session.state.board[5], null); assert.equal(session.state.quietPlies, 0);
    if (computerReply) session.play({ type: 'move', from: 6, to: 5 }, 'computer');
    assert.ok(session.undo()); assert.deepEqual(session.state, game); assert.equal(session.undosLeft, 2);
  });
  it('最后一枚攻击失败后立即结算，不能悔棋或继续操作', () => {
    const session = new GameSession(fixture('last-failed-attack'));
    session.play({ type: 'move', from: 5, to: 6 }, 'human');
    assert.deepEqual(session.state.result, { winner: 'computer', reason: 'elimination' });
    assert.equal(session.undo(), false); assert.deepEqual(legalActions(observe(session.state)), []);
    assert.throws(() => session.play({ type: 'move', from: 6, to: 5 }, 'computer'));
  });
  it('无历史和终局都不能悔棋，无效动作不产生历史', () => {
    const session = new GameSession(fixture('last-clash-human'));
    assert.equal(session.canUndo, false);
    assert.throws(() => session.play({ type: 'move', from: 0, to: 1 }, 'human'));
    assert.equal(session.canUndo, false);
    session.play({ type: 'move', from: 5, to: 6 }, 'human'); assert.equal(session.undo(), false);
  });
  it('取消或新请求后，旧 AI 请求标识永远失效', () => {
    const gate = new RequestGate(), old = gate.next();
    assert.ok(gate.isCurrent(old)); const next = gate.next();
    assert.equal(gate.isCurrent(old), false); assert.ok(gate.isCurrent(next));
    gate.next(); assert.equal(gate.isCurrent(next), false);
  });
});

describe('公平 AI 与可复现搜索', () => {
  it('概率节点仅允许公开剩余集合中的翻牌结果', () => {
    const position = observe(state([[0, 'red', 2], [15, 'blue', 3, false]]));
    assert.throws(() => advanceObservation(position, { type: 'flip', at: 15 }, { side: 'red', rank: 8 }));
    const next = advanceObservation(position, { type: 'flip', at: 15 }, { side: 'blue', rank: 3 });
    assert.equal(next.unseen.length, 0);
  });
  for (const config of DIFFICULTIES) {
    it(`${config.name}返回合法行动，交换真实暗棋不影响相同预算下的决策`, () => {
      const game = fixture('mixed'); game.turn = 'computer';
      const alternate = structuredClone(game), hidden = alternate.board.flatMap((cell, i) => cell && !cell.revealed ? [i] : []);
      [alternate.board[hidden[0]], alternate.board[hidden[1]]] = [alternate.board[hidden[1]], alternate.board[hidden[0]]];
      const observation = observe(game), other = observe(alternate);
      assert.deepEqual(observation, other);
      const first = chooseAction(observation, config.id, { random: rng(57), maxNodes: 1000, timeLimit: 5000 });
      const second = chooseAction(other, config.id, { random: rng(57), maxNodes: 1000, timeLimit: 5000 });
      assert.ok(isLegal(observation, first.action)); assert.equal(actionKey(first.action), actionKey(second.action));
    });
  }
  for (const difficulty of ['normal', 'hard', 'expert'] as const) it(`${difficulty}识别最后同级对撞为主动获胜`, () => {
    const observation = observe(fixture('last-clash-computer'));
    const choice = chooseAction(observation, difficulty, { random: rng(33), timeLimit: 1000 });
    assert.deepEqual(choice.action, { type: 'move', from: 6, to: 5 });
  });
  it('鼠象例外会进入电脑合法吃子和终局判断', () => {
    const observation = observe(state([[5, 'blue', 1], [6, 'red', 8]], { turn: 'computer' }));
    const choice = chooseAction(observation, 'normal', { random: rng(11) });
    assert.deepEqual(choice.action, { type: 'move', from: 5, to: 6 });
  });
  it('普通档会逃离鼠的即时威胁，而非翻牌导致己方被全灭', () => {
    const observation = observe(state([[5, 'blue', 8], [6, 'red', 1], [15, 'red', 2, false]], { turn: 'computer' }));
    const choice = chooseAction(observation, 'normal', { random: rng(44), timeLimit: 1000 });
    assert.equal(choice.action.type, 'move');
  });
  it('不同档位具有不同的搜索深度上限', () => {
    assert.deepEqual(DIFFICULTIES.map(item => item.depth), [1, 2, 4, 8, 14]);
    const observation = observe(state([[0, 'blue', 2], [15, 'red', 3]], { turn: 'computer' }));
    const normal = chooseAction(observation, 'normal', { timeLimit: 5000, maxNodes: 50000, random: rng(1) });
    const hard = chooseAction(observation, 'hard', { timeLimit: 5000, maxNodes: 50000, random: rng(1) });
    assert.ok(normal.depth >= 4); assert.ok(hard.depth > normal.depth);
  });
  it('预算不足时返回已有的合法候选，不泄露或伪造行动', () => {
    const choice = chooseAction(observe(fixture('mixed')), 'expert', { maxNodes: 0, timeLimit: 0, random: rng(1) });
    assert.ok(isLegal(observe(fixture('mixed')), choice.action));
  });
  it('批量合法随机对局保持棋子数和阵营不变量，并能结束', () => {
    let ended = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const random = rng(seed); let game = newGame(random);
      for (let i = 0; i < 500 && !game.result; i++) {
        const observation = observe(game), actions = legalActions(observation);
        assert.ok(actions.length > 0);
        const action = actions[Math.floor(random() * actions.length)], next = applyAction(game, action);
        const before = game.board.filter(Boolean).length, after = next.board.filter(Boolean).length;
        assert.ok(after <= before && before - after <= 2);
        assert.equal(new Set(next.board.filter(Boolean).map(cell => pieceKey(cell!.piece))).size, after);
        assert.equal(next.board.length, 16); assert.notEqual(next.turn, game.turn);
        game = next;
      }
      if (game.result) ended++;
    }
    assert.equal(ended, 12);
  });
});
