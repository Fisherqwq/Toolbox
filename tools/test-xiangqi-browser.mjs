/**
 * 中国象棋分页 · 浏览器端到端测试（puppeteer-core + 系统 Chrome）
 *
 * 覆盖：
 *   1. 页面能开、引擎能加载就绪、无严重控制台报错
 *   2. 棋盘确实画出来了（canvas 上有非背景像素）
 *   3. 点两下能走子（选子 → 落点），落子后棋盘变化 + 轮到 AI
 *   4. AI 会在合理时间内应手（引擎会自动落子，页面不重复落子）
 *   5. 悔棋把局面还原
 *   6. 难度：走到第一步后按钮被锁
 *   7. 翻转棋盘不改变盘面数据
 *   8. Service Worker 注册成功且预缓存里能查到 wasm
 *   9. 截图留证（tmp_verify/*.png）
 *
 * 用法： node tools/test-xiangqi-browser.mjs [端口]
 *   需要先起静态服务器：python tools/serve.py 8011
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.argv[2] || 8011);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(root, 'tmp_verify');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Edge，无法跑浏览器测试'); process.exit(2); }

const puppeteer = require('puppeteer-core');
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const problems = [];
function ok(name, detail = '') { pass++; log(`PASS  ${name}${detail ? '  → ' + detail : ''}`); }
function bad(name, detail = '') { fail++; problems.push(`${name}: ${detail}`); log(`FAIL  ${name}  → ${detail}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 起静态服务器 ---------- */
async function startServer() {
  const py = process.env.PYTHON || 'python';
  const proc = spawn(py, [path.join(root, 'tools', 'serve.py'), String(PORT)], {
    cwd: root, stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try {
      const r = await fetch(BASE + '/index.html');
      if (r.ok) { await r.text(); return proc; }   // 必须读完 body，否则 undici 会抛断言错
    } catch { /* 还没起来 */ }
  }
  proc.kill();
  throw new Error(`静态服务器 ${BASE} 没起来`);
}

const server = await startServer();
log(`静态服务器已起：${BASE}`);

await mkdir(SHOTS, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000'],
  defaultViewport: { width: 1440, height: 1000 },
});

const consoleErrors = [];
const consoleWarns = [];
const page = await browser.newPage();
page.on('console', (msg) => {
  const t = msg.type();
  const text = msg.text();
  if (t === 'error') consoleErrors.push(text);
  else if (t === 'warning') consoleWarns.push(text);
});
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', (req) => consoleErrors.push(`REQUESTFAILED ${req.url()} ${req.failure()?.errorText || ''}`));

