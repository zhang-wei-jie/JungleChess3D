import './style.css';
import { actionDescription, captureKind, isLegal, legalActions, observe, pieceCounts } from './game/engine';
import { GameSession } from './game/session';
import { ANIMALS, DIFFICULTIES, sideOf } from './game/types';
import type { Action, Difficulty, GameState, Observation, Result } from './game/types';
import { AiClient } from './ai/client';
import { assetUrl, loadImages } from './ui/assets';
import { BoardRenderer } from './ui/board';
import { GameAudio } from './ui/audio';

const app = document.querySelector<HTMLDivElement>('#app')!;
const SETTINGS_KEY = 'forest-jungle-settings';
let difficulty: Difficulty = 'normal', soundEnabled = true, settingsWritable = true;
try {
  const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
  if (settings && DIFFICULTIES.some(item => item.id === settings.difficulty)) difficulty = settings.difficulty;
  if (settings && typeof settings.sound === 'boolean') soundEnabled = settings.sound;
} catch { /* 不保存棋局；失效的可选偏好使用已约定的默认难度和音效。 */ }
const audio = new GameAudio(soundEnabled);
const ai = new AiClient();
let session: GameSession | null = null, selected: number | null = null;
let renderer: BoardRenderer;
let aiRunning = false, modalKind: string | null = null, announcedResult = false;
let focusedCell = 0, lastMoveText = '翻开一张，遇见你的森林伙伴';
let modalReturnFocus: HTMLElement | null = null;
const safe = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const icon = (name: string) => `<img class="ui-icon" src="${assetUrl(`icon-${name}`)}" alt="" draggable="false">`;
const sprout = `<svg class="sprout" viewBox="0 0 82 62" aria-hidden="true"><path d="M41 57V31M41 40C15 42 6 22 11 18c18-3 33 8 30 22M42 32C42 12 60 8 72 12c1 17-12 25-30 20" fill="#98b975" stroke="#718f51" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="m40 2 2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#a7bb79"/></svg>`;

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ difficulty, sound: audio.enabled })); }
  catch { settingsWritable = false; }
}

