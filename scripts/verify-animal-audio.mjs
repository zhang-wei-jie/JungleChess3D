import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true });
const errors = [];
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5183/');
    await page.waitForFunction(() => window.__loadTestFixture);
    await page.evaluate(async () => {
      const { GameAudio } = await import('/src/ui/audio.ts');
      window.calls = [];
      const original = GameAudio.prototype.playAnimal;
      GameAudio.prototype.playAnimal = function(rank) {
        window.calls.push({ rank, enabled: this.enabled, state: JSON.parse(window.render_game_to_text()) });
        return original.call(this, rank);
      };
      window.sources = 0;
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(...args) { window.sources++; return start.apply(this, args); };
    });
    for (const [at, rank] of [[1, 5], [3, 1], [4, 3], [6, 8], [9, 4], [11, 6], [12, 7], [14, 2]]) {
      await page.evaluate(() => { window.__loadTestFixture('mixed'); window.calls = []; });
      const point = await page.evaluate(at => JSON.parse(window.render_game_to_text()).board[at].click, at);
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => window.calls.length > 0);
      const call = await page.evaluate(() => window.calls[0]);
      assert.equal(call.rank, rank);
      assert.equal(call.state.board[at].cell.piece.rank, rank);
      assert.equal(call.state.board[at].cell.kind, 'piece');
      assert.equal(call.state.busy, false, 'call happens after flip animation, before AI starts');
    }
    assert.ok(await page.evaluate(() => window.sources >= 8), 'real Web Audio buffers started');
    // Cancel a slow flip through undo: the resolved animation promise must not call the animal.
    if (reducedMotion === 'no-preference') {
      await page.evaluate(() => { window.__loadTestFixture('mixed'); window.calls = []; });
      const point = await page.evaluate(() => JSON.parse(window.render_game_to_text()).board[1].click);
      await page.mouse.click(point.x, point.y);
      await page.locator('[data-action="undo"]').click();
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.calls.length), 0);
    }
    // Muting disables source playback, including calls initiated by a flip.
    await page.evaluate(() => { window.__loadTestFixture('mixed'); window.calls = []; });
    await page.locator('[data-action="sound"]').first().click();
    const sourceCount = await page.evaluate(() => window.sources);
    const point = await page.evaluate(() => JSON.parse(window.render_game_to_text()).board[1].click);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => window.calls.length > 0);
    assert.equal(await page.evaluate(() => window.sources), sourceCount);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: eight animal mappings, real buffer playback, normal/reduced motion, cancelled flip and mute');
} finally { await browser.close(); }