/* ---------- 1. 打开页面 ---------- */
log('\n== 1. 打开中国象棋页 ==');
await page.goto(`${BASE}/index.html#/xiangqi`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#view-xiangqi:not(.hidden)', { timeout: 15000 });
ok('路由切到 #/xiangqi，视图可见');

// 等引擎就绪（bridge 加载 wasm + 轮询全局函数）
let ready = false;
try {
  await page.waitForFunction(() => window.Godogpaw && window.Godogpaw.state === 'ready', { timeout: 60000, polling: 200 });
  ready = true;
} catch { ready = false; }
if (ready) ok('引擎就绪', await page.evaluate(() => window.Godogpaw.state));
else bad('引擎就绪', 'state = ' + await page.evaluate(() => (window.Godogpaw ? window.Godogpaw.state : 'window.Godogpaw 不存在')));

/* ---------- 2. 棋盘画出来了 ---------- */
log('\n== 2. 棋盘渲染 ==');
const pix = await page.evaluate(() => {
  const c = document.getElementById('xqCanvas');
  const g = c.getContext('2d');
  const { data } = g.getImageData(0, 0, c.width, c.height);
  const seen = new Set();
  let drawn = 0;
  for (let i = 0; i < data.length; i += 4 * 97) {
    const key = data[i] + ',' + data[i + 1] + ',' + data[i + 2];
    seen.add(key);
    if (!(data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 160) && data[i + 3] > 0) drawn++;
  }
  return { colors: seen.size, drawn, w: c.width, h: c.height };
});
if (pix.colors > 5 && pix.drawn > 0) ok('canvas 上有实际绘制内容', `${pix.colors} 种颜色, ${pix.drawn} 个非底色采样点, ${pix.w}x${pix.h}`);
else bad('canvas 上有实际绘制内容', JSON.stringify(pix));

/* ---------- 3. 走一步棋 ---------- */
log('\n== 3. 点击走子（红兵 a3→a4）==');
// 先把画布滚进视口：puppeteer 的 mouse.click 用视口坐标，超出视口的点不会命中
await page.evaluate(() => {
  document.getElementById('xqCanvas').scrollIntoView({ block: 'center' });
  window.XiangqiDebug = true;   // 打开页面内置的调试埋点，便于失败时取证
});
await sleep(600);
// 布局稳定后再读几何（滚动/字体加载会让 rect 变动）
const geom = await page.evaluate(() => {
  const c = document.getElementById('xqCanvas');
  const r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});
// 逻辑坐标 → 页面坐标。MARGIN=44, CELL=69, 逻辑画布 640x709，红方在下：py = 44 + (9-rank)*69
const MARGIN = 44, CELL = 69, LOGICAL_W = 640, LOGICAL_H = 709;
const toPage = (file, rank) => ({
  x: geom.left + ((MARGIN + file * CELL) / LOGICAL_W) * geom.width,
  y: geom.top + ((MARGIN + (9 - rank) * CELL) / LOGICAL_H) * geom.height,
});

const before = await page.evaluate(() => JSON.stringify(window.Godogpaw.getBoard().board));
const a3 = toPage(0, 3);
await page.mouse.click(a3.x, a3.y);
await sleep(250);
const targets = await page.evaluate(() => window.Godogpaw.movesFrom(27));   // 27 = a3
if (targets.length === 1 && targets[0] === 36) ok('选中 a3 兵后只报 a4 一个落点', `targets=${JSON.stringify(targets)}`);
else bad('选中 a3 兵后只报 a4 一个落点', `targets=${JSON.stringify(targets)}`);

// 命中检测必须落在同一个交叉点：用页面内埋点核对
const hitLog = await page.evaluate(() => (window.__xqLog || []).filter((l) => l.tag === 'hit').slice(-1)[0] || null);
if (hitLog && hitLog.data && Math.abs(hitLog.data.sq - 27) <= 1) {
  ok('点击命中检测落在 a3 附近', `sq=${hitLog.data.sq}`);
} else if (hitLog) {
  bad('点击命中检测落在 a3 附近', `sq=${hitLog.data && hitLog.data.sq}`);
} else {
  log('  （没有 hit 埋点，跳过命中核对）');
}

const hasSelectStyle = await page.evaluate(() => {
  // 选中后 canvas 内容应发生变化（高亮），用像素哈希粗判
  const c = document.getElementById('xqCanvas');
  const g = c.getContext('2d');
  const { data } = g.getImageData(0, 0, c.width, c.height);
  let blue = 0;
  for (let i = 0; i < data.length; i += 4 * 31) {
    if (data[i + 2] > data[i] + 24 && data[i + 2] > 120) blue++;
  }
  return blue;
});
if (hasSelectStyle > 0) ok('选中高亮/落点提示已画到 canvas', `${hasSelectStyle} 个偏蓝采样点`);
else bad('选中高亮/落点提示已画到 canvas', '没找到高亮像素');

// 采样必须在点击 a4 之前就装好：引擎 depth4 只要约 60ms，
// 「人走完、AI 未走」那一帧转瞬即逝，晚一步就永远取不到。
await page.evaluate(() => {
  window.__fp = (arr) => { let h = 0; for (let i = 0; i < 90; i++) h = (h * 31 + arr[i]) % 2147483647; return h; };
  const b = window.Godogpaw.getBoard();
  window.__fpStart = window.__fp(b.board);
  window.__fpAfterHuman = null;
  window.__sideAfterHuman = null;
  window.__fpSamples = [];
  clearInterval(window.__sampleTimer);
  window.__sampleTimer = setInterval(() => {
    const s = window.Godogpaw.getBoard();
    const h = window.__fp(s.board);
    window.__fpSamples.push(h + ':' + s.sideToMove);
    if (window.__fpSamples.length > 400) window.__fpSamples.shift();
    if (h !== window.__fpStart && s.sideToMove === 1 && window.__fpAfterHuman === null) {
      window.__fpAfterHuman = h;
      window.__sideAfterHuman = s.sideToMove;
    }
  }, 4);
});
const a4 = toPage(0, 4);
await page.mouse.click(a4.x, a4.y);   // ← 采样已经在跑了
await sleep(400);
const after = await page.evaluate(() => JSON.stringify(window.Godogpaw.getBoard().board));
// 取证：把关键格与当时的轮次打出来，避免"看着一样其实不一样"的误判
const afterProbe = await page.evaluate(() => {
  const b = window.Godogpaw.getBoard();
  return { side: b.sideToMove, a3: b.board[27], a4: b.board[36], b7: b.board[64], e7: b.board[67], last: [b.lastMoveFrom, b.lastMoveTo] };
});
log(`  落子后取证: ${JSON.stringify(afterProbe)}`);
if (after !== before) ok('落子后盘面发生变化', `a3=${afterProbe.a3} a4=${afterProbe.a4}`);
else {
  const st = await page.evaluate(() => ({
    status: document.getElementById('xqStatusText').textContent,
    hits: (window.__xqLog || []).filter((l) => l.tag === 'hit').map((l) => l.data.sq),
  }));
  bad('落子后盘面发生变化', `状态="${st.status}" 命中序列=${JSON.stringify(st.hits)}`);
}

/* ---------- 4. AI 应手 ---------- */
log('\n== 4. AI 应手 ==');
const fpAfterHuman = await page.evaluate(async () => {
  for (let i = 0; i < 200 && window.__fpAfterHuman === null; i++) await new Promise((r) => setTimeout(r, 10));
  return window.__fpAfterHuman;
});
const sampleInfo = await page.evaluate(() => ({
  side: window.__sideAfterHuman,
  start: window.__fpStart,
  samples: window.__fpSamples.length,
  distinct: new Set(window.__fpSamples).size,
  firstFew: window.__fpSamples.slice(0, 8),
}));
log(`  采样：起始指纹=${sampleInfo.start}，采到 ${sampleInfo.samples} 帧 / ${sampleInfo.distinct} 种状态 ${JSON.stringify(sampleInfo.firstFew)}`);
if (fpAfterHuman !== null) ok('抓到「人走完、AI 未走」那一帧', `指纹=${fpAfterHuman} side=${sampleInfo.side}`);
else log('  （让位：AI 只要几十毫秒，4ms 采样未必抓得到中间帧；下一步的应手断言才是关键）');

let aiMoved = false;
try {
  await page.waitForFunction((prev) => {
    const b = window.Godogpaw.getBoard();
    const h = window.__fp(b.board);
    window.__aiProbe = { side: b.sideToMove, hash: h, prev, changed: h !== prev, last: [b.lastMoveFrom, b.lastMoveTo] };
    return b.sideToMove === 0 && h !== prev;
  }, { timeout: 30000, polling: 100 }, fpAfterHuman);
  aiMoved = true;
} catch {
  aiMoved = false;
}
await page.evaluate(() => clearInterval(window.__sampleTimer));
if (aiMoved) {
  const st = await page.evaluate(() => {
    const b = window.Godogpaw.getBoard();
    return { side: b.sideToMove, last: [b.lastMoveFrom, b.lastMoveTo], history: document.querySelectorAll('#xqHistoryList .xq-history-row').length };
  });
  ok('AI 已应手且轮回红方', `sideToMove=${st.side}, 最近一手=${st.last.join('→')}, 记录 ${st.history} 行`);
  if (st.history >= 1) ok('走子记录里有内容');
  else bad('走子记录里有内容', '记录列表还是空的');
} else {
  const diag = await page.evaluate(() => ({
    thinking: document.getElementById('xqThinkingIndicator').classList.contains('visible'),
    status: document.getElementById('xqStatusText').textContent,
    gState: window.Godogpaw.state,
    rows: document.querySelectorAll('#xqHistoryList .xq-history-row').length,
    board: (() => { const b = window.Godogpaw.getBoard(); return { side: b.sideToMove, last: [b.lastMoveFrom, b.lastMoveTo] }; })(),
    log: (window.__xqLog || []).map((l) => [l.tag, l.data]),
  }));
  bad('AI 已应手且轮回红方', '30 秒内 AI 没落子。诊断: ' + JSON.stringify(diag) + ' | waitProbe: ' + JSON.stringify(await page.evaluate(() => window.__aiProbe)));
}

/* ---------- 5. 难度锁定 ---------- */
log('\n== 5. 开局后锁定难度 ==');
const locked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#xqDepthGroup .xq-diff-btn')];
  return { total: btns.length, disabled: btns.filter((b) => b.disabled).length };
});
if (locked.total === 4 && locked.disabled === 4) ok('四个难度按钮全被锁', `${locked.disabled}/${locked.total}`);
else bad('四个难度按钮全被锁', `${locked.disabled}/${locked.total}`);

