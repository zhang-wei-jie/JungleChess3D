export const assetUrl = (name: string) => `${import.meta.env.BASE_URL}assets/${name}.webp`;
export type Images = Map<string, HTMLImageElement>;

export async function loadImages(onProgress: (loaded: number, total: number) => void): Promise<Images> {
  const names = ['forest', 'board', 'cell-slot', 'back', 'tile-red', 'tile-blue', 'lobby-animals', 'button-coral', 'button-cream', 'bubble',
    'icon-book', 'icon-sound', 'icon-settings', 'icon-exit'];
  for (const type of ['red', 'blue', 'avatars']) for (let rank = 1; rank <= 8; rank++) names.push(`${type}-${rank}`);
  const images: Images = new Map();
  let failed = false;
  await Promise.all(names.map(async name => {
    const image = new Image();
    image.src = assetUrl(name);
    try { await image.decode(); }
    catch { failed = true; throw new Error(`图片加载失败：${name}，请检查本地资源后重试`); }
    // Promise.all 失败后其他图片仍会完成，不能让迟到的进度覆盖错误页和重试入口。
    if (failed) return;
    images.set(name, image); onProgress(images.size, names.length);
  }));
  return images;
}
