/**
 * 中国象棋分页 · 静态结构检查（零依赖，Node 直跑）
 *
 * 检查项：
 *   1. 关键文件是否存在、脚本是否都能被 index.html 引到
 *   2. index.html 容器标签配平、id 无重复、中国象棋必需 id 齐全
 *   3. 是否还残留远程 CDN 引用（字体/图标/Picsum 之外的都算问题）
 *   4. vendor 资源是否完整（字体、图标、sprite）
 *   5. Service Worker 预缓存清单里的文件是否真实存在
 *   6. JS 语法（调用 node --check）
 *
 * 用法： node tools/check-xiangqi-page.mjs
 */
import { readFile, access, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const problems = [];
function ok(name, detail = '') { pass++; console.log(`PASS  ${name}${detail ? '  → ' + detail : ''}`); }
function bad(name, detail = '') { fail++; problems.push(`${name}: ${detail}`); console.log(`FAIL  ${name}  → ${detail}`); }

const exists = async (rel) => { try { await access(path.join(root, rel)); return true; } catch { return false; } };

/* ---------- 1. 关键文件 ---------- */
const REQUIRED_FILES = [
  'index.html', 'css/style.css', 'sw.js', 'js/sw-register.js',
  'js/xiangqi.js',
  'js/lib/godogpaw/godogpaw-bridge.js',
  'js/lib/godogpaw/godogpaw.wasm',
  'js/lib/godogpaw/wasm_exec.js',
  'vendor/fonts.css', 'vendor/iconify-lite.js', 'vendor/icons/mdi-sprite.svg',
];
for (const f of REQUIRED_FILES) {
  if (await exists(f)) ok(`存在 ${f}`);
  else bad(`存在 ${f}`, '文件不在');
}

/* ---------- 2. index.html ---------- */
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const containers = ['section', 'div', 'aside', 'main', 'header', 'footer'];
let open = 0, close = 0;
for (const t of containers) {
  open += (html.match(new RegExp(`<${t}\\b[^>]*>`, 'g')) || []).length;
  close += (html.match(new RegExp(`</${t}>`, 'g')) || []).length;
}
if (open === close) ok('容器标签配平', `开=${open} 闭=${close}`);
else bad('容器标签配平', `开=${open} 闭=${close}`);

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
if (!dup.length) ok('id 无重复', `${ids.length} 个 id`);
else bad('id 无重复', dup.join(', '));

const XQ_IDS = ['xqCanvas', 'xqStatusText', 'xqTurnDot', 'xqThinkingIndicator', 'xqMoveCount', 'xqLastMove',
  'xqEngineBadge', 'xqEngineInfo', 'xqDepthGroup', 'xqCustomDiff', 'xqDiffModeGroup', 'xqCustomDepth',
  'xqCustomTime', 'xqDepthHint', 'xqRestartBtn', 'xqUndoBtn', 'xqResignBtn', 'xqFlipBtn', 'xqCopyFenBtn',
  'xqHistoryToggle', 'xqHistoryList', 'xqRedScore', 'xqBlackScore', 'xqDrawScore'];
const missIds = XQ_IDS.filter((i) => !ids.includes(i));
if (!missIds.length) ok('中国象棋必需 id 齐全', `${XQ_IDS.length} 个`);
else bad('中国象棋必需 id 齐全', '缺 ' + missIds.join(', '));

/* ---------- 3. 远程引用 ----------
 * 只有「浏览器会自动去取」的远程地址才算问题：<link href>、<script src>、<img src>、url()。
 * 现在已经做到一个都没有（首页配图也本地化到 img/home/ 了）。
 * 用户手动点才会走的 <a href> 外链不算 —— 断网时它只是点不开，不会让页面变砖。 */
const autoLoadTags = [...html.matchAll(/<(link|script|img|iframe|source)\b[^>]*>/g)].map((m) => m[0]);
const remoteAuto = [];
for (const tag of autoLoadTags) {
  for (const m of tag.matchAll(/https?:\/\/[^"'\s>]+/g)) remoteAuto.push(m[0]);
}
const anchorRemote = [...html.matchAll(/<a\b[^>]*href="(https?:[^"]+)"/g)].map((m) => m[1]);
if (!remoteAuto.length) {
  ok('index.html 无自动加载的远程资源', anchorRemote.length
    ? `零远程图片/脚本/样式；仅 ${anchorRemote.length} 条跳转外链（用户点击才走）`
    : '连外链都没有');
} else {
  bad('index.html 无自动加载的远程资源', remoteAuto.join(' | '));
}

// 首页配图必须真的在本地，且都在 SW 预缓存里
const localImgs = [...html.matchAll(/<img[^>]*\ssrc="([^":]+)"/g)].map((m) => m[1]);
const missImg = [];
for (const rel of localImgs) if (!(await exists(rel))) missImg.push(rel);
if (!missImg.length) ok('本地配图文件都在', `${localImgs.length} 张：${localImgs.join(', ')}`);
else bad('本地配图文件都在', '缺 ' + missImg.join(', '));

const css = await readFile(path.join(root, 'css/style.css'), 'utf8');
const cssRemote = [...css.matchAll(/url\((['"]?)(https?:[^)'"]+)\1\)/g)].map((m) => m[2]);
if (!cssRemote.length) ok('style.css 无远程 url()');
else bad('style.css 无远程 url()', cssRemote.join(' | '));

const fontsCss = await readFile(path.join(root, 'vendor/fonts.css'), 'utf8');
const fontsRemote = [...fontsCss.matchAll(/url\((['"]?)(https?:[^)'"]+)\1\)/g)].map((m) => m[2]);
if (!fontsRemote.length) ok('fonts.css 全部本地字体');
else bad('fonts.css 全部本地字体', fontsRemote.join(' | '));

/* ---------- 4. vendor 资源 ---------- */
const fontFiles = await readdir(path.join(root, 'vendor/fonts'));
const woff2 = fontFiles.filter((f) => f.endsWith('.woff2'));
const referenced = [...fontsCss.matchAll(/url\('fonts\/([^']+)'\)/g)].map((m) => m[1]);
const missFonts = referenced.filter((f) => !fontFiles.includes(f));
if (!missFonts.length) ok('fonts.css 引用的字体文件都在', `${woff2.length} 个 woff2`);
else bad('fonts.css 引用的字体文件都在', '缺 ' + missFonts.join(', '));
const cjk = fontFiles.find((f) => /NotoSerifSC-subset/.test(f));
if (cjk) {
  const size = (await readFile(path.join(root, 'vendor/fonts', cjk))).length;
  if (size > 20000) ok('中文子集字体存在且有汉字', `${cjk} ${(size / 1024).toFixed(0)} KB`);
  else bad('中文子集字体存在且有汉字', `只有 ${size} 字节`);
} else bad('中文子集字体存在且有汉字', '找不到 NotoSerifSC-subset*.woff2');

const sprite = await readFile(path.join(root, 'vendor/icons/mdi-sprite.svg'), 'utf8');
const symbols = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
if (symbols.length >= 13) ok('图标 sprite 完整', `${symbols.length} 个 symbol`);
else bad('图标 sprite 完整', `只有 ${symbols.length} 个`);
// index.html 里用到的每个图标名都必须在 sprite 里
const usedIcons = [...new Set([...html.matchAll(/icon="mdi:([^"]+)"/g)].map((m) => m[1]))];
const missIcons = usedIcons.filter((n) => !symbols.includes(`mdi-${n}`));
if (!missIcons.length) ok('页面用到的图标都在 sprite 里', `${usedIcons.length} 个`);
else bad('页面用到的图标都在 sprite 里', '缺 ' + missIcons.join(', '));

/* ---------- 5. Service Worker 预缓存清单 ---------- */
const sw = await readFile(path.join(root, 'sw.js'), 'utf8');
const listBlock = sw.slice(sw.indexOf('const PRECACHE'), sw.indexOf('];', sw.indexOf('const PRECACHE')));
const precache = [...listBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((u) => u !== './');
const missingPre = [];
for (const rel of precache) {
  if (!(await exists(rel.replace(/^\.\//, '')))) missingPre.push(rel);
}
if (!missingPre.length) ok('SW 预缓存清单文件都存在', `${precache.length} 项`);
else bad('SW 预缓存清单文件都存在', '缺 ' + missingPre.join(', '));
for (const must of ['js/lib/godogpaw/godogpaw.wasm', 'js/lib/godogpaw/wasm_exec.js', 'js/xiangqi.js']) {
  if (precache.some((p) => p.includes(must.replace(/^\.\//, '')))) ok(`SW 覆盖 ${must}`);
  else bad(`SW 覆盖 ${must}`, '不在预缓存清单里');
}

/* ---------- 6. JS 语法 ---------- */
const JS = ['js/xiangqi.js', 'js/lib/godogpaw/godogpaw-bridge.js', 'js/sw-register.js', 'sw.js',
  'vendor/iconify-lite.js', 'js/main.js', 'js/chess.js', 'js/gomoku.js'];
for (const f of JS) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
    ok(`语法 ${f}`);
  } catch (e) {
    bad(`语法 ${f}`, String(e.stderr || e.message).split('\n').slice(0, 3).join(' '));
  }
}

/* ---------- 7. 旧中国象棋文件是否已清干净 ---------- */
const OLD = ['js/xiangqi-engine/zh-chess.browser.min.js', 'js/xiangqi-worker.js', 'js/lib/eleeye/eleeye.js'];
const stillRef = OLD.filter((f) => html.includes(f) || sw.includes(f));
if (!stillRef.length) ok('index.html / sw.js 不再引用旧引擎');
else bad('index.html / sw.js 不再引用旧引擎', stillRef.join(', '));

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
if (fail) { console.log('失败项：'); problems.forEach((p) => console.log('  - ' + p)); }
process.exit(fail ? 1 : 0);
