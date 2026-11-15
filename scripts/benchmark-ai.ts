import { writeFile } from 'node:fs/promises';
import { chooseAction } from '../src/ai/search';
import { chooseAction as oldAction } from '../tests/baselines/ai-v1';
import { applyAction, newGame, observe } from '../src/game/engine';
import { DIFFICULTIES } from '../src/game/types';
import type { Action, Actor, Difficulty, Result } from '../src/game/types';

const options = Object.fromEntries(process.argv.slice(2).map(argument => argument.replace(/^--/, '').split('=')));
const pairs = Number(options.pairs ?? 12), seedStart = Number(options.seed ?? 101);
const time = options.time === undefined ? undefined : Number(options.time);
const difficulty = (options.difficulty ?? 'hard') as Difficulty;
const oldDifficulty = (options.old ?? difficulty) as Difficulty;
const newTime = options.newTime === undefined ? time : Number(options.newTime);
const oldTime = options.oldTime === undefined ? time : Number(options.oldTime);
if (!Number.isInteger(pairs) || pairs < 1 || !Number.isSafeInteger(seedStart) || seedStart < 0
  || [time, newTime, oldTime].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))
  || [difficulty, oldDifficulty].some(id => !DIFFICULTIES.some(config => config.id === id))) {
  throw new Error('参数无效：pairs 应为正整数，seed 应为非负安全整数，时间应为非负毫秒，难度应为 beginner/easy/normal/hard/expert');
}
export function randomSeed(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
interface MoveLog { turn: Actor; action: Action; depth: number; elapsed: number }
interface GameLog { seed: number; newActor: Actor; outcome: 'wins' | 'losses' | 'draws' | 'truncated'; result: Result | null; plies: number; log: MoveLog[] }
const games: GameLog[] = [];
const stats = { wins: 0, losses: 0, draws: 0, truncated: 0, newMoves: 0, oldMoves: 0,
  newTime: 0, oldTime: 0, newMax: 0, oldMax: 0 };
const started = performance.now();
for (let pair = 0; pair < pairs; pair++) {
  const seed = seedStart + pair;
  for (const newActor of ['human', 'computer'] as const) {
    // 同一洗牌与首翻，交换引擎控制的角色；双方决策只能获得 observe 的公开信息。
    let game = applyAction(newGame(randomSeed(seed)), { type: 'flip', at: seed % 16 });
    const log: MoveLog[] = [];
    while (!game.result && game.ply < 240) {
      const fresh = game.turn === newActor;
      const result = (fresh ? chooseAction : oldAction)(observe(game), fresh ? difficulty : oldDifficulty,
        { random: randomSeed(seed * 1009 + game.ply * 31), timeLimit: fresh ? newTime : oldTime });
      stats[fresh ? 'newMoves' : 'oldMoves']++;
      stats[fresh ? 'newTime' : 'oldTime'] += result.elapsed;
      stats[fresh ? 'newMax' : 'oldMax'] = Math.max(stats[fresh ? 'newMax' : 'oldMax'], result.elapsed);
      log.push({ turn: game.turn, action: result.action, depth: result.depth, elapsed: result.elapsed });
      game = applyAction(game, result.action);
    }
    const outcome = !game.result ? 'truncated' : game.result.winner === null ? 'draws' : game.result.winner === newActor ? 'wins' : 'losses';
    stats[outcome]++;
    games.push({ seed, newActor, outcome, result: game.result, plies: game.ply, log });
    console.log(JSON.stringify({ seed, newActor, outcome, plies: game.ply, reason: game.result?.reason, wins: stats.wins, losses: stats.losses, draws: stats.draws }));
  }
}
const total = stats.wins + stats.losses + stats.draws;
const report = { configuration: { pairs, seedStart, difficulty, oldDifficulty, newTime: newTime ?? 'default', oldTime: oldTime ?? 'default', node: process.version },
  stats: { ...stats, scoreRate: total ? (stats.wins + stats.draws / 2) / total : null,
    newAverageMs: stats.newTime / stats.newMoves, oldAverageMs: stats.oldTime / stats.oldMoves,
    elapsedSeconds: (performance.now() - started) / 1000 }, games };
if (options.out) await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
console.log('SUMMARY', JSON.stringify(report.stats));