/* ---------- 6. 翻转棋盘 ---------- */
log('\n== 6. 翻转棋盘 ==');
const boardBefore = await page.evaluate(() => JSON.stringify(window.Godogpaw.getBoard().board));
await page.click('#xqFlipBtn');
await sleep(200);
const boardAfter = await page.evaluate(() => JSON.stringify(window.Godogpaw.getBoard().board));
if (boardBefore === boardAfter) ok('翻转不改变盘面数据（只改绘制方向）');
else bad('翻转不改变盘面数据', '盘面数据被改了');

/* ---------- 7. 悔棋 ---------- */
log('\n== 7. 悔棋 ==');
/**
 * ⚠ 必须走页面自己的「新对局」按钮，不能直接调 window.Godogpaw.newGame()：
 *   直接调桥接只清引擎、不清页面记录，会让两边状态脱节
 *   （实测症状：引擎历史已空、页面记录还有 2 手，悔棋自然撤不动）。
 */
await page.click('#xqRestartBtn');
await sleep(400);
const startBoard = await page.evaluate(() => JSON.stringify(window.Godogpaw.getBoard().board));
await page.evaluate(() => {
  const c = document.getElementById('xqCanvas');
  const b = c.getBoundingClientRect();
  const M = 44, CL = 69, LW = 640, LH = 709;
  const pt = (f, rk) => ({ x: b.left + ((M + f * CL) / LW) * b.width, y: b.top + ((M + (9 - rk) * CL) / LH) * b.height });
  const a3 = pt(0, 3), a4 = pt(0, 4);
  c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: a3.x, clientY: a3.y }));
  c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: a4.x, clientY: a4.y }));
});
// 等 AI 应手，并且等到悔棋按钮真的可用（AI 回合期间它是禁用的，点了会被吞掉）
try {
  await page.waitForFunction(() => {
    const b = window.Godogpaw.getBoard();
    const btn = document.getElementById('xqUndoBtn');
    return b.sideToMove === 0 && window.__fp(b.board) !== window.__fpAfterHuman && btn && !btn.disabled;
  }, { timeout: 30000, polling: 100 });
} catch {
  const why = await page.evaluate(() => ({
    side: window.Godogpaw.getBoard().sideToMove,
    btnDisabled: document.getElementById('xqUndoBtn').disabled,
    rows: document.querySelectorAll('#xqHistoryList .xq-history-row').length,
  }));
  log(`  ⚠ 等悔棋可用超时: ${JSON.stringify(why)}`);
}
const undoStartProbe = await page.evaluate(() => {
  const b = window.Godogpaw.getBoard();
  return { side: b.sideToMove, fp: window.__fp(b.board), target: window.__fpAfterHuman, rows: document.querySelectorAll('#xqHistoryList .xq-history-row').length };
});
log(`  悔棋前：fingerprint=${undoStartProbe.fp} side=${undoStartProbe.side} 记录=${undoStartProbe.rows} 行`);
const histBefore = undoStartProbe.rows;
// 点击前先确认按钮真的可点（AI 回合期间它是禁用的，此时点击会被浏览器吞掉）
const btnState = await page.evaluate(() => {
  const b = document.getElementById('xqUndoBtn');
  return { disabled: b.disabled, hasOffsetParent: !!b.offsetParent, html: b.outerHTML.slice(0, 90) };
});
log(`  悔棋按钮: ${JSON.stringify(btnState)}`);
if (btnState.disabled) {
  // 还禁用就多等一会，最多 20 秒
  try {
    await page.waitForFunction(() => !document.getElementById('xqUndoBtn').disabled, { timeout: 20000, polling: 100 });
    log('  （等待后按钮已可用）');
  } catch { log('  ⚠ 等待按钮可用超时'); }
}
// 装一个诊断监听器：确认点击到底有没有落到这个按钮上
await page.evaluate(() => {
  window.__undoClicks = 0;
  document.getElementById('xqUndoBtn').addEventListener('click', () => { window.__undoClicks++; }, true);
});
await page.click('#xqUndoBtn');
await sleep(700);
log(`  按钮收到点击次数 = ${await page.evaluate(() => window.__undoClicks)}`);
const undoState = await page.evaluate(() => {
  const b = window.Godogpaw.getBoard();
  return {
    side: b.sideToMove,
    rows: document.querySelectorAll('#xqHistoryList .xq-history-row').length,
    board: JSON.stringify(b.board),
    a3: b.board[27],
    a4: b.board[36],
  };
});
if (undoState.side === 0) ok('悔棋后轮到红方', `sideToMove=${undoState.side}（悔棋前记录 ${histBefore} 行）`);
else bad('悔棋后轮到红方', `sideToMove=${undoState.side}`);
if (undoState.a3 === 4 && undoState.a4 === 0) ok('悔棋后 a3 恢复红兵 / a4 空', `a3=${undoState.a3} a4=${undoState.a4}`);
else bad('悔棋后 a3 恢复红兵 / a4 空', `a3=${undoState.a3} a4=${undoState.a4}`);
if (undoState.board === startBoard) ok('悔棋还原到开局盘面');
else bad('悔棋还原到开局盘面', '与开局不一致');
log(`  悔棋诊断: ${JSON.stringify(await page.evaluate(() => (window.__xqLog || []).filter((l) => /^undo|^new-game/.test(l.tag))))}`);
if (undoState.rows === 0) ok('悔棋后走子记录清空');
else bad('悔棋后走子记录清空', `还有 ${undoState.rows} 行`);

