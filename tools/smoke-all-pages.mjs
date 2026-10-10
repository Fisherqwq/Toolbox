/**
 * 全站冒烟：四个路由逐个打开，检查控制台错误、图标/字体是否本地加载、关键 DOM 是否在位。
 * 用来确认改中国象棋 + 本地化字体/图标 + 装 Service Worker 之后，别的页面没被弄坏。
 * 用法： node tools/smoke-all-pages.mjs [端口]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.argv[2] || 8310);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(2); }

const server = spawn(process.env.PYTHON || 'python', [path.join(root, 'tools', 'serve.py'), String(PORT)],
  { cwd: root, stdio: 'ignore', windowsHide: true });
for (let i = 0; i < 60; i++) { await sleep(200); try { const r = await fetch(BASE + '/index.html'); if (r.ok) { await r.text(); break; } } catch {} }

const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 1000 } });

let pass = 0, fail = 0;
const problems = [];
const ok = (n, d = '') => { pass++; console.log(`PASS  ${n}${d ? '  → ' + d : ''}`); };
const bad = (n, d = '') => { fail++; problems.push(`${n}: ${d}`); console.log(`FAIL  ${n}  → ${d}`); };

const ROUTES = [
  { hash: '#/', name: '首页', view: 'view-home' },
  { hash: '#/chess', name: '国际象棋', view: 'view-chess' },
  { hash: '#/gomoku', name: '五子棋', view: 'view-gomoku' },
  { hash: '#/xiangqi', name: '中国象棋', view: 'view-xiangqi' },
  { hash: '#/crypto', name: '加密工具', view: 'view-crypto' },
];

for (const r of ROUTES) {
  console.log(`\n== ${r.name} (${r.hash}) ==`);
  const page = await browser.newPage();
  const errs = [];
  const failedReqs = [];
  const remoteReqs = [];
  const notFound = [];
  const consoleWithUrl = [];   // [控制台文本, 触发它的请求 URL]
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  // 控制台错误往往只说"404 File not found"，所以同时记下"上一条发生错误的请求 URL"
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location && m.location();
    errs.push(m.text());
    consoleWithUrl.push([m.text(), loc && loc.url ? loc.url : '(无 URL)']);
  });
  page.on('requestfailed', (q) => failedReqs.push(`${q.url()} ${q.failure()?.errorText || ''}`));
  // 把 404 的 URL 单独记下来：控制台只说"404 File not found"，不说是谁
  page.on('response', (res) => { if (res.status() >= 400) notFound.push(res.status() + ' ' + res.url()); });
  // 记录所有跨域请求：整站应该一个都没有（字体/图标/配图都已本地化）
  page.on('request', (q) => {
    const u = q.url();
    if (/^https?:/i.test(u) && !u.startsWith(BASE)) remoteReqs.push(u);
  });

  await page.goto(`${BASE}/index.html${r.hash}`, { waitUntil: 'domcontentloaded' });
  await sleep(6000);   // 给各页面的初始化留时间（国际象棋会探测 stockfish、中国象棋要装 wasm）
  // 滚到底再回顶，强制触发 loading="lazy" 的配图，否则懒加载图不会被请求
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);

  const state = await page.evaluate((view) => {
    const v = document.getElementById(view);
    // 图标是否渲染成 svg（本地 iconify-lite 生效）
    const iconBoxes = [...document.querySelectorAll('iconify-icon')];
    const rendered = iconBoxes.filter((el) => el.querySelector('svg use')).length;
    // 字体是否来自本地
    const localFonts = [...document.styleSheets]
      .flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .filter((r) => r.constructor.name === 'CSSFontFaceRule')
      .map((r) => r.style.getPropertyValue('src')).filter(Boolean);
    // 配图是否真的解码出来了（naturalWidth>0 才算加载成功）。
    // ⚠ 只统计**当前可见视图内部**的图：其它视图是 display:none，
    //   里面 loading="lazy" 的图永远不会加载，统计进去就是误报（踩过）。
    const scoped = v ? [...v.querySelectorAll('img')] : [];
    return {
      viewVisible: !!v && !v.classList.contains('hidden'),
      icons: iconBoxes.length,
      iconsRendered: rendered,
      fontRules: localFonts.length,
      remoteFontRules: localFonts.filter((s) => /https?:/.test(s)).length,
      sw: !!navigator.serviceWorker && !!navigator.serviceWorker.controller,
      canvasSizes: [...document.querySelectorAll('canvas')].map((c) => `${c.id}:${c.width}x${c.height}`),
      imgs: scoped.map((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0, nw: i.naturalWidth })),
    };
  }, r.view);

  if (state.viewVisible) ok(`${r.name} 视图可见`);
  else bad(`${r.name} 视图可见`, `${r.view} 仍是 hidden`);

  if (state.icons === 0 || state.iconsRendered === state.icons) ok(`${r.name} 图标全部渲染`, `${state.iconsRendered}/${state.icons}`);
  else bad(`${r.name} 图标全部渲染`, `只渲染了 ${state.iconsRendered}/${state.icons}`);

  if (state.remoteFontRules === 0) ok(`${r.name} 字体全本地`, `${state.fontRules} 条 @font-face`);
  else bad(`${r.name} 字体全本地`, `${state.remoteFontRules} 条指向远程`);

  // 配图必须全部解码成功（首页那 5 张现在都是本地 WebP）
  const badImgs = state.imgs.filter((i) => !i.ok);
  if (!badImgs.length) ok(`${r.name} 配图全部加载`, state.imgs.length ? `${state.imgs.length} 张` : '本页无配图');
  else bad(`${r.name} 配图全部加载`, badImgs.map((i) => i.src).join(', '));

  if (!remoteReqs.length) ok(`${r.name} 零跨域请求`, '字体/图标/配图全本地');
  else bad(`${r.name} 零跨域请求`, [...new Set(remoteReqs)].slice(0, 3).join(' || '));

  // 允许的既有噪声（stockfish 探测、棋盘 SVG 在无头环境被 COEP 拦等）
  const noise = /stockfish|NotSameOriginAfterDefaultedToSameOriginByCoep|net::ERR_CONNECTION_REFUSED|favicon/i;
  const realErrs = errs.filter((t) => !noise.test(t));
  const realFailed = failedReqs.filter((t) => !noise.test(t));
  // 404 里除了 favicon 都算问题，并把 URL 打出来（控制台不说 URL）
  const realNotFound = notFound.filter((u) => !/favicon/i.test(u));
  if (!realErrs.length && !realFailed.length && !realNotFound.length) {
    ok(`${r.name} 控制台干净`, `（已忽略噪声 ${errs.length + failedReqs.length} 条）`);
  } else {
    bad(`${r.name} 控制台干净`, [...realErrs, ...realFailed, ...realNotFound.map((u) => '404 ' + u)].slice(0, 3).join(' || '));
  }

  if (state.canvasSizes.length) console.log(`  canvas: ${state.canvasSizes.join(', ')}`);
  await page.close();
}

await browser.close();
server.kill();
console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
if (fail) problems.forEach((p) => console.log('  - ' + p));
process.exit(fail ? 1 : 0);
