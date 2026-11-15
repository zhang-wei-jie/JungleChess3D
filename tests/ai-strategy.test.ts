import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAction } from '../src/ai/search';
import { evaluate, materialValues } from '../src/ai/evaluate';
import { advanceObservation, isLegal, legalActions, observe, positionKey } from '../src/game/engine';
import type { Cell, GameState, Observation, Rank, Side } from '../src/game/types';
import { fixture } from '../src/test-bridge';

function random(seed = 91) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
function position(pieces: [number, Side, Rank, boolean?][], extra: Partial<GameState> = {}): Observation {
  const board: (Cell | null)[] = Array(16).fill(null);
  for (const [index, side, rank, revealed = true] of pieces) board[index] = { piece: { side, rank }, revealed };
  const visible = observe({ board, humanSide: 'red', turn: 'computer', ply: 0, quietPlies: 0, repetitions: {}, result: null, lastAction: null, ...extra });
  visible.repetitions[positionKey(visible)] = 1;
  return visible;
}
const search = (p: Observation, maxNodes = 15000) => chooseAction(p, 'hard', { maxNodes, timeLimit: 5000, random: random() });

/** 测试用小残局穷举裁判：只验证可证胜负，不使用 AI 评价、剪枝、缓存或搜索评分。 */
function forceWin(p: Observation, actor: 'human' | 'computer', remaining: number): boolean {
  if (p.result) return p.result.winner === actor;
  if (!remaining) return false;
  const replies = legalActions(p).map(action => advanceObservation(p, action));
  return p.turn === actor ? replies.some(next => forceWin(next, actor, remaining - 1))
    : replies.every(next => forceWin(next, actor, remaining - 1));
}

describe('全局判断与固定战术', () => {
  it('鼠的价值随对方象是否存活变化，象也能识别敌鼠消失后的优势', () => {
    const mouseVsElephant = materialValues(position([[0, 'blue', 1], [15, 'red', 8]])).get('b1')!;
    const mouseVsCat = materialValues(position([[0, 'blue', 1], [15, 'red', 2]])).get('b1')!;
    assert.ok(mouseVsElephant > mouseVsCat);
    const exposedElephant = materialValues(position([[0, 'blue', 8], [15, 'red', 1]])).get('b8')!;
    const secureElephant = materialValues(position([[0, 'blue', 8], [15, 'red', 2]])).get('b8')!;
    assert.ok(secureElephant > exposedElephant);
  });
  it('交换评价不会贪吃被象保护的猫而丢掉狮子', () => {
    const p = position([[5, 'blue', 7], [6, 'red', 2], [7, 'red', 8], [13, 'red', 1], [0, 'blue', 3]]);
    const result = search(p);
    assert.ok(isLegal(p, result.action));
    assert.notDeepEqual(result.action, { type: 'move', from: 5, to: 6 });
  });
  for (const level of ['beginner', 'easy', 'normal', 'hard', 'expert'] as const) {
    it(`${level}不会无视鼠的即时威胁翻牌送掉最后一只象`, () => {
      const p = position([[5, 'blue', 8], [6, 'red', 1], [15, 'red', 2, false]]);
      const result = chooseAction(p, level, { maxNodes: 5000, timeLimit: 5000, random: random() });
      assert.equal(result.action.type, 'move');
      assert.notDeepEqual(result.action, { type: 'move', from: 5, to: 6 });
      assert.equal(advanceObservation(p, result.action).result, null);
    });
    it(`${level}将小攻大列为合法候选，但有安全退路时不会送掉最后一枚棋子`, () => {
      const p = position([[5, 'blue', 2], [6, 'red', 6], [15, 'red', 3, false]]);
      assert.ok(isLegal(p, { type: 'move', from: 5, to: 6 }));
      const result = chooseAction(p, level, { maxNodes: 5000, timeLimit: 5000, random: random() });
      assert.equal(result.action.type, 'move');
      assert.notDeepEqual(result.action, { type: 'move', from: 5, to: 6 });
      assert.equal(advanceObservation(p, result.action).result, null);
    });
    it(`${level}仅剩失败攻击时仍能返回合法行动并正确判负`, () => {
      const p = observe(fixture('forced-failed-attack-computer'));
      const result = chooseAction(p, level, { maxNodes: 1000, timeLimit: 5000, random: random() });
      assert.ok(isLegal(p, result.action));
      assert.deepEqual(advanceObservation(p, result.action).result, { winner: 'human', reason: 'elimination' });
    });
  }
  it('允许弱子攻击不会把弱子误判为强子的吃子威胁', () => {
    const p = position([[5, 'blue', 7], [6, 'red', 2]]);
    assert.ok(isLegal(p, { type: 'move', from: 5, to: 6 }));
    const values = materialValues(p);
    // 此时只有猫受狮子威胁；安全项仅扣除猫的风险，不应再扣狮子的损失。
    assert.ok(Math.abs(evaluate(p, 'blue').safety - values.get('r2')! * .76) < 1e-8);
  });
  it('两子协同限制两条退路，所选行动经独立穷举确认可强制获胜', () => {
    const p = position([[0, 'red', 1], [6, 'blue', 2], [8, 'blue', 3]]);
    assert.ok(forceWin(p, 'computer', 5));
    const result = search(p);
    assert.ok(forceWin(advanceObservation(p, result.action), 'computer', 4));
  });
  it('需要七步的围堵会先调动远处棋子，保持可证的强制胜利', () => {
    const p = position([[5, 'red', 1], [7, 'blue', 2], [13, 'blue', 3]]);
    assert.equal(forceWin(p, 'computer', 5), false);
    assert.ok(forceWin(p, 'computer', 7));
    const result = search(p);
    assert.ok(forceWin(advanceObservation(p, result.action), 'computer', 6));
  });
  it('没有眼前吃子时会沿可达路线接近弱子', () => {
    const p = position([[0, 'red', 1], [15, 'blue', 2], [12, 'blue', 3]]);
    const result = search(p);
    assert.equal(result.action.type, 'move');
    if (result.action.type === 'move') {
      const distance = (at: number) => Math.floor(at / 4) + at % 4;
      assert.ok(distance(result.action.to) < distance(result.action.from));
    }
  });
  it('优势临近 20 静步时翻牌继续争胜，不主动走成平局', () => {
    const p = position([[0, 'blue', 8], [15, 'red', 2, false]], { quietPlies: 19 });
    assert.deepEqual(search(p).action, { type: 'flip', at: 15 });
  });
  it('仍有暗棋的劣势局面能选择第 20 静步求和', () => {
    const p = position([[0, 'blue', 1], [15, 'red', 2], [14, 'red', 3, false]], { quietPlies: 19 });
    const next = advanceObservation(p, search(p).action);
    assert.deepEqual(next.result, { winner: null, reason: 'quiet-hidden' });
  });
  for (const level of ['beginner', 'easy', 'normal', 'hard', 'expert'] as const) {
    it(`${level}识别第 20 静步的等级胜利和鼠胜单象`, () => {
      for (const [blue, red, reason] of [[3, 2, 'quiet'], [1, 8, 'quiet-rat']] as const) {
        const p = position([[0, 'blue', blue], [15, 'red', red]], { quietPlies: 19 });
        const chosen = chooseAction(p, level, { maxNodes: 5000, timeLimit: 5000, random: random() }).action;
        assert.deepEqual(advanceObservation(p, chosen).result, { winner: 'computer', reason });
      }
    });
    it(`${level}能交战续局时避免走第 20 静步按等级判负`, () => {
      const p = position([[5, 'blue', 2], [6, 'red', 1], [15, 'red', 3]], { quietPlies: 19 });
      const chosen = chooseAction(p, level, { maxNodes: 5000, timeLimit: 5000, random: random() }).action;
      assert.deepEqual(chosen, { type: 'move', from: 5, to: 6 });
      const next = advanceObservation(p, chosen);
      assert.equal(next.result, null); assert.equal(next.quietPlies, 0);
    });
  }
  it('存在强制胜利时不选第三次重复形成的平局', () => {
    const p = position([[0, 'red', 1], [6, 'blue', 2], [8, 'blue', 3]]);
    const drawAction = { type: 'move', from: 8, to: 12 } as const;
    const next = advanceObservation(p, drawAction);
    p.repetitions[positionKey(next)] = 2;
    const chosen = search(p).action;
    assert.notDeepEqual(chosen, drawAction);
    assert.ok(forceWin(advanceObservation(p, chosen), 'computer', 4));
  });
  it('换边后全局评价反号，不偏袒红方或蓝方', () => {
    const p = observe(fixture('mixed'));
    assert.ok(Math.abs(evaluate(p, 'red').score + evaluate(p, 'blue').score) < 1e-8);
  });
});