/* ---------- 8. 新对局解锁难度 ---------- */
log('\n== 8. 新对局解锁 ==');
await page.click('#xqRestartBtn');
await sleep(400);
const unlocked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#xqDepthGroup .xq-diff-btn')];
  return { disabled: btns.filter((b) => b.disabled).length, hist: document.querySelectorAll('#xqHistoryList .xq-history-row').length };
});
if (unlocked.disabled === 0 && unlocked.hist === 0) ok('新对局后难度解锁、记录清空', `disabled=${unlocked.disabled} rows=${unlocked.hist}`);
else bad('新对局后难度解锁、记录清空', JSON.stringify(unlocked));

/* ---------- 9. 引擎桥接的防护 ---------- */
log('\n== 9. 桥接层防护 ==');
const guard = await page.evaluate(() => {
  const out = {};
  // 畸形 FEN 必须在 JS 侧就被挡下来，绝不能喂给 Go（否则 panic 打死 runtime）
  try { window.Godogpaw.newGame('4k4/9/9/9/9/9/9/9/9/4K4 b - - 0 1'); out.badFen = '没拦住'; }
  catch (e) { out.badFen = e.message; }
  // 白名单外的合法结构 FEN 也要拒绝
  try { window.Godogpaw.newGame('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1'); out.offWhitelist = '没拦住'; }
  catch (e) { out.offWhitelist = e.message; }
  // 越界坐标
  out.outOfRange = window.Godogpaw.move(999, 5);
  out.legalMoveRejected = window.Godogpaw.move(27, 50);   // a3 → e5（兵不能横走这么远）
  out.state = window.Godogpaw.state;
  return out;
});
if (/FEN/.test(guard.badFen) && !/没拦住/.test(guard.badFen)) ok('畸形 FEN 被 JS 侧拦下', guard.badFen);
else bad('畸形 FEN 被 JS 侧拦下', String(guard.badFen));
if (!/没拦住/.test(guard.offWhitelist)) ok('白名单外的 FEN 被拒', guard.offWhitelist);
else bad('白名单外的 FEN 被拒', String(guard.offWhitelist));
if (guard.outOfRange === false && guard.legalMoveRejected === false) ok('越界/非法着法返回 false', JSON.stringify({ range: guard.outOfRange, illegal: guard.legalMoveRejected }));
else bad('越界/非法着法返回 false', JSON.stringify(guard));
if (guard.state === 'ready') ok('防护测试后引擎仍然就绪（没被打死）', guard.state);
else bad('防护测试后引擎仍然就绪', guard.state);