async function boot() {
  try {
    const images = await loadImages((loaded, total) => {
      app.innerHTML = `<div class="loading-screen" role="status">${sprout}<h1>斗兽棋</h1><p>正在走进森林… ${Math.round(loaded / total * 100)}%</p><div class="loading-track"><i style="width:${loaded / total * 100}%"></i></div></div>`;
    });
    app.innerHTML = `
      <main class="app-shell">
        <section id="home-screen" class="screen home-screen" aria-label="斗兽棋大厅">
          <button class="corner-button home-settings" data-action="settings" aria-label="游戏设置">${icon('settings')}</button>
          <header class="home-brand">${sprout}<h1>斗兽棋</h1><p class="brand-subtitle"><span></span>翻牌对战<span></span></p></header>
          <div class="home-art"><img src="${assetUrl('lobby-animals')}" alt="森林里的小象、狮子、猫和老鼠玩偶" draggable="false"></div>
          <div class="home-actions">
            <div class="difficulty-heading"><span class="leaf-line"></span><label>选一位森林对手</label><span class="leaf-line"></span></div>
            <div class="difficulty-control">
              <div class="difficulty-picker" role="group" aria-label="电脑难度" aria-describedby="difficulty-description">
                <div class="difficulty-track" aria-hidden="true"><div class="difficulty-highlight"><div class="difficulty-surface"><i class="difficulty-sheen"></i></div><i class="difficulty-spark"></i><i class="difficulty-spark"></i><i class="difficulty-spark"></i></div></div>
                ${DIFFICULTIES.map((item, index) => `<button data-action="difficulty" data-difficulty="${item.id}" aria-pressed="${difficulty === item.id}"><span class="difficulty-label">${item.name}</span><span class="difficulty-rank" aria-hidden="true">${DIFFICULTIES.map((_, rank) => `<i${rank <= index ? ' class="filled"' : ''}></i>`).join('')}</span></button>`).join('')}
              </div>
              <p id="difficulty-description" class="difficulty-description" aria-live="polite" aria-atomic="true"><span id="difficulty-copy"></span></p>
            </div>
            <button id="start-button" class="wood-button primary-button" data-action="start">开始对局</button>
            <button class="wood-button rules-button" data-action="rules">${icon('book')}玩法规则</button>
          </div>
          <p class="home-footnote">一片小森林，一局好时光</p>
        </section>
        <section id="game-screen" class="screen game-screen" aria-label="斗兽棋棋局" hidden>
          <header class="game-header"><div class="mini-brand">${sprout}<h1>斗兽棋</h1></div><button class="corner-button" data-action="settings" aria-label="游戏设置">${icon('settings')}</button></header>
          <div class="player-strip opponent-strip"><div class="avatar"><img src="${assetUrl('avatars-8')}" alt=""></div><div class="player-identity"><strong>电脑棋友</strong><small id="opponent-detail"></small></div><span id="computer-camp" class="camp-badge"></span><span id="computer-count" class="piece-count"></span></div>
          <div class="board-wrap"><canvas id="board" tabindex="0" aria-label="4 乘 4 斗兽棋棋盘，方向键选择格子，回车操作"></canvas></div>
          <div class="turn-line"><span id="turn-indicator" class="turn-indicator"></span><strong id="turn-text" aria-live="polite"></strong><span id="quiet-count" class="quiet-count"></span></div>
          <div class="player-strip human-strip"><div class="avatar"><img src="${assetUrl('avatars-7')}" alt=""></div><div class="player-identity"><strong>我方</strong><small id="human-count"></small></div><span id="human-camp" class="camp-badge"></span><button id="undo-button" class="undo-button" data-action="undo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5 4 10l5 5M5 10h9a5 5 0 0 1 0 10"/></svg><span>悔棋 <b id="undo-count">3/3</b></span></button></div>
          <p id="move-hint" class="move-hint" aria-live="polite"></p>
          <footer class="game-controls"><button class="wood-button" data-action="rules">${icon('book')}规则</button><button class="wood-button sound-control" data-action="sound">${icon('sound')}<span data-sound-label>音效</span></button><button class="wood-button" data-action="exit">${icon('exit')}退出</button></footer>
          <div id="accessible-board" class="sr-only" aria-label="棋盘格子">${Array.from({ length: 16 }, (_, i) => `<button data-action="cell" data-cell="${i}"></button>`).join('')}</div>
        </section>
      </main>
      <dialog id="modal" aria-labelledby="modal-title"><div id="modal-body"></div></dialog>
      <div id="toast" class="toast" role="status"></div>`;
    renderer = new BoardRenderer(document.querySelector('#board')!, images);
    installEvents(); renderUI();
    if (import.meta.env.DEV) {
      const { installTestBridge } = await import('./test-bridge');
      installTestBridge(state => startGame(state));
    }
  } catch (error) {
    app.innerHTML = `<div class="loading-screen error-screen"><h1>森林还没准备好</h1><p>${safe(error instanceof Error ? error.message : '资源加载失败')}</p><button class="plain-retry">重新加载</button></div>`;
    app.querySelector('button')!.addEventListener('click', () => location.reload());
  }
}

