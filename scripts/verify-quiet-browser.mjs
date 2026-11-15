import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// 使用开发模式的固定残局，通过真实棋盘坐标走出第 20 步并检查界面与公开结果。
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const url = args.url ?? 'http://127.0.0.1:5183/';
const out = args.out ?? '/tmp/jungle-quiet';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [], errors = [], results = [];
const check = (name, actual, expected = true) => { assert.deepEqual(actual, expected, name); checks.push(name); };
const state = page => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const settleDialog = page => page.locator('.modal-card').evaluate(async card => {
  await Promise.all(card.getAnimations({ subtree: true })
    .filter(animation => animation.effect.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished));
});
const scenarios = [
  ['quiet-draw', null, 'quiet', '双方最大棋子相同'],
  ['quiet-hidden', null, 'quiet-hidden', '场上仍有暗棋'],
  ['quiet-rank-win', 'human', 'quiet', '最大棋子较大的一方获胜'],
  ['quiet-rank-loss', 'computer', 'quiet', '最大棋子较大的一方获胜'],
  ['quiet-rat-win', 'human', 'quiet-rat', '有鼠的一方获胜'],
  ['quiet-rat-loss', 'computer', 'quiet-rat', '有鼠的一方获胜'],
  ['quiet-elephant-with-ally', 'human', 'quiet', '最大棋子较大的一方获胜'],
  ['quiet-repetition', null, 'repetition', '相同局面与行棋方已出现三次'],
  ['quiet-rat-computer', 'computer', 'quiet-rat', '有鼠的一方获胜'],
];

try {
  for (const [width, height, reducedMotion] of [[320, 568, 'no-preference'], [390, 844, 'no-preference'], [1440, 900, 'no-preference'], [390, 844, 'reduce']]) {
    const tag = `${width}-${reducedMotion}`;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url);
    await page.waitForFunction(() => typeof window.__loadTestFixture === 'function');
    await page.locator('[data-difficulty="beginner"]').click();
    for (const [name, winner, reason, text] of scenarios) {
      await page.evaluate(name => window.__loadTestFixture(name), name);
      if (name !== 'quiet-rat-computer') {
        const before = await state(page);
        check(`${tag} ${name} 初始静步为 19 且未结束`, [before.quietPlies, before.result], [19, null]);
        for (const at of [0, 1]) {
          const { x, y } = (await state(page)).board[at].click;
          await page.mouse.click(x, y);
        }
      }
      await page.waitForFunction(() => {
        const s = JSON.parse(window.render_game_to_text());
        return s.mode === 'result' && s.modal === 'result' && !s.busy;
      }, null, { timeout: 12000 });
      await settleDialog(page);
      const after = await state(page);
      check(`${tag} ${name} 正确结算`, after.result, { winner, reason });
      check(`${tag} ${name} 第 20 步结束且无后续行动`, [after.quietPlies, after.ply, after.legalActions], [20, 20, []]);
      check(`${tag} ${name} 胜负标题`, await page.locator('#modal-title').textContent(), winner === null ? '本局平局' : winner === 'human' ? '对局胜利' : '本局惜败');
      const description = await page.locator('.result-reason').textContent();
      check(`${tag} ${name} 原因准确且与棋局提示一致`, description.includes(text) && await page.locator('#move-hint').textContent() === description);
      check(`${tag} ${name} 结算后禁悔棋`, await page.locator('#undo-button').isDisabled());
      const layout = await page.evaluate(() => {
        const content = document.querySelector('#modal .modal-content').getBoundingClientRect();
        const reason = document.querySelector('.result-reason').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('#modal .modal-actions button')].map(button => button.getBoundingClientRect());
        return { reasonVisible: reason.top >= content.top && reason.bottom <= content.bottom + 1,
          buttonsVisible: buttons.every(rect => rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth),
          noOverflow: document.documentElement.scrollWidth <= innerWidth };
      });
      check(`${tag} ${name} 原因与结算按钮完整显示`, layout, { reasonVisible: true, buttonsVisible: true, noOverflow: true });
      await page.screenshot({ path: `${out}/${tag}-${name}.png` });
      results.push({ viewport: tag, scenario: name, state: after, description });
    }
    await page.locator('#modal [data-action="confirm-restart"]').click();
    const restarted = await state(page);
    check(`${tag} 再来一局恢复初始状态`, [restarted.result, restarted.quietPlies, restarted.ply, restarted.undosLeft], [null, 0, 0, 3]);
    await page.locator('#game-screen [data-action="rules"]').click();
    await settleDialog(page);
    const rules = await page.locator('#modal').textContent();
    check(`${tag} 规则包含全部结算边界`, ['还有暗棋', '仅剩一只象', '无论鼠方有几枚棋子', '不比较数量或第二大的棋子', '优先按重复局面判平局', '包括攻击失败、同级双消'].every(text => rules.includes(text)));
    const rule = page.locator('.rules-list li').filter({ hasText: '连续 20 步如何结算' });
    await rule.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/${tag}-rules.png` });
    await page.locator('.rule-note').scrollIntoViewIfNeeded();
    const button = await page.locator('#modal .primary-button[data-action="close"]').boundingBox();
    check(`${tag} 规则可滚动到底且确认按钮在视口内`, button.y >= 0 && button.y + button.height <= height);
    await page.locator('#modal .primary-button[data-action="close"]').click();
    check(`${tag} 关闭规则回到对局`, (await state(page)).modal, null);
    await context.close();
    console.log('PASS', tag);
  }
  check('无页面与控制台错误', errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ browser: await browser.version(), checks, errors, results }, null, 2));
  console.log(`通过 ${checks.length} 项浏览器断言`);
} finally {
  await browser.close();
}
