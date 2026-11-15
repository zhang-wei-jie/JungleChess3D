import { legalActions } from '../game/engine';
import type { Action, Observation, PublicCell } from '../game/types';
import type { Images } from './assets';

const WIDTH = 1000, HEIGHT = 1160;
const BOARD = { x: -10, y: 65, width: 1020, height: 1030, sourceWidth: 1366, sourceHeight: 1151 };
export function cellAnchor(index: number) {
  const row = Math.floor(index / 4), col = index % 4;
  // 无格底图只提供桌面：行列按同一透视规律排布，不再逐格迁就底图里的凹槽。
  return { x: BOARD.x + (683 + (col - 1.5) * (220 + row * 16)) * BOARD.width / BOARD.sourceWidth,
    y: BOARD.y + (320 + row * 180) * BOARD.height / BOARD.sourceHeight, width: 164 + row * 9 };
}
interface Animation { before: Observation; after: Observation; action: Action; start: number; duration: number; resolve: () => void }
interface Bounds { x: number; y: number; width: number; height: number }

function cellBounds(index: number) {
  const p = cellAnchor(index), width = p.width * .96, height = p.width * .84;
  return { x: p.x - width / 2, y: p.y - height + 4, width, height };
}

function cellSurface(index: number): Bounds {
  const p = cellBounds(index);
  // 按凹槽素材的奶油色内面留出边沿，棋子底座不能占用外围绿色边框。
  return { x: p.x + p.width * .08, y: p.y + p.height * .12, width: p.width * .84, height: p.height * .76 };
}

export class BoardRenderer {
  private ctx: CanvasRenderingContext2D;
  private observation: Observation | null = null;
  private selected: number | null = null;
  private animation: Animation | null = null;
  private frame = 0;
  private offset = 0;
  private reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private resizeObserver: ResizeObserver;
  private focusCell: number | null = null;

