/**
 * 资源本地化：把页面依赖的远程字体与图标下载进项目。
 *
 * 产出：
 *   vendor/iconify-lite.js        本地版 <iconify-icon> 自定义元素（替代 code.iconify.design 的脚本）
 *   vendor/icons/mdi-sprite.svg   13 个 mdi 图标的 symbol 精灵图
 *   vendor/fonts/*.woff2          自托管字体
 *   vendor/fonts.css              @font-face，全部指向本地文件
 *
 * 用法： node tools/build-vendor-assets.mjs
 * 说明： 只在本地跑一次；产物入库，之后页面不再需要任何 CDN。
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const VENDOR = path.join(root, 'vendor');
const FONTS = path.join(VENDOR, 'fonts');
const ICONS = path.join(VENDOR, 'icons');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 与 index.html 里 <link> 请求的族/字重保持一致
const LATIN_FAMILIES = [
  'Instrument+Serif:ital@0;1',
  'Space+Grotesk:wght@300;400;500;700',
  'JetBrains+Mono:wght@400;700',
];

async function get(url, as = 'text', extraHeaders = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...extraHeaders } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

await mkdir(FONTS, { recursive: true });
await mkdir(ICONS, { recursive: true });

/* ---------------- 1. 图标 ---------------- */
const ICON_NAMES = [
  'arrow-left', 'arrow-right', 'chess-rook', 'circle-outline', 'clock-outline',
  'fingerprint', 'lock-outline', 'package-variant-closed', 'shield-check-outline',
  'star-four-points-outline', 'storefront-outline', 'tag-outline', 'vector-square',
];

const symbols = [];
for (const name of ICON_NAMES) {
  const svg = await get(`https://api.iconify.design/mdi/${name}.svg`);
  const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 24 24';
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  if (!inner) throw new Error(`图标 ${name} 内容为空`);
  symbols.push(`  <symbol id="mdi-${name}" viewBox="${vb}">${inner}</symbol>`);
  console.log(`  图标 ok: mdi:${name}  viewBox=${vb}`);
}

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
${symbols.join('\n')}
</svg>
`;
await writeFile(path.join(ICONS, 'mdi-sprite.svg'), sprite, 'utf8');
console.log(`图标精灵图: vendor/icons/mdi-sprite.svg  (${symbols.length} 个 symbol, ${sprite.length} 字节)`);

/* ---------------- 2. 图标自定义元素 ---------------- */
// 只实现本站在用的那点能力：icon 名 → sprite 里的符号，尺寸/颜色跟随 CSS（currentColor）。
const iconLite = `/**
 * iconify-lite —— <iconify-icon icon="mdi:xxx"> 的本地实现。
 *
 * 为什么自己写：原先页面从 code.iconify.design 加载 iconify-icon 脚本，
 * 断网时图标全部消失（按钮上会出现空白块）。这里只做本站用到的 13 个图标，
 * 用内联 sprite + <use> 渲染，零网络请求。
 *
 * 用法与原来完全一致： <iconify-icon icon="mdi:storefront-outline" class="logo-mark"></iconify-icon>
 * 尺寸：跟随 font-size（1em），颜色：跟随 currentColor，与 Iconify 默认行为一致。
 */
(function () {
  'use strict';
  var SPRITE = 'vendor/icons/mdi-sprite.svg';
  var loaded = null;

  function iconId(name) {
    return 'mdi-' + String(name || '').replace(/^mdi:/, '');
  }

  function ensureSprite() {
    if (loaded) return loaded;
    loaded = fetch(SPRITE, { cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        var box = document.createElement('div');
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        box.innerHTML = text;
        document.body.appendChild(box);
        return true;
      })
      .catch(function (err) {
        console.warn('[iconify-lite] 图标精灵图加载失败:', err.message);
        loaded = null;
        return false;
      });
    return loaded;
  }

  var IconLite = function () {
    var self = Reflect.construct(HTMLElement, [], IconLite);
    return self;
  };
  IconLite.prototype = Object.create(HTMLElement.prototype);
  IconLite.prototype.constructor = IconLite;
  Object.setPrototypeOf(IconLite, HTMLElement);

  function render(el) {
    var name = el.getAttribute('icon');
    if (!name) return;
    var id = iconId(name);
    ensureSprite().then(function (ok) {
      if (!ok) return;
      if (!document.getElementById(id)) {
        console.warn('[iconify-lite] sprite 里没有这个图标:', name);
        return;
      }
      el.innerHTML = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" ' +
        'style="display:inline-block;vertical-align:-0.125em"><use href="#' + id + '"></use></svg>';
    });
  }

  IconLite.prototype.connectedCallback = function () { render(this); };
  IconLite.prototype.attributeChangedCallback = function () { render(this); };
  IconLite.observedAttributes = ['icon'];

  if (!customElements.get('iconify-icon')) {
    customElements.define('iconify-icon', IconLite);
  }
})();
`;
await writeFile(path.join(VENDOR, 'iconify-lite.js'), iconLite, 'utf8');
console.log('图标元素实现: vendor/iconify-lite.js');

/* ---------------- 3. 字体 ---------------- */
const parts = [];

/** 从 Google Fonts 的 CSS 里抓某族的全部 woff2 子集，逐个落地并保留 unicode-range */
async function fetchFamilyFromCss(famQuery, famName) {
  const css = await get(`https://fonts.googleapis.com/css2?family=${famQuery}&display=swap`);
  const blocks = css.split('@font-face').slice(1);
  let i = 0;
  for (const raw of blocks) {
    const block = '@font-face' + raw.slice(0, raw.indexOf('}') + 1);
    const weight = (block.match(/font-weight:\s*([^;]+);/) || [])[1] || '400';
    const style = (block.match(/font-style:\s*([^;]+);/) || [])[1] || 'normal';
    const url = (block.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
    const range = (block.match(/unicode-range:\s*([^;]+);/) || [])[1];
    if (!url) { console.warn('    跳过无 woff2 的 @font-face:', weight, style); continue; }
    i++;
    const file = `${famName.replace(/\s+/g, '-')}-${weight}-${style}-${String(i).padStart(2, '0')}.woff2`;
    const buf = await get(url, 'buffer');
    await writeFile(path.join(FONTS, file), buf);
    parts.push(
      `@font-face {\n  font-family: '${famName}';\n  font-style: ${style};\n  font-weight: ${weight};\n` +
      `  font-display: swap;\n` +
      (range ? `  unicode-range: ${range};\n` : '') +
      `  src: url('fonts/${file}') format('woff2');\n}`
    );
  }
  console.log(`  ${famName}: ${i} 个 woff2 子集`);
  return i;
}

