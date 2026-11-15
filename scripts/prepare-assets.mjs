import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'assets/source');
const output = path.join(root, 'public/assets');
await mkdir(source, { recursive: true });
await mkdir(output, { recursive: true });
const files = {
  red: '八只萌趣动物玩偶图鉴-1.png', board: '无格薄荷绿木框棋盘.png',
  boardSlots: '薄荷森林四乘四棋盘-2.png',
  blue: '蓝队八兽黏土图鉴-3.png', tiles: '森林翻牌四态方砖图集-4.png',
  forest: '薄荷童话林间空地-6.png', ui: '温柔森林玩具棋UI图集-8.png',
  lobby: '斗兽棋森林大厅-9.png', avatars: '透明背景的八种动物头像-11.png',
};
for (const filename of Object.values(files)) await copyFile(path.join(root, 'ImageMaterials', filename), path.join(source, filename));
const manifest = [];

// 素材透明区存在离散色点；仅去掉低透明像素和很小的孤立连通区域，保留玩偶主体。
async function clean(image) {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const size = width * height, seen = new Uint8Array(size), queue = new Int32Array(size);
  for (let p = 0; p < size; p++) if (data[p * 4 + 3] < 48) data[p * 4 + 3] = 0;
  for (let start = 0; start < size; start++) {
    if (seen[start] || !data[start * 4 + 3]) continue;
    let read = 0, count = 1;
    queue[0] = start; seen[start] = 1;
    while (read < count) {
      const p = queue[read++], x = p % width;
      for (const q of [x ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q < 0 || q >= size || seen[q] || !data[q * 4 + 3]) continue;
        seen[q] = 1; queue[count++] = q;
      }
    }
    if (count < Math.max(80, size * 0.0008)) for (let i = 0; i < count; i++) data[queue[i] * 4 + 3] = 0;
  }
  return sharp(data, { raw: { width, height, channels: 4 } });
}

async function asset(key, name, crop, width, transparent = true, trim = true) {
  let image = sharp(path.join(source, files[key]));
  if (crop) image = image.extract(crop);
  if (name === 'cell-slot') {
    // 保留旧棋格本身的凹槽、纹理和光影，只柔化裁切边缘，使绿色外缘融入无格底图。
    const mask = Buffer.from(`<svg width="215" height="170" xmlns="http://www.w3.org/2000/svg">
      <defs><filter id="edge" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter></defs>
      <rect x="4" y="4" width="207" height="162" rx="40" fill="white" filter="url(#edge)"/>
    </svg>`);
    image = image.composite([{ input: mask, blend: 'dest-in' }]);
  }
  if (key === 'lobby') {
    // 将柔化边缘写入素材本身，避免 object-fit 缩小时 CSS 遮罩错位形成矩形接缝。
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const edge = Math.max(0, Math.min(1, x / 38, (info.width - 1 - x) / 38, y / 42, (info.height - 1 - y) / 55));
      data[(y * info.width + x) * 4 + 3] = Math.round(255 * edge * edge * (3 - 2 * edge));
    }
    image = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
  }
  if (transparent) image = await clean(image);
  if (transparent && trim) image = image.trim({ background: '#00000000', threshold: 4 });
  if (width) image = image.resize({ width, withoutEnlargement: true });
  await image.webp({ quality: 88, alphaQuality: 100, effort: 6 }).toFile(path.join(output, `${name}.webp`));
  manifest.push({ file: `${name}.webp`, source: files[key], crop: crop ?? null });
}

await asset('forest', 'forest', null, 941, false, false);
// 保持棋盘原坐标系，绘制层和点击层使用相同的标定位置。
await asset('board', 'board', null, 1366, true, false);
await asset('boardSlots', 'cell-slot', { left: 470, top: 160, width: 215, height: 170 }, 320, true, false);
await asset('lobby', 'lobby-animals', { left: 0, top: 410, width: 941, height: 700 }, 941, false, false);
for (const key of ['red', 'blue', 'avatars']) {
  for (let i = 0; i < 8; i++) {
    const left = Math.floor((i % 4) * 1774 / 4), top = Math.floor(Math.floor(i / 4) * 887 / 2);
    const right = Math.floor((i % 4 + 1) * 1774 / 4), bottom = Math.floor((Math.floor(i / 4) + 1) * 887 / 2);
    await asset(key, `${key}-${8 - i}`, { left, top, width: right - left, height: bottom - top }, key === 'avatars' ? 180 : 320);
  }
}
await asset('tiles', 'back', { left: 38, top: 116, width: 570, height: 480 }, 320);
await asset('tiles', 'tile-red', { left: 638, top: 116, width: 570, height: 480 }, 320);
await asset('tiles', 'tile-blue', { left: 38, top: 660, width: 570, height: 480 }, 320);
await asset('ui', 'button-coral', { left: 10, top: 105, width: 312, height: 185 }, 400);
await asset('ui', 'button-cream', { left: 626, top: 105, width: 312, height: 185 }, 400);
await asset('ui', 'bubble', { left: 940, top: 343, width: 310, height: 200 }, 380);
for (const [name, left] of [['book', 24], ['sound', 337], ['settings', 646], ['exit', 955]]) {
  await asset('ui', `icon-${name}`, { left, top: 621, width: 285, height: 273 }, 160);
}
await writeFile(path.join(root, 'assets/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`已从复制件生成 ${manifest.length} 个本地资源。原始 ImageMaterials 未修改。`);
