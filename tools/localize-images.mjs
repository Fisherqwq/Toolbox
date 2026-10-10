/**
 * 首页配图本地化：把 Picsum 的 5 张图下载进 img/home/。
 *
 * 为什么：首页原来用 `picsum.photos/seed/xxx/W/H` 取图，断网时那几张图会空。
 * 现在整站（含首页）都不再需要网络。
 *
 * 用法： node tools/localize-images.mjs
 * 幂等： 已存在且大于 8 KB 就跳过，不重复下载。
 *
 * ⚠ Picsum 拿 WebP 的正确写法是**路径后缀** `.webp`：
 *   `https://picsum.photos/seed/x/600/420.webp`  → image/webp（15 KB）
 *   `https://picsum.photos/seed/x/600/420?fm=webp` → 仍然是 JPEG（被忽略）
 *   实测过，别再用查询参数那条路。
 */
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DIR = path.join(root, 'img', 'home');

/** 与 index.html 里的 <img> 一一对应 */
const IMAGES = [
  { seed: 'chessdesk-blues', w: 720, h: 900, out: 'chess-desk.webp', where: '首页首图' },
  { seed: 'chessboard-wide', w: 900, h: 500, out: 'chess-board.webp', where: '国际象棋卡片' },
  { seed: 'gomoku-stone', w: 600, h: 420, out: 'gomoku-stone.webp', where: '五子棋卡片' },
  { seed: 'xiangqi-board', w: 600, h: 420, out: 'xiangqi-board.webp', where: '中国象棋卡片' },
  { seed: 'padlock-macro', w: 560, h: 520, out: 'padlock.webp', where: '加密工具箱配图' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 从 WebP 文件头读出真实宽高（只需要 VP8 / VP8L / VP8X 三种之一）。
 * 目的是核对下载到的尺寸与期望一致 —— 免得哪天 Picsum 改了行为而没人发现。
 */
function webpSize(buf) {
  const tag = buf.slice(12, 16).toString('ascii');
  if (tag === 'VP8 ') {
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (tag === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  if (tag === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { w, h };
  }
  return null;
}

await mkdir(DIR, { recursive: true });

let downloaded = 0, skipped = 0, failed = 0;
for (const img of IMAGES) {
  const dest = path.join(DIR, img.out);
  try {
    const st = await stat(dest);
    if (st.size > 8192) { console.log(`跳过（已存在） ${img.out}  ${(st.size / 1024).toFixed(0)} KB`); skipped++; continue; }
  } catch { /* 不存在，继续下载 */ }

  const url = `https://picsum.photos/seed/${img.seed}/${img.w}/${img.h}.webp`;
  let ok = false;
  let lastErr = '';
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 8192) throw new Error(`只有 ${buf.length} 字节`);
      const isWebp = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
      if (!isWebp) throw new Error('返回的不是 WebP');
      const size = webpSize(buf);
      if (!size) throw new Error('WebP 头解析失败');
      if (Math.abs(size.w - img.w) > 2 || Math.abs(size.h - img.h) > 2) {
        throw new Error(`尺寸不符：得到 ${size.w}×${size.h}，期望 ${img.w}×${img.h}`);
      }
      await writeFile(dest, buf);
      console.log(`下载 ${img.out.padEnd(20)} ${(buf.length / 1024).toFixed(0).padStart(4)} KB  ${size.w}×${size.h}  ← ${img.where}`);
      downloaded++;
      ok = true;
    } catch (e) {
      lastErr = e.message;
      console.log(`  第 ${attempt} 次失败: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  if (!ok) { failed++; console.error(`✗ ${img.out} 下载失败: ${lastErr}`); }
}

console.log(`\n完成：新下载 ${downloaded} 张，跳过 ${skipped} 张，失败 ${failed} 张`);
if (failed) process.exit(1);

console.log('\n=== img/home 现状 ===');
let total = 0;
for (const img of IMAGES) {
  const st = await stat(path.join(DIR, img.out));
  total += st.size;
  console.log(`  ${img.out.padEnd(20)} ${(st.size / 1024).toFixed(0).padStart(4)} KB   期望 ${img.w}×${img.h}`);
}
console.log(`  合计 ${(total / 1024).toFixed(0)} KB`);