/* ---------- 10. Service Worker ---------- */
log('\n== 10. Service Worker ==');
const swInfo = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { supported: true, registered: false };
  // 等激活
  for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const keys = await caches.keys();
  let hasWasm = false, total = 0;
  for (const k of keys) {
    const c = await caches.open(k);
    const reqs = await c.keys();
    total += reqs.length;
    if (reqs.some((r) => /godogpaw\.wasm$/.test(r.url))) hasWasm = true;
  }
  return { supported: true, registered: true, scope: reg.scope, active: !!reg.active, controlled: !!navigator.serviceWorker.controller, caches: keys, cached: total, hasWasm };
});
if (swInfo.registered && swInfo.active) ok('Service Worker 已注册并激活', `scope=${swInfo.scope}`);
else bad('Service Worker 已注册并激活', JSON.stringify(swInfo));
if (swInfo.hasWasm) ok('预缓存里包含 godogpaw.wasm', `共缓存 ${swInfo.cached} 个请求, caches=${(swInfo.caches || []).join(',')}`);
else bad('预缓存里包含 godogpaw.wasm', JSON.stringify(swInfo));

/* ---------- 11. 截图 ---------- */
await page.screenshot({ path: path.join(SHOTS, 'xq-page.png'), fullPage: true });
await page.screenshot({ path: path.join(SHOTS, 'xq-view.png') });
ok('截图已保存', 'tmp_verify/xq-page.png, tmp_verify/xq-view.png');