describe('搜索预算、公开概率与历史隔离', () => {
  it('节点上限覆盖最初评分，零预算直接返回合法行动而不额外搜索', () => {
    const p = observe(fixture('mixed'));
    const r = chooseAction(p, 'expert', { timeLimit: 5000, maxNodes: 0 });
    assert.equal(r.nodes, 0); assert.equal(r.simulations, 0); assert.ok(isLegal(p, r.action));
  });
  it('暗棋模拟在预算增长时累积成果，不要求完成整层', () => {
    const p = observe(fixture('mixed'));
    const early = search(p, 2500), later = search(p, 10000);
    assert.equal(early.mode, 'probability'); assert.equal(later.mode, 'probability');
    assert.ok(early.simulations > 0 && later.simulations > early.simulations);
    assert.ok(later.cacheHits > 0); assert.equal(later.nodes, 10000);
    assert.ok(later.candidates.some(candidate => candidate.visits > 1));
  });
  it('搜索不修改输入局面、剩余集合与判和历史', () => {
    const p = observe(fixture('mixed')), before = structuredClone(p);
    search(p, 3000); assert.deepEqual(p, before);
  });
  it('相同公开局面、随机源与节点预算得到完全相同的候选统计', () => {
    const p = observe(fixture('mixed'));
    const first = search(p, 7000), second = search(structuredClone(p), 7000);
    assert.deepEqual(first.candidates, second.candidates); assert.deepEqual(first.action, second.action);
  });
  it('真实暗棋换位后，完成多次概率模拟的统计仍完全一致', () => {
    const first = fixture('mixed'), second = structuredClone(first);
    [second.board[1], second.board[6]] = [second.board[6], second.board[1]];
    const a = search(observe(first), 7000), b = search(observe(second), 7000);
    assert.ok(a.simulations > 0);
    assert.deepEqual(a.candidates, b.candidates); assert.deepEqual(a.action, b.action);
  });
  it('重复历史影响结论，不能把本应平局的节点缓存为胜势', () => {
    const p = position([[0, 'blue', 8], [15, 'red', 2]]);
    for (const action of legalActions(p)) p.repetitions[positionKey(advanceObservation(p, action))] = 2;
    const next = advanceObservation(p, search(p).action);
    assert.deepEqual(next.result, { winner: null, reason: 'repetition' });
  });
});
