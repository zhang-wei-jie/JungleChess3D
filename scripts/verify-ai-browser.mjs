import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// 对已启动的生产预览做真实坐标操作；不会读取真实暗棋或调用开发场景注入接口。
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const url = args.url ?? 'http://127.0.0.1:4173/';
const out = args.out ?? '/tmp/jungle-ai-browser';
const offline = args.offline !== 'false';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [], external = [], requestsWhileOffline = [], checks = [], timings = [];
let offlineNow = false;
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => {
  if (!request.url().startsWith('http')) return;
  if (new URL(request.url()).origin !== new URL(url).origin) external.push(request.url());
  if (offlineNow) requestsWhileOffline.push(request.url());
});
const state = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name); console.log('PASS', name); };
async function start(level) {
  offlineNow = false; await context.setOffline(false);
  await page.goto(url);
  await page.waitForFunction(() => typeof window.render_game_to_text === 'function');
  await page.locator(`[data-difficulty="${level}"]`).click();
  await page.locator('#start-button').click();
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).mode === 'game');
  if (offline) { await context.setOffline(true); offlineNow = true; }
}
async function act(action) {
  const s = await state();
  const tap = async index => { const { x, y } = s.board[index].click; await page.touchscreen.tap(x, y); };
  if (action.type === 'flip') await tap(action.at);
  else { await tap(action.from); await tap(action.to); }
}
async function ready() {
  await page.waitForFunction(() => {
    const s = JSON.parse(window.render_game_to_text());
    return (s.mode === 'result' && s.modal === 'result' && !s.busy)
      || (s.mode === 'game' && s.turn === 'human' && !s.busy && !s.modal);
  }, null, { timeout: 12000 });
}
async function thinking() {
  await page.evaluate(() => window.advanceTime(1000));
  await page.waitForFunction(() => {
    const s = JSON.parse(window.render_game_to_text()); return s.turn === 'computer' && s.busy;
  });
  await page.waitForTimeout(150);
}
async function humanFlip() {
  const s = await state();
  await act(s.legalActions.find(action => action.type === 'flip'));
  await thinking();
}
try {
  for (const level of ['beginner', 'easy', 'normal', 'hard', 'expert']) {
    await start(level);
    const begin = performance.now();
    await act({ type: 'flip', at: 5 });
    await ready();
    const s = await state();
    timings.push({ level, firstTurnMs: performance.now() - begin });
    check(`${level} 首次 Worker 决策完成`, [s.ply, s.turn, s.modal], [2, 'human', null]);
    check(`${level} 暗格只输出 hidden`, s.board.filter(item => item.cell?.kind === 'hidden').every(item => Object.keys(item.cell).length === 1), true);
  }

  // 专家档延长到五秒，分别检查已完成回合与正在计算时的取消边界。
  await page.locator('#undo-button').click();
  check('完整回合悔棋', [(await state()).ply, (await state()).undosLeft], [0, 2]);
  await humanFlip();
  await page.screenshot({ path: `${out}/expert-thinking.png` });
  await page.locator('#undo-button').click();
  check('思考中撤销首翻与阵营', [(await state()).ply, (await state()).humanSide, (await state()).undosLeft], [0, null, 1]);
  await page.waitForTimeout(5400);
  check('过期专家结果不落入悔棋状态', (await state()).ply, 0);

  await humanFlip();
  const beforePause = (await state()).ply, beforeClick = performance.now();
  await page.locator('#game-screen [data-action="rules"]').click();
  const responseMs = performance.now() - beforeClick;
  timings.push({ interaction: 'expert-rules', responseMs });
  check('专家计算没有阻塞界面响应', responseMs < 1000, true);
  check('专家思考中规则弹窗响应', (await state()).modal, 'rules');
  await page.waitForTimeout(5400);
  check('规则弹窗暂停对局', (await state()).ply, beforePause);
  await page.screenshot({ path: `${out}/expert-paused.png` });
  await page.locator('#modal .primary-button[data-action="close"]').click();
  await ready();
  check('关闭弹窗恢复一次行动', (await state()).ply, beforePause + 1);

  await humanFlip();
  await page.locator('#game-screen [data-action="settings"]').click();
  await page.locator('#modal [data-action="restart"]').click();
  await page.locator('#modal [data-action="confirm-restart"]').click();
  await page.waitForTimeout(5400);
  check('思考中重开隔离旧结果', [(await state()).ply, (await state()).undosLeft], [0, 3]);

  await humanFlip();
  await page.locator('#game-screen [data-action="exit"]').click();
  await page.locator('#modal [data-action="confirm-exit"]').click();
  await page.waitForTimeout(5400);
  check('思考中退出不被旧结果重新开局', (await state()).mode, 'home');

  // 用公开合法行动驱动一整局，覆盖真正的 Worker 循环与结算；无测试状态注入。
  await start('normal');
  let seed = 8021, humanMoves = 0;
  while ((await state()).mode !== 'result' && humanMoves < 120) {
    const s = await state();
    const captures = s.legalActions.filter(action => action.type === 'move' && s.board[action.to].cell?.kind === 'piece');
    const flips = s.legalActions.filter(action => action.type === 'flip');
    const candidates = captures.length ? captures : flips.length ? flips : s.legalActions;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    await act(candidates[Math.floor(seed / 4294967296 * candidates.length)]);
    humanMoves++; await ready();
  }
  const end = await state();
  check('普通难度完整对局正常结算', end.mode, 'result');
  check('结算后禁止悔棋', await page.locator('#undo-button').isDisabled(), true);
  await page.screenshot({ path: `${out}/normal-result.png` });
  await page.locator('#modal [data-action="confirm-restart"]').click();
  check('再来一局沿用难度', [(await state()).difficulty, (await state()).ply], ['normal', 0]);
  check('无页面或控制台异常', errors, []);
  check('不依赖外部服务', external, []);
  if (offline) check('离线期间无 HTTP 请求', requestsWhileOffline, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ browser: await browser.version(), viewport: { width: 390, height: 844 }, offline, checks, timings, fullGame: { humanMoves, plies: end.ply, result: end.result }, errors, external, requestsWhileOffline }, null, 2));
} finally { await browser.close(); }