/* ---------- 12. 控制台报错 ---------- */
log('\n== 12. 控制台 ==');
// 客户端按来源分开统计：
//   · 本站脚本抛的异常（pageerror）→ 一定算问题
//   · 请求失败 → 只有非国际象棋引擎探测的才算问题
//     （js/lib/stockfish.js 的 worker 探测在断网/无头环境下必然报 ERR_ABORTED，
//       那是国际象棋页的既有行为，与中国象棋无关）
const pageErrs = consoleErrors.filter((t) => t.startsWith('PAGEERROR'));
const reqFails = consoleErrors.filter((t) => t.startsWith('REQUESTFAILED'));
const otherErrs = consoleErrors.filter((t) => !t.startsWith('PAGEERROR') && !t.startsWith('REQUESTFAILED'));
// 既有噪声：国际象棋的 stockfish 探测、首页的 picsum 配图（无头环境请求被 COEP 拦）
const chessNoise = reqFails.filter((t) => /stockfish/i.test(t));
const imgNoise = reqFails.filter((t) => /picsum|img\/chess\//i.test(t));
const realReqFails = reqFails.filter((t) => !/stockfish|picsum|img\/chess\//i.test(t));
const realOther = otherErrs.filter((t) => !/404 \(File not found\)|NotSameOriginAfterDefaultedToSameOriginByCoep|ERR_CONNECTION_REFUSED/i.test(t));

if (!pageErrs.length) ok('页面脚本无未捕获异常');
else bad('页面脚本无未捕获异常', pageErrs.slice(0, 4).join(' || '));
if (!realReqFails.length) ok('无本站资源请求失败', (chessNoise.length + imgNoise.length) ? `（已归类的既有噪声 ${chessNoise.length + imgNoise.length} 条）` : '');
else bad('无本站资源请求失败', realReqFails.slice(0, 4).join(' || '));
if (!realOther.length) ok('无其它严重报错');
else bad('无其它严重报错', realOther.slice(0, 4).join(' || '));
log(`  参考：警告 ${consoleWarns.length} 条；已归类噪声 ${chessNoise.length + imgNoise.length + (otherErrs.length - realOther.length)} 条`);
log('  引擎自身的 info score 行走 console.log，不计入错误，属正常输出');

await browser.close();
server.kill();

const summary = {
  pass, fail, problems,
  consoleErrors: [...pageErrs, ...realReqFails, ...realOther],
  noise: { chessNoise: chessNoise.length, imgNoise: imgNoise.length, other: otherErrs.length - realOther.length },
  timestamp: new Date().toISOString(),
};
await writeFile(path.join(SHOTS, 'xq-browser-result.json'), JSON.stringify(summary, null, 2), 'utf8');
log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
if (fail) problems.forEach((p) => log('  - ' + p));
process.exit(fail ? 1 : 0);
