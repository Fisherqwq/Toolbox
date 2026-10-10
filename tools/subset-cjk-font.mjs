/**
 * 中文标题字体子集化（一次性工具，已被 tools/build-vendor-assets.mjs 调用；
 * 单独保留是因为 25 MB 下载 + 子集化偶尔需要重跑，不必重跑图标/拉丁字体）。
 *
 * 产出: vendor/fonts/NotoSerifSC-subset.woff2
 * 用法: node tools/subset-cjk-font.mjs
 */
import { writeFile, readFile, unlink, stat } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FONTS = path.join(root, 'vendor', 'fonts');
const CHARS_FILE = path.join(FONTS, '.cjk-chars.txt');

const SOURCE = process.env.CJK_FONT_URL ||
  'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.2.5/files/noto-serif-sc-chinese-simplified-600-normal.woff2';
const WEIGHT = 600;

/** 带重试的下载：这个网络环境对 raw.githubusercontent 不稳定，jsDelivr 可达 */
async function download(url, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 10000) throw new Error(`只有 ${buf.length} 字节`);
      return buf;
    } catch (e) {
      lastErr = e;
      console.log(`  第 ${i} 次下载失败: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

/** 收集页面源码里出现的全部字符（汉字 + 标点 + ASCII），作为子集范围 */
async function collectChars() {
  const files = ['index.html', 'css/style.css'];
  for (const f of await readdir(path.join(root, 'js'))) if (f.endsWith('.js')) files.push(path.join('js', f));
  const set = new Set(' 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,:;!?()[]{}<>/\\|@#$%^&*-_=+~`\'"·—…、。，：；！？（）《》【】「」％×÷');
  for (const rel of files) {
    let text = '';
    try { text = await readFile(path.join(root, rel), 'utf8'); } catch { continue; }
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3000 && c <= 0x303f)) set.add(ch);
    }
  }
  return [...set].join('');
}

await (await import('node:fs/promises')).mkdir(FONTS, { recursive: true });
const chars = await collectChars();
await writeFile(CHARS_FILE, chars, 'utf8');
console.log(`字符集: ${[...chars].length} 个`);

console.log(`下载 ${SOURCE} …`);
const buf = await download(SOURCE);
console.log(`  ${(buf.length / 1048576).toFixed(2)} MB`);
const tmp = path.join(FONTS, '.noto-src.woff2');
const out = path.join(FONTS, 'NotoSerifSC-subset.woff2');
await writeFile(tmp, buf);

const py = [
  'import sys',
  'from fontTools import subset',
  'from fontTools.ttLib import TTFont',
  'src, dst, charsfile = sys.argv[1], sys.argv[2], sys.argv[3]',
  'text = open(charsfile, encoding="utf-8").read()',
  'font = TTFont(src)',
  'if "fvar" in font:',
  '    from fontTools.varLib.instancer import instantiateVariableFont',
  '    font = instantiateVariableFont(font, {"wght": 600.0}, inplace=False, updateFontNames=False)',
  '    print("  变量字体：轴固定为 wght=600")',
  'else:',
  '    print("  静态字体，直接子集化")',
  'opts = subset.Options()',
  'opts.flavor = "woff2"',
  'opts.layout_features = ["*"]',
  'opts.notdef_outline = True',
  'opts.recalc_bounds = True',
  'sub = subset.Subsetter(options=opts)',
  'sub.populate(text=text)',
  'sub.subset(font)',
  'font.save(dst)',
].join('\n');

console.log('子集化…');
execFileSync(process.env.PYTHON || 'python', ['-c', py, tmp, out, CHARS_FILE], { stdio: 'inherit' });
const size = (await stat(out)).size;
if (size < 20000) throw new Error(`产物只有 ${size} 字节，明显不含汉字，判为失败`);
console.log(`OK  vendor/fonts/NotoSerifSC-subset.woff2  ${(size / 1024).toFixed(0)} KB`);
await unlink(tmp).catch(() => {});