  constructor(readonly canvas: HTMLCanvasElement, private images: Images) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 Canvas 2D');
    this.ctx = ctx;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement!);
    this.resize();
  }

  private resize() {
    const parent = this.canvas.parentElement!.getBoundingClientRect();
    const width = Math.min(parent.width, parent.height * WIDTH / HEIGHT);
    const height = width * HEIGHT / WIDTH;
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    this.draw();
  }

  setPosition(observation: Observation, selected: number | null) {
    this.observation = observation; this.selected = selected;
    // 大厅切入棋局时同步建立尺寸，避免 ResizeObserver 首帧前得到零宽点击坐标。
    this.resize();
  }
  setFocus(index: number | null) { this.focusCell = index; this.draw(); }
  get busy() { return this.animation !== null; }
  get reducedMotion() { return this.reduceMotion; }
  cancelAnimation() {
    if (this.animation) { const resolve = this.animation.resolve; this.animation = null; resolve(); }
    cancelAnimationFrame(this.frame); this.draw();
  }
  advanceTime(ms: number) { this.offset += Math.max(0, ms); this.draw(); }

  animate(before: Observation, after: Observation, action: Action): Promise<void> {
    this.cancelAnimation();
    this.observation = after; this.selected = null;
    return new Promise(resolve => {
      const target = action.type === 'move' ? before.board[action.to] : null;
      this.animation = { before, after, action, start: performance.now() + this.offset,
        duration: this.reduceMotion ? 70 : action.type === 'flip' ? 440 : target ? 520 : 380, resolve };
      this.draw();
    });
  }

  screenPoint(index: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect(), surface = cellSurface(index);
    return { x: rect.left + (surface.x + surface.width / 2) / WIDTH * rect.width,
      y: rect.top + (surface.y + surface.height / 2) / HEIGHT * rect.height };
  }

  hit(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width * WIDTH, y = (clientY - rect.top) / rect.height * HEIGHT;
    // 按近处到远处命中可见主体；画面缩放和点击计算始终共用同一套逻辑坐标。
    for (let index = 15; index >= 0; index--) {
      const slot = cellBounds(index), cell = this.observation?.board[index];
      const inside = (p: Bounds) => x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height;
      if (inside(slot) || (cell && inside(this.pieceBounds(cell, index)))) return index;
    }
    return null;
  }

  private pieceBounds(cell: Exclude<PublicCell, null>, index: number): Bounds {
    const surface = cellSurface(index);
    const image = this.images.get(cell.kind === 'hidden' ? 'back' : `${cell.piece.side}-${cell.piece.rank}`)!;
    // 牌背整体放入内面；动物保留竖向立体轮廓，以底座宽度控制占地，等比缩放不裁切。
    const scale = cell.kind === 'hidden'
      ? Math.min(surface.width / image.naturalWidth, surface.height / image.naturalHeight)
      : surface.width * 1.03 / image.naturalWidth;
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    // 动物素材两侧有透明留白，以实际底座占地放大，并给底部圆角保留余量。
    const bottomInset = cell.kind === 'piece' ? surface.height * .05 : 0;
    return { x: surface.x + (surface.width - width) / 2, y: surface.y + surface.height - bottomInset - height, width, height };
  }

  private imageCell(cell: PublicCell, index: number, alpha = 1, squeeze = 1, location?: Bounds) {
    if (!cell) return;
    const image = this.images.get(cell.kind === 'hidden' ? 'back' : `${cell.piece.side}-${cell.piece.rank}`)!;
    const p = location ?? this.pieceBounds(cell, index);
    const ctx = this.ctx;
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(p.x + p.width / 2, p.y + p.height); ctx.scale(Math.max(0.015, squeeze), 1);
    ctx.shadowColor = 'rgba(70, 75, 35, .18)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    ctx.drawImage(image, -p.width / 2, -p.height, p.width, p.height);
    ctx.restore();
  }

  private ring(index: number, color: string, fill = false) {
    const ctx = this.ctx, p = cellBounds(index);
    ctx.save(); ctx.shadowBlur = 17; ctx.shadowColor = color;
    ctx.beginPath(); ctx.roundRect(p.x, p.y, p.width, p.height, 22);
    ctx.lineWidth = 6; ctx.strokeStyle = color; ctx.stroke();
    if (fill) { ctx.fillStyle = color; ctx.globalAlpha = .14; ctx.fill(); }
    ctx.restore();
  }

  private drawGrid() {
    const ctx = this.ctx;
    const slot = this.images.get('cell-slot')!;
    // 原图提取的立体凹槽独立排布，空位保留材质，并与棋子、操作提示共享透视落点。
    for (let i = 0; i < 16; i++) {
      const p = cellBounds(i);
      ctx.drawImage(slot, p.x, p.y, p.width, p.height);
    }
  }

  private draw = () => {
    cancelAnimationFrame(this.frame);
    const ctx = this.ctx;
    ctx.setTransform(this.canvas.width / WIDTH, 0, 0, this.canvas.height / HEIGHT, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(this.images.get('board')!, BOARD.x, BOARD.y, BOARD.width, BOARD.height);
    this.drawGrid();
    if (!this.observation) return;
    const animation = this.animation;
    const progress = animation ? Math.min(1, (performance.now() + this.offset - animation.start) / animation.duration) : 1;
    const board = animation ? animation.before.board : this.observation.board;
    const action = animation?.action;
    const survivor = animation && action?.type === 'move' ? animation.after.board[action.to] : null;
    const attacker = action?.type === 'move' ? board[action.from] : null;
    // 由结算结果决定谁退场；失败攻击时守方始终可见，移动中的进攻者淡出。
    const attackerSurvives = survivor?.kind === 'piece' && attacker?.kind === 'piece' && survivor.piece.side === attacker.piece.side;
    const defenderSurvives = survivor?.kind === 'piece' && attacker?.kind === 'piece' && survivor.piece.side !== attacker.piece.side;
    for (let i = 0; i < 16; i++) {
      if (action?.type === 'move' && i === action.from) continue;
      if (action?.type === 'flip' && i === action.at) {
        const cell = progress < .5 ? animation!.before.board[i] : animation!.after.board[i];
        this.imageCell(cell, i, 1, Math.abs(Math.cos(progress * Math.PI)));
      } else if (action?.type === 'move' && i === action.to && board[i]) {
        this.imageCell(board[i], i, defenderSurvives ? 1 : Math.max(0, 1 - Math.max(0, progress - .45) / .42));
      } else this.imageCell(board[i], i);
    }
    if (animation && action?.type === 'move') {
      const moving = board[action.from]!;
      const source = this.pieceBounds(moving, action.from), target = this.pieceBounds(moving, action.to);
      const t = Math.min(1, progress / .72), eased = t * t * (3 - 2 * t);
      const alpha = attackerSurvives ? 1 : Math.max(0, 1 - Math.max(0, progress - .55) / .4);
      this.imageCell(board[action.from], action.from, alpha, 1,
        { x: source.x + (target.x - source.x) * eased, y: source.y + (target.y - source.y) * eased - Math.sin(t * Math.PI) * (this.reduceMotion ? 0 : 65),
          width: source.width + (target.width - source.width) * eased, height: source.height + (target.height - source.height) * eased });
      if (board[action.to] && progress > .45 && !this.reduceMotion) {
        ctx.save(); ctx.globalAlpha = Math.sin((progress - .45) / .55 * Math.PI); ctx.fillStyle = '#fff7cb';
        for (let n = 0; n < 7; n++) {
          const a = n / 7 * Math.PI * 2, r = 30 + progress * 75;
          ctx.beginPath(); ctx.arc(target.x + target.width / 2 + Math.cos(a) * r, target.y + target.height * .6 + Math.sin(a) * r * .6, 6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    }
    if (!animation) {
      if (this.selected !== null) {
        this.ring(this.selected, '#f9ffe2');
        for (const move of legalActions(this.observation)) if (move.type === 'move' && move.from === this.selected) {
          this.ring(move.to, this.observation.board[move.to] ? '#ed9679' : '#c7f3b6', true);
          if (this.observation.board[move.to] === null) {
            const surface = cellSurface(move.to); ctx.fillStyle = '#6f9860'; ctx.beginPath(); ctx.arc(surface.x + surface.width / 2, surface.y + surface.height / 2, 13, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      if (this.focusCell !== null) this.ring(this.focusCell, '#fff6b9');
    }
    if (animation) {
      if (progress >= 1) { this.animation = null; this.draw(); animation.resolve(); }
      else this.frame = requestAnimationFrame(this.draw);
    }
  };
}