for (const fam of LATIN_FAMILIES) {
  await fetchFamilyFromCss(fam, fam.replace(/\+/g, ' ').replace(/:.*$/, ''));
}

/**
 * 中文标题字体：Noto Serif SC 全量太大，用 fonttools 子集化到页面真正用到的字符。
 * 源用 jsDelivr 上的 @fontsource 预子集 woff2（1.46 MB，稳定可达），
 * 再本地子集到 ~160 KB。逻辑与 tools/subset-cjk-font.mjs 一致，失败不阻塞。
 */
let cjkNote = '（未子集化，中文走系统衬线兜底：Songti SC / SimSun）';
try {
  const { execFileSync } = await import('node:child_process');
  const chars = await collectCjkChars();
  const srcUrl = 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.2.5/files/noto-serif-sc-chinese-simplified-600-normal.woff2';
  let buf = null;
  for (let i = 1; i <= 4 && !buf; i++) {
    try {
      const r = await fetch(srcUrl, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      console.warn(`    第 ${i} 次下载失败: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  if (!buf) throw new Error('字体源下载失败');
  const tmp = path.join(FONTS, '.tmp-noto-src.woff2');
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
  execFileSync(process.env.PYTHON || 'python', ['-c', py, tmp, out, path.join(FONTS, '.tmp-noto-chars.txt')], { stdio: 'inherit' });
  const size = (await readFile(out)).length;
  if (size < 20000) throw new Error(`子集只有 ${size} 字节，明显不含汉字，判为失败`);
  cjkNote = `（子集化 ${chars} 个字符 → ${(size / 1024).toFixed(0)} KB）`;
  parts.push(
    `@font-face {\n  font-family: 'Noto Serif SC';\n  font-style: normal;\n  font-weight: 600;\n` +
    `  font-display: swap;\n  src: url('fonts/NotoSerifSC-subset.woff2') format('woff2');\n}`
  );
  console.log(`  Noto Serif SC 子集 ok ${cjkNote}`);
  const { unlink } = await import('node:fs/promises');
  await unlink(tmp).catch(() => {});
} catch (e) {
  console.warn('  ⚠ Noto Serif SC 子集化失败（不阻塞，回退系统衬线）:', e.message);
}

const header = `/* 自动生成，不要手改 —— 重新生成： node tools/build-vendor-assets.mjs
 *
 * 全部字体自托管，页面不再请求 fonts.googleapis.com / fonts.gstatic.com。
 * 中文标题字体 ${cjkNote}
 */
`;
await writeFile(path.join(VENDOR, 'fonts.css'), header + parts.join('\n\n') + '\n', 'utf8');
console.log(`\n字体样式: vendor/fonts.css（${parts.length} 条 @font-face）`);
console.log('完成。');

/** 收集 index.html / css / js 里出现的所有中日韩字符，供字体子集化使用 */
async function collectCjkChars() {
  const { readdir } = await import('node:fs/promises');
  const files = ['index.html', 'css/style.css'];
  for (const f of await readdir(path.join(root, 'js'))) {
    if (f.endsWith('.js')) files.push(path.join('js', f));
  }
  const set = new Set(' 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,:;!?()[]{}<>/\\|@#$%^&*-_=+~`\'"·—…、。，：；！？（）《》【】「」%');
  for (const rel of files) {
    let text = '';
    try { text = await readFile(path.join(root, rel), 'utf8'); } catch { continue; }
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c >= 0x2e80 && c <= 0x9fff) set.add(ch);            // CJK 部首/汉字
      else if (c >= 0xff00 && c <= 0xffef) set.add(ch);        // 全角标点
      else if (c >= 0x3000 && c <= 0x303f) set.add(ch);        // CJK 标点
    }
  }
  const chars = [...set].join('');
  await writeFile(path.join(FONTS, '.tmp-noto-chars.txt'), chars, 'utf8');
  console.log(`  中文字符集: ${[...set].length} 个字符`);
  return [...set].length;
}