function setText(selector: string, text: string) { document.querySelector(selector)!.textContent = text; }
function campMarkup(side: 'red' | 'blue' | null) {
  return side ? `<i class="camp-shape ${side}"></i>${side === 'red' ? '红方' : '蓝方'}` : '<i class="pending-dot"></i>待定';
}
function renderDifficulty() {
  const control = document.querySelector<HTMLElement>('.difficulty-control')!;
  const previous = control.dataset.level;
  // 开局后移除一次性动效，返回大厅时保持静止，避免重放上一次切换。
  if (session) control.classList.remove('is-switching');
  if (previous === difficulty) return;
  const index = DIFFICULTIES.findIndex(item => item.id === difficulty);
  const previousIndex = DIFFICULTIES.findIndex(item => item.id === previous);
  control.classList.remove('is-switching');
  control.dataset.level = difficulty;
  control.style.setProperty('--difficulty-index', String(index));
  control.style.setProperty('--difficulty-enter', index > previousIndex ? '10px' : '-10px');
  document.querySelectorAll<HTMLElement>('[data-difficulty]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.difficulty === difficulty)));
  setText('#difficulty-copy', DIFFICULTIES[index]!.description);
  if (previous && !session && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // 只在难度变化时重播装饰动效；高光位移由 CSS 接续，快速点选始终跟随最新选择。
    void control.offsetWidth;
    control.classList.add('is-switching');
  }
}
function renderUI() {
  document.querySelector<HTMLElement>('#home-screen')!.hidden = session !== null;
  document.querySelector<HTMLElement>('#game-screen')!.hidden = session === null;
  renderDifficulty();
  document.querySelectorAll('[data-sound-label]').forEach(label => { label.textContent = audio.enabled ? '音效' : '静音'; });
  document.querySelectorAll('[data-action="sound"]').forEach(button => {
    button.setAttribute('aria-pressed', String(audio.enabled)); button.classList.toggle('muted', !audio.enabled);
  });
  if (!session) return;
  const observation = observe(session.state), counts = pieceCounts(observation);
  const computerSide = sideOf(observation, 'computer');
  setText('#opponent-detail', `${DIFFICULTIES.find(item => item.id === difficulty)!.name}难度`);
  for (const [id, side] of [['#human-camp', observation.humanSide], ['#computer-camp', computerSide]] as const) {
    const badge = document.querySelector<HTMLElement>(id)!;
    badge.innerHTML = campMarkup(side); badge.dataset.side = side ?? 'pending';
  }
  setText('#computer-count', computerSide ? `剩余 ${counts[computerSide]} 只` : '首翻分阵营');
  setText('#human-count', observation.humanSide ? `剩余 ${counts[observation.humanSide]} 只` : '由你先翻牌');
  setText('#undo-count', `${session.undosLeft}/3`);
  document.querySelector<HTMLButtonElement>('#undo-button')!.disabled = !session.canUndo || !!modalKind;
  const turnText = observation.result ? '本局已结束' : modalKind ? '稍作休息' : renderer.busy ? '棋子行动中…'
    : observation.turn === 'computer' ? '电脑思考中…' : observation.humanSide === null ? '翻开一张，开启这一局' : '轮到你啦';
  setText('#turn-text', turnText);
  document.querySelector('#turn-indicator')!.classList.toggle('thinking', aiRunning);
  setText('#quiet-count', observation.quietPlies > 0 ? `静步 ${observation.quietPlies}/20` : '');
  let hint = observation.humanSide === null ? '首枚棋子的颜色，就是你的阵营' : observation.turn === 'computer' ? lastMoveText : '翻开一张，或移动你的棋子';
  if (selected !== null) {
    const cell = observation.board[selected];
    if (cell?.kind === 'piece') hint = `已选${ANIMALS[cell.piece.rank]} · 绿框可移动，橙框可攻击`;
  }
  if (observation.result) hint = resultDescription(observation.result);
  setText('#move-hint', hint);
  renderer.setPosition(observation, selected);
  // 保留格子按钮节点，选子、动画和电脑回应时更新内容，不打断键盘焦点或抢走其他控件的焦点。
  document.querySelectorAll<HTMLButtonElement>('#accessible-board button').forEach((button, i) => {
    const cell = observation.board[i];
    const label = `${Math.floor(i / 4) + 1}行${i % 4 + 1}列，${cell === null ? '空格' : cell.kind === 'hidden' ? '暗棋' : `${cell.piece.side === 'red' ? '红方' : '蓝方'}${ANIMALS[cell.piece.rank]}`}`;
    if (button.textContent !== label) button.textContent = label;
    button.setAttribute('aria-pressed', String(selected === i));
  });
}

function stopAI() { ai.cancel(); aiRunning = false; }
function startGame(state?: GameState) {
  audio.stopAnimal(); stopAI(); renderer.cancelAnimation(); closeDialog(false);
  session = new GameSession(state); selected = null; announcedResult = false;
  lastMoveText = '翻开一张，遇见你的森林伙伴';
  renderUI(); resumeGame();
}
function goHome() {
  audio.stopAnimal(); stopAI(); renderer.cancelAnimation(); closeDialog(false);
  session = null; selected = null; renderUI();
  document.querySelector<HTMLButtonElement>('#start-button')!.focus({ preventScroll: true });
}

function interact(index: number) {
  if (!session || session.state.turn !== 'human' || session.state.result || renderer.busy || modalKind || document.hidden) return;
  audio.unlock();
  const observation = observe(session.state), cell = observation.board[index];
  if (cell?.kind === 'hidden') { void perform({ type: 'flip', at: index }, 'human'); return; }
  if (selected !== null) {
    const action: Action = { type: 'move', from: selected, to: index };
    if (isLegal(observation, action)) { void perform(action, 'human'); return; }
  }
  if (cell?.kind === 'piece' && cell.piece.side === observation.humanSide) selected = selected === index ? null : index;
  else if (selected !== null) { toast('只能走相邻的空格，或攻击相邻的对方明棋'); }
  else if (cell?.kind === 'piece') toast('这是电脑的棋子，选择自己的棋子试试');
  renderUI();
}

async function perform(action: Action, actor: 'human' | 'computer') {
  if (!session) return;
  const current = session, before = observe(current.state);
  try { current.play(action, actor); }
  catch { if (actor === 'computer') showDialog('ai-error', '<p>电脑返回了无效行动，请重试。</p>'); return; }
  const revision = current.revision;
  selected = null; lastMoveText = `${actor === 'human' ? '你' : '电脑'}${actionDescription(before, action)}`;
  let sound: 'flip' | 'move' | 'capture' | 'mutual' = action.type === 'flip' ? 'flip' : 'move';
  if (action.type === 'move') {
    const source = before.board[action.from], target = before.board[action.to];
    if (source?.kind === 'piece' && target?.kind === 'piece') sound = captureKind(source.piece, target.piece) === 'single' ? 'capture' : 'mutual';
  }
  audio.play(sound);
  const animation = renderer.animate(before, observe(current.state), action);
  renderUI(); const completed = await animation;
  if (session !== current || current.revision !== revision) return;
  if (completed && action.type === 'flip' && !document.hidden) {
    const revealed = current.state.board[action.at];
    if (revealed?.revealed) audio.playAnimal(revealed.piece.rank);
  }
  renderUI(); resumeGame();
}

function resumeGame() {
  if (!session || modalKind || renderer.busy || document.hidden) return;
  if (session.state.result) { showResult(); return; }
  if (session.state.turn !== 'computer' || aiRunning) return;
  const current = session, revision = current.revision;
  aiRunning = true; renderUI();
  ai.request(observe(current.state), difficulty, action => {
    aiRunning = false;
    if (session !== current || current.revision !== revision || modalKind || document.hidden) return;
    void perform(action, 'computer');
  }, message => {
    aiRunning = false;
    if (session !== current || current.revision !== revision) return;
    showDialog('ai-error', `<p>${safe(message)}</p>`);
  });
}

function resultDescription(result: Result): string {
  return {
    'elimination': '一方棋子全部退场，这一局有了答案。',
    'last-clash': '最后两枚同级相遇，主动进攻的一方获胜。',
    'blocked': '轮到的一方已无合法走法。',
    'repetition': '相同局面与行棋方已出现三次，本局握手言和。',
    'quiet': result.winner === null
      ? '连续 20 步没有翻牌或交战，双方最大棋子相同，本局平局。'
      : '连续 20 步没有翻牌或交战，最大棋子较大的一方获胜。',
    'quiet-hidden': '连续 20 步没有翻牌或交战，场上仍有暗棋，本局平局。',
    'quiet-rat': '连续 20 步没有翻牌或交战；一方仅剩象，对方有鼠，有鼠的一方获胜。',
  }[result.reason];
}
function showResult() {
  const result = session?.state.result;
  if (!result) return;
  if (!announcedResult) { audio.play(result.winner === 'human' ? 'win' : result.winner === 'computer' ? 'lose' : 'draw'); announcedResult = true; }
  showDialog('result');
}

const RULES = `
  <p class="modal-intro">十六只森林伙伴，翻开属于你的阵营。</p>
  <ol class="rules-list">
    <li><strong>翻开第一张</strong><p>红蓝各有八种动物，随机盖在 4×4 棋盘上。你先翻牌，首枚颜色决定你的阵营，接着轮到电脑。</p></li>
    <li><strong>每次只走一步</strong><p>翻开任意一枚暗棋，或移动己方明棋。只能上下左右走一格；不能斜走、跳跃或直接吃暗棋。</p></li>
    <li><strong>都能攻击，按强弱结算</strong><p class="rank-order">象 › 狮 › 虎 › 豹 › 狼 › 狗 › 猫 › 鼠</p><p>双方都能攻击相邻的敌方明棋。大吃小；小攻大时进攻者被吃，守方留在原格，也算一回合。鼠攻象获胜，象攻鼠则象被吃。<b>同级相遇，双方同时消失。</b></p></li>
    <li><strong>怎样获胜</strong><p>一方所有棋子退场即失败，未翻开的棋子仍算存活。被强敌堵住时仍能主动攻击。如果最后两枚同级棋子相撞，<b>主动进攻方获胜</b>。</p></li>
    <li><strong>重复局面</strong><p>相同棋盘、相同行棋方出现三次即平局；与 20 步结算同时触发时，优先按重复局面判平局。</p></li>
    <li><strong>连续 20 步如何结算</strong><p>连续 20 步没有翻牌或交战时，若场上还有暗棋，判平局。全部翻开后，若一方仅剩一只象、对方有鼠，则<b>有鼠的一方获胜</b>，无论鼠方有几枚棋子。其余情况按上述等级比较双方最大棋子，较大者获胜，相同则平局，不比较数量或第二大的棋子。</p><p>双方每行动一次算一步；翻牌或任意交战（包括攻击失败、同级双消）会重新计数。全灭、最后同级对撞等原有胜负判定优先。</p></li>
    <li><strong>可以重新考虑</strong><p>每局有 3 次悔棋，撤销自己上一步和电脑随后的一步。翻牌可以撤销，但不会重新洗牌。结算后不能悔棋。</p></li>
  </ol><p class="rule-note">五档电脑都只看公开信息。刷新或退出后不保留棋局。</p>`;

function showDialog(kind: string, content = '') {
  stopAI(); modalKind = kind; renderer.cancelAnimation();
  const dialog = document.querySelector<HTMLDialogElement>('#modal')!;
  if (!dialog.open) modalReturnFocus = document.activeElement as HTMLElement;
  let title = '', body = '', footer = '';
  if (kind === 'rules') { title = '森林对局指南'; body = RULES; footer = '<button class="wood-button primary-button" data-action="close">知道啦，去翻牌</button>'; }
  if (kind === 'settings') {
    title = '游戏设置';
    body = `<div class="setting-row"><div><strong>棋盘音效</strong><p>让每一步都有小小的回应</p></div><button class="sound-switch" data-action="sound" aria-pressed="${audio.enabled}"><span data-sound-label>${audio.enabled ? '音效' : '静音'}</span></button></div><p class="rule-note">${settingsWritable ? '只记住难度和音效，不保存未完成棋局。' : '当前浏览器无法记住设置，本次选择仍然有效。'}</p>${session ? '<button class="wood-button" data-action="restart">重新开局</button>' : ''}`;
    footer = '<button class="wood-button primary-button" data-action="close">回到森林</button>';
  }
  if (kind === 'exit' || kind === 'restart') {
    title = kind === 'exit' ? '要先离开森林吗？' : '重新开始这一局？';
    body = `<img class="confirm-animal" src="${assetUrl('avatars-2')}" alt=""><p class="confirm-copy">${kind === 'exit' ? '当前棋局不会保存。<br>下次回来，再开一局新的冒险。' : '棋子会重新洗牌，悔棋次数恢复为 3 次。'}</p>`;
    footer = `<button class="wood-button primary-button" data-action="${kind === 'exit' ? 'confirm-exit' : 'confirm-restart'}">${kind === 'exit' ? '返回大厅' : '重新开局'}</button><button class="text-button" data-action="close">继续这一局</button>`;
  }
  if (kind === 'ai-error') {
    title = '电脑需要缓一缓'; body = content;
    footer = '<button class="wood-button primary-button" data-action="close">重新思考</button><button class="text-button" data-action="exit">返回大厅</button>';
  }
  if (kind === 'result') {
    const result = session!.state.result!;
    title = result.winner === 'human' ? '对局胜利' : result.winner === 'computer' ? '本局惜败' : '本局平局';
    const rank = result.winner === 'human' ? 7 : result.winner === 'computer' ? 3 : 2;
    const art = result.winner === null
      ? `<img src="${assetUrl('red-2')}" alt="红方猫"><img src="${assetUrl('blue-2')}" alt="蓝方猫">`
      : `<img src="${assetUrl(`red-${rank}`)}" alt="${ANIMALS[rank]}">`;
    body = `<div class="result-art ${result.winner === 'human' ? 'victory' : result.winner === null ? 'draw-pair' : ''}"><span class="result-laurel">${sprout}</span>${art}</div><p class="result-tagline">${result.winner === 'human' ? '好棋！森林为你喝彩。' : result.winner === 'computer' ? '差一点点，再试一局吧。' : '旗鼓相当，下局再分高下。'}</p><p class="result-reason">${resultDescription(result)}</p><div class="result-meta"><span>${DIFFICULTIES.find(item => item.id === difficulty)!.name}难度</span><i></i><span>共 ${session!.state.ply} 步</span></div>`;
    footer = '<button class="wood-button primary-button" data-action="confirm-restart">再来一局</button><button class="wood-button" data-action="confirm-exit">返回大厅</button>';
  }
  document.querySelector('#modal-body')!.innerHTML = `<div class="modal-card ${kind === 'result' ? 'result-card' : ''}">${kind !== 'result' && kind !== 'ai-error' ? '<button class="modal-close" data-action="close" aria-label="关闭弹窗"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' : ''}<h2 id="modal-title">${title}</h2><div class="modal-content">${body}</div><div class="modal-actions">${footer}</div></div>`;
  if (!dialog.open) dialog.showModal();
  renderUI();
}
function closeDialog(resume = true) {
  document.querySelector<HTMLDialogElement>('#modal')?.close(); modalKind = null;
  if (resume) { renderUI(); modalReturnFocus?.focus({ preventScroll: true }); resumeGame(); }
}
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) {
  const element = document.querySelector<HTMLElement>('#toast')!;
  element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 2200);
}

