import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// 生产版验证加载失败和重试，开发版借助已有残局验证连续键盘操作及全屏布局。
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const url = args.url ?? 'http://127.0.0.1:4173/';
const devUrl = args['dev-url'] ?? 'http://127.0.0.1:5173/';
const out = args.out ?? '/tmp/jungle-review-fixes';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [], errors = [], expectedNetworkErrors = [], layouts = [];
const check = (name, actual, expected = true) => { assert.deepEqual(actual, expected, name); checks.push(name); };
const state = page => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const focusedCell = page => page.evaluate(() => document.activeElement.dataset.cell ?? null);
function watch(page, injectedFailure = false) {
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (injectedFailure && message.text().includes('net::ERR_FAILED')) expectedNetworkErrors.push(message.text());
    else errors.push(message.text());
  });
}
async function loadFixture(page) {
  await page.evaluate(() => window.__loadTestFixture('capture'));
}
async function ready(page) {
  await page.waitForFunction(() => {
    const s = JSON.parse(window.render_game_to_text());
    return s.turn === 'human' && s.ply === 14 && !s.busy && !s.modal;
  });
}
async function visibleButton(page, selector) {
  return page.locator(selector).evaluate(button => {
    const r = button.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
      && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === button;
  });
}

try {
  for (const scenario of ['early', 'late', 'multiple']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); watch(page, true);
    // 统计实际图片解码完成情况，确保错误页在所有迟到任务完成后仍保留。
    await page.addInitScript(() => {
      window.__reviewPendingImages = 0;
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        window.__reviewPendingImages++;
        return decode.call(this).finally(() => window.__reviewPendingImages--);
      };
    });
    let release, inject = true;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/assets/*.webp', async route => {
      if (!inject) return route.continue();
      const name = new URL(route.request().url()).pathname.split('/').pop();
      if (scenario === 'late') {
        if (name === 'back.webp') { await gate; return route.abort('failed'); }
      } else {
        if (name === 'back.webp') return route.abort('failed');
        await gate;
        if (scenario === 'multiple' && name === 'blue-1.webp') return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (scenario === 'late') {
      await page.waitForFunction(() => document.querySelector('.loading-screen')?.textContent.includes('97%'));
      release();
    }
    await page.locator('.error-screen').waitFor();
    check(`${scenario} 明确显示失败图片`, (await page.locator('.error-screen').innerText()).includes('图片加载失败：back'));
    release();
    await page.waitForFunction(() => window.__reviewPendingImages === 0);
    check(`${scenario} 所有任务结束后仍保留错误页`, await page.locator('.error-screen').count(), 1);
    check(`${scenario} 重试入口仍可操作`, await visibleButton(page, '.plain-retry'));
    check(`${scenario} 不伪装为完成或继续加载`, await page.locator('.loading-track, #home-screen').count(), 0);
    await page.screenshot({ path: `${out}/load-${scenario}.png` });
    inject = false;
    await page.locator('.plain-retry').click();
    await page.waitForFunction(() => typeof window.render_game_to_text === 'function');
    check(`${scenario} 恢复资源后点击重试进入大厅`, (await state(page)).mode, 'home');
    check(`${scenario} 页面标题正确`, await page.title(), '斗兽棋 · 森林翻牌对战');
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); watch(page);
  await page.goto(devUrl);
  await page.waitForFunction(() => typeof window.__loadTestFixture === 'function');
  await page.locator('[data-difficulty="normal"]').click();
  await loadFixture(page);
  await page.locator('#accessible-board [data-cell="5"]').focus();
  await page.keyboard.press('Enter');
  check('辅助棋盘选子后保持第 5 格焦点', await focusedCell(page), '5');
  check('辅助棋盘公布选中状态', await page.locator('#accessible-board [data-cell="5"]').getAttribute('aria-pressed'), 'true');
  check('选子成功且尚未走子', [(await state(page)).selected, (await state(page)).ply], [5, 12]);
  await page.keyboard.press('Tab');
  check('Tab 顺序继续到第 6 格', await focusedCell(page), '6');
  await page.keyboard.press('Enter');
  check('连续键盘操作成功吃子', (await state(page)).board[6].cell, { kind: 'piece', piece: { side: 'red', rank: 8 } });
  await ready(page);
  check('动画和真实 Worker 回应后保留目标格焦点', await focusedCell(page), '6');
  check('辅助棋盘内容随局面更新', await page.locator('#accessible-board [data-cell="6"]').textContent(), '2行3列，红方象');
  check('落子后清除选中状态', await page.locator('#accessible-board [aria-pressed="true"]').count(), 0);
  await page.screenshot({ path: `${out}/keyboard-after-reply.png` });

  await loadFixture(page);
  await page.locator('#accessible-board [data-cell="5"]').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.locator('#game-screen [data-action="sound"]').focus();
  await ready(page);
  check('电脑完成行动不会抢走其他控件焦点', await page.evaluate(() => document.activeElement.dataset.action), 'sound');

  for (const [width, height] of [[320, 568], [390, 844], [1440, 900], [844, 390], [640, 320], [1024, 560], [568, 320], [390, 320], [812, 280]]) {
    if (await page.evaluate(() => !!document.fullscreenElement)) await page.evaluate(() => document.exitFullscreen());
    await page.setViewportSize({ width, height });
    await loadFixture(page);
    const fullscreen = height <= 560;
    const tag = `${width}x${height}${fullscreen ? '-fullscreen' : ''}`;
    if (fullscreen) {
      await page.keyboard.press('f');
      await page.waitForFunction(() => !!document.fullscreenElement);
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const needsScroll = fullscreen && (width < 640 || height < 320);
    if (needsScroll) await page.locator('.game-controls [data-action="exit"]').scrollIntoViewIfNeeded();
    for (const action of ['rules', 'sound', 'exit']) check(`${tag} ${action} 按钮完整可点击`, await visibleButton(page, `.game-controls [data-action="${action}"]`));
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell');
      return { fullscreen: !!document.fullscreenElement, scrollTop: shell.scrollTop, scrollHeight: shell.scrollHeight,
        clientHeight: shell.clientHeight, noHorizontalOverflow: shell.scrollWidth <= shell.clientWidth + 1,
        controls: [...document.querySelectorAll('.game-controls button')].map(b => ({ action: b.dataset.action, rect: b.getBoundingClientRect().toJSON() })) };
    });
    check(`${tag} 不产生横向滚动`, layout.noHorizontalOverflow);
    check(`${tag} 全屏状态正确`, layout.fullscreen, fullscreen);
    layouts.push({ tag, ...layout });
    await page.screenshot({ path: `${out}/${tag}.png` });
    await page.locator('.game-controls [data-action="rules"]').click();
    check(`${tag} 规则正常打开`, (await state(page)).modal, 'rules');
    await page.locator('#modal .primary-button[data-action="close"]').click();
    const sound = (await state(page)).sound;
    await page.locator('.game-controls [data-action="sound"]').click();
    check(`${tag} 音效按钮正常响应`, (await state(page)).sound, !sound);
    await page.locator('.game-controls [data-action="exit"]').click();
    check(`${tag} 退出确认正常打开`, (await state(page)).modal, 'exit');
    await page.locator('#modal .text-button[data-action="close"]').click();
    await page.locator('#board').scrollIntoViewIfNeeded();
    for (const at of [5, 6]) {
      const { x, y } = (await state(page)).board[at].click;
      await page.mouse.click(x, y);
      if (at === 5) check(`${tag} 棋盘缩放后选子命中`, (await state(page)).selected, 5);
    }
    check(`${tag} 棋盘缩放后吃子命中`, (await state(page)).board[6].cell, { kind: 'piece', piece: { side: 'red', rank: 8 } });
    await ready(page);
  }

  // 保持全屏切换视口，验证横竖屏布局与点击坐标会同步更新。
  for (const [width, height] of [[390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await loadFixture(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check(`${width}x${height} 旋转后仍在全屏`, await page.evaluate(() => !!document.fullscreenElement));
    check(`${width}x${height} 旋转后操作栏可见`, await visibleButton(page, '.game-controls [data-action="exit"]'));
    const { x, y } = (await state(page)).board[5].click;
    await page.mouse.click(x, y);
    check(`${width}x${height} 旋转后棋盘点击正确`, (await state(page)).selected, 5);
  }
  await page.locator('.game-controls [data-action="exit"]').click();
  await page.locator('#modal [data-action="confirm-exit"]').click();
  await page.locator('#start-button').scrollIntoViewIfNeeded();
  check('低高度全屏大厅入口可滚动到达', await visibleButton(page, '#start-button'));
  await page.locator('#start-button').click();
  check('全屏返回大厅后可以再次开局', (await state(page)).ply, 0);
  check('无框架错误覆盖层', await page.locator('vite-error-overlay').count(), 0);
  await context.close();
  check('无非预期页面或控制台错误', errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ browser: await browser.version(), url, devUrl, checks, errors, expectedNetworkErrors, layouts }, null, 2));
  console.log(`通过 ${checks.length} 项审查修复专项断言`);
} finally {
  await browser.close();
}