function installEvents() {
  document.addEventListener('pointerdown', () => audio.unlock(), { passive: true });
  app.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]');
    if (!button || button.disabled) return;
    audio.unlock();
    switch (button.dataset.action) {
      case 'start': startGame(); break;
      case 'difficulty': if (!session && difficulty !== button.dataset.difficulty) { difficulty = button.dataset.difficulty as Difficulty; saveSettings(); renderUI(); } break;
      case 'rules': showDialog('rules'); break;
      case 'settings': showDialog('settings'); break;
      case 'close': closeDialog(); break;
      case 'sound': audio.enabled = !audio.enabled; saveSettings(); renderUI(); if (audio.enabled) audio.play('move'); break;
      case 'exit': session?.state.result ? goHome() : showDialog('exit'); break;
      case 'restart': showDialog('restart'); break;
      case 'confirm-exit': goHome(); break;
      case 'confirm-restart': startGame(); break;
      case 'undo':
        if (session?.canUndo) { audio.stopAnimal(); stopAI(); renderer.cancelAnimation(); session.undo(); selected = null; lastMoveText = '回到上一步，再想一想'; renderUI(); toast(`已悔棋，还剩 ${session.undosLeft} 次机会`); }
        break;
      case 'cell': interact(Number(button.dataset.cell)); break;
    }
  });
  renderer.canvas.addEventListener('pointerdown', event => {
    const index = renderer.hit(event.clientX, event.clientY);
    if (index !== null) { focusedCell = index; renderer.setFocus(null); interact(index); }
  });
  renderer.canvas.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowUp' && focusedCell >= 4) focusedCell -= 4;
    if (event.key === 'ArrowDown' && focusedCell < 12) focusedCell += 4;
    if (event.key === 'ArrowLeft' && focusedCell % 4 > 0) focusedCell--;
    if (event.key === 'ArrowRight' && focusedCell % 4 < 3) focusedCell++;
    if (event.key === 'Enter' || event.key === ' ') interact(focusedCell);
    renderer.setFocus(focusedCell);
  });
  renderer.canvas.addEventListener('blur', () => renderer.setFocus(null));
  document.querySelector('#accessible-board')!.addEventListener('focusin', event => {
    const index = Number((event.target as HTMLElement).dataset.cell); if (Number.isInteger(index)) renderer.setFocus(index);
  });
  document.querySelector<HTMLDialogElement>('#modal')!.addEventListener('cancel', event => {
    event.preventDefault(); if (modalKind !== 'result' && modalKind !== 'ai-error') closeDialog();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { audio.stopAnimal(); stopAI(); renderer.cancelAnimation(); }
    else { renderUI(); resumeGame(); }
  });
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() === 'f' && !modalKind && !event.ctrlKey && !event.metaKey) {
      if (document.fullscreenElement) void document.exitFullscreen();
      else document.querySelector<HTMLElement>('.app-shell')!.requestFullscreen?.().catch(() => toast('当前浏览器不支持全屏显示'));
    }
  });
  Object.assign(window, {
    render_game_to_text: () => {
      if (!session) return JSON.stringify({ mode: 'home', difficulty, sound: audio.enabled, modal: modalKind });
      const visible = observe(session.state);
      return JSON.stringify({ mode: visible.result ? 'result' : 'game', difficulty, humanSide: visible.humanSide, turn: visible.turn,
        ply: visible.ply, quietPlies: visible.quietPlies, undosLeft: session.undosLeft, selected, busy: renderer.busy || aiRunning,
        modal: modalKind, result: visible.result, coordinates: '左上为原点，行列从 0 开始；点击坐标使用浏览器视口像素',
        board: visible.board.map((cell, index) => ({ row: Math.floor(index / 4), col: index % 4, cell, click: renderer.screenPoint(index) })),
        legalActions: legalActions(visible), sound: audio.enabled });
    },
    advanceTime: async (ms: number) => { renderer.advanceTime(ms); await Promise.resolve(); },
  });
}

void boot();
