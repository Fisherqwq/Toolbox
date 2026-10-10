/**
 * 中国象棋 · 引擎与桥接层回归测试（Node，无需浏览器）
 *
 * 覆盖：
 *   A. godogpaw.wasm 能否实例化、6 个桥接函数是否齐全
 *   B. engineGetBoard 的字段与坐标系是否与前端约定一致（实测过的那些事实）
 *   C. 走法生成、落子、悔棋、engineSearch 语义
 *   D. 桥接层的加载/就绪/输入校验/崩溃保护（畸形 FEN 绝不允许喂进 Go）
 *
 * 用法： node tools/test-xiangqi.mjs
 *
 * ⚠ 为什么 FEN 校验必须在这里守住：
 *   实测 engineNewGame 收到畸形 FEN 会让 Go 侧 panic（index out of range [128]），
 *   整个 runtime 退出，之后所有调用抛 "Go program has already exited"。
 *   这是引擎自身缺陷（已在交接文档记录，等待作者修），前端只能用白名单隔离。
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const REL = { wasm: 'js/lib/godogpaw/godogpaw.wasm', glue: 'js/lib/godogpaw/wasm_exec.js', bridge: 'js/lib/godogpaw/godogpaw-bridge.js' };
const abs = (p) => path.join(ROOT, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const problems = [];
function ok(name, detail = '') { pass++; console.log(`PASS  ${name}${detail ? '  → ' + detail : ''}`); }
function bad(name, detail = '') { fail++; problems.push(`${name}: ${detail}`); console.log(`FAIL  ${name}  → ${detail}`); }
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(name, a);
  else bad(name, `实际 ${a} ≠ 期望 ${e}`);
}

/* ============================================================
 * 浏览器环境替身：让桥接层能在 Node 里原样跑
 * ============================================================ */
const headScripts = [];
globalThis.window = globalThis;                 // 桥接层用 window.xxx 判断引擎函数
globalThis.location = { protocol: 'http:', href: `http://127.0.0.1/${REL.bridge}` };
globalThis.document = {
  head: {
    appendChild(el) {
      headScripts.push(el.src);
      const src = el.src.replace(/^https?:\/\/[^/]+\//, '');
      try {
        const code = require('node:fs').readFileSync(abs(src), 'utf8');
        new Function('require', 'globalThis', code)(require, globalThis);
        el.onload && el.onload();
      } catch (e) { el.onerror && el.onerror(e); }
    },
    querySelector: () => null,
  },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set src(v) { this._src = v; }, get src() { return this._src; } }),
};
// 桥接用 fetch 取 wasm：这里改成读本地文件
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^https?:\/\/[^/]+\//, '');
  try {
    const buf = await readFile(abs(rel));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (e) {
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
  }
};
globalThis.require = require;
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

/* ============================================================
 * A. 加载桥接 + 引擎
 * ============================================================ */
console.log('== A. 桥接层加载与引擎就绪 ==');
const bridgeSrc = await readFile(abs(REL.bridge), 'utf8');
new Function('require', 'globalThis', bridgeSrc)(require, globalThis);
if (typeof globalThis.Godogpaw === 'object') ok('桥接层挂上 window.Godogpaw');
else { bad('桥接层挂上 window.Godogpaw', '没挂上'); process.exit(1); }

eq('初始状态是 idle', globalThis.Godogpaw.state, 'idle');
try {
  await globalThis.Godogpaw.load();
  ok('load() 成功并进入 ready', globalThis.Godogpaw.state);
} catch (e) {
  bad('load() 成功并进入 ready', e.message);
  process.exit(1);
}
const APIS = ['engineNewGame', 'engineGetBoard', 'engineGetLegalMovesFrom', 'engineDoMoveBySquares', 'engineUndoMove', 'engineSearch'];
const missingApis = APIS.filter((n) => typeof globalThis[n] !== 'function');
eq('6 个引擎全局函数全部就位', missingApis, []);
ok('加载胶水脚本', headScripts.length ? headScripts[0] : '(已预载)');

/* ============================================================
 * B. 盘面字段与坐标系
 * ============================================================ */
console.log('\n== B. 盘面字段与坐标系 ==');
const sq = (file, rank) => file + rank * 9;   // rank 0 = 红方底线
const uc = (s) => `${'abcdefghi'[s % 9]}${Math.floor(s / 9)}`;
const board = () => globalThis.Godogpaw.getBoard();

let b = board();
eq('字段名与前端约定一致', Object.keys(b).sort(),
  ['board', 'inCheck', 'isGameOver', 'lastMoveFrom', 'lastMoveTo', 'sideToMove'].sort());
eq('盘面 90 格', b.board.length, 90);
eq('红先行', b.sideToMove, 0);
eq('开局未将军、未终局', [b.inCheck, b.isGameOver], [false, false]);
eq('开局 lastMove = -1,-1', [b.lastMoveFrom, b.lastMoveTo], [-1, -1]);
eq('红帅在 sq4（rank0 底线）', b.board[4], 7);
eq('黑将在 sq85（rank9 底线）', b.board[85], 15);
eq('红车 a0 / 黑车 a9', [b.board[sq(0, 0)], b.board[sq(0, 9)]], [1, 9]);
eq('红兵 a3 / 黑卒 a6', [b.board[sq(0, 3)], b.board[sq(0, 6)]], [4, 12]);
eq('红炮 b2 / 黑炮 b7', [b.board[sq(1, 2)], b.board[sq(1, 7)]], [3, 11]);
eq('红马 b0 / 黑马 b9', [b.board[sq(1, 0)], b.board[sq(1, 9)]], [5, 13]);

/* ============================================================
 * C. 走法生成 / 落子 / 悔棋 / 搜索
 * ============================================================ */
console.log('\n== C. 走法生成与对局操作 ==');
eq('红兵 a3 只能走 a4', globalThis.Godogpaw.movesFrom(sq(0, 3)), [sq(0, 4)]);
eq('轮到红方时问黑子无着法（引擎只生成走子方的着法）', globalThis.Godogpaw.movesFrom(sq(0, 6)), []);
eq('红马 b0 受蹩马腿限制', globalThis.Godogpaw.movesFrom(sq(1, 0)).sort(), [sq(0, 2), sq(2, 2)].sort());
eq('空点无着法', globalThis.Godogpaw.movesFrom(sq(4, 5)), []);
eq('越界坐标返回空数组', globalThis.Godogpaw.movesFrom(999), []);
eq('非法着法（炮斜走）返回 false', globalThis.Godogpaw.move(sq(1, 2), sq(4, 5)), false);
eq('越界着法返回 false', globalThis.Godogpaw.move(999, 5), false);
eq('非法尝试后盘面未变', board().board[19], 3);

eq('合法着法 a3a4 返回 true', globalThis.Godogpaw.move(sq(0, 3), sq(0, 4)), true);
b = board();
eq('落子后轮到黑方', b.sideToMove, 1);
eq('落子后 lastMove 正确', [b.lastMoveFrom, b.lastMoveTo], [sq(0, 3), sq(0, 4)]);
eq('落子后棋盘正确', [b.board[sq(0, 3)], b.board[sq(0, 4)]], [0, 4]);
eq('轮到黑方时黑卒有 a5 可走', globalThis.Godogpaw.movesFrom(sq(0, 6)), [sq(0, 5)]);
eq('悔棋返回 true', globalThis.Godogpaw.undo(), true);
b = board();
eq('悔棋后完全复位', [b.sideToMove, b.board[sq(0, 3)], b.board[sq(0, 4)], b.lastMoveTo], [0, 4, 0, -1]);
eq('空历史悔棋返回 false', globalThis.Godogpaw.undo(), false);

// engineSearch：自己会落子，返回 4 字符串
// ⚠ 此处必须从**干净的一局**开始：上面刚测过 a3a4，若不清盘，
//   搜索走的是黑方，轮次断言会看起来"反了"（第一次就是这么误判的）。
globalThis.Godogpaw.newGame();
const t0 = Date.now();
const mv = await globalThis.Godogpaw.search(4, 0);
const searchMs = Date.now() - t0;
if (/^[a-i][0-9][a-i][0-9]$/.test(mv)) ok('engineSearch 返回 ICCS 着法', `${mv} @${searchMs}ms`);
else bad('engineSearch 返回 ICCS 着法', String(mv));
b = board();
eq('engineSearch 内部已落子（轮次翻到黑方）', b.sideToMove, 1);
eq('engineSearch 落子后有 lastMove', b.lastMoveTo !== -1, true);

// 悔棋两步：AI + 自己 —— 上一段测试结束后盘面在开局，先补一手人着
globalThis.Godogpaw.newGame();
eq('补一手人着 a3a4', globalThis.Godogpaw.move(sq(0, 3), sq(0, 4)), true);
await globalThis.Godogpaw.search(4, 0);
eq('撤 AI 那手', globalThis.Godogpaw.undo(), true);
eq('撤自己那手', globalThis.Godogpaw.undo(), true);
eq('两步撤完回到开局（红帅归位、a3 有兵、a4 空）',
  [board().sideToMove, board().board[4], board().board[sq(0, 3)], board().board[sq(0, 4)], board().lastMoveTo],
  [0, 7, 4, 0, -1]);
eq('空历史再撤返回 false', globalThis.Godogpaw.undo(), false);

// 限时生效
globalThis.Godogpaw.newGame();
const t1 = Date.now();
await globalThis.Godogpaw.search(30, 800);
const limitedMs = Date.now() - t1;
if (limitedMs < 5000) ok('depth=30 被 800ms 限时截断', `${limitedMs}ms`);
else bad('depth=30 被 800ms 限时截断', `${limitedMs}ms（限时没生效）`);

/* ============================================================
 * D. 桥接层的防护
 * ============================================================ */
console.log('\n== D. 输入校验与崩溃保护 ==');
globalThis.Godogpaw.newGame();
const guards = [
  ['空字符串走子', () => globalThis.Godogpaw.validateFen('')],
  ['行数不足的 FEN', () => globalThis.Godogpaw.validateFen('4k4/9/9/9/9/9/9/9/4K4 w - - 0 1')],
  ['走子方非法的 FEN', () => globalThis.Godogpaw.validateFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR x - - 0 1')],
  ['少一个将的 FEN', () => globalThis.Godogpaw.validateFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/9 w - - 0 1')],
];
for (const [name, fn] of guards) {
  try { fn(); bad(name + ' 被拒', '竟然通过了'); }
  catch (e) { ok(name + ' 被拒', e.message); }
}
// 白名单外的「结构合法」FEN 也要拒绝
try {
  globalThis.Godogpaw.newGame('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1');
  bad('白名单外的 FEN 被拒', '竟然通过了');
} catch (e) { ok('白名单外的 FEN 被拒', e.message); }

// 关键：上面这些拦截之后，引擎必须还活着
try {
  const alive = globalThis.Godogpaw.getBoard();
  eq('拦截 FEN 之后引擎仍然存活', Array.isArray(alive.board) && alive.board.length === 90, true);
  eq('引擎状态仍为 ready', globalThis.Godogpaw.state, 'ready');
} catch (e) {
  bad('拦截 FEN 之后引擎仍然存活', e.message);
}

// 对照实验：把畸形 FEN 直接喂给引擎会怎样（证明护栏是必要的，不是多余的）
//
// 实测有两种结局，都必须记录、都必须被护栏挡住：
//   ① Node 直连：Go 侧 panic（index out of range [128] with length 90），
//      整个 runtime 退出，之后所有调用抛 "Go program has already exited"
//   ② 本次沙箱里这次没 panic，但 engineNewGame 被"接受"了一堆垃圾局面
//      （非法走子方 'x' 让行棋方解析成 1，盘面与轮次不自洽）
// 结论：畸形 FEN 要么打死引擎、要么污染引擎状态，两种都不能接受。
console.log('\n  [对照] 直接喂畸形 FEN 给 Go 引擎：');
const flatBefore = board().board.filter((v) => v > 0).length;
let runtimeDied = false;
try {
  globalThis.engineNewGame('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR x - - 0 1');
} catch (e) {
  runtimeDied = true;
  console.log('    引擎抛错:', String(e.message).slice(0, 90));
}
await sleep(200);
let stateAfter = null;
try {
  const g = JSON.parse(globalThis.engineGetBoard());
  stateAfter = { sideToMove: g.sideToMove, pieces: g.board.filter((v) => v > 0).length, over: g.isGameOver };
  console.log('    引擎仍可读，但盘面已被污染:', JSON.stringify(stateAfter));
} catch (e) {
  runtimeDied = true;
  console.log('    引擎已不可用:', String(e.message).slice(0, 90));
}
if (runtimeDied) {
  ok('对照实验：畸形 FEN 打死引擎（护栏必要）');
} else if (stateAfter && (stateAfter.pieces !== flatBefore || stateAfter.sideToMove !== 0)) {
  ok('对照实验：畸形 FEN 污染了引擎状态（护栏必要）',
    `子数 ${flatBefore}→${stateAfter.pieces}，行棋方 ${stateAfter.sideToMove}（非法 'x' 被解析成 1）`);
} else {
  bad('对照实验：畸形 FEN 的后果需要复核', '既没打死也没污染，与两次实测都不符');
}
// 收尾：把引擎恢复到干净的开局，避免影响后续断言
try { globalThis.Godogpaw.newGame(); } catch { /* 已死就无所谓 */ }

/* ============================================================
 * 收尾
 * ============================================================ */
if (realFetch) globalThis.fetch = realFetch;
console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
if (fail) problems.forEach((p) => console.log('  - ' + p));
process.exit(fail ? 1 : 0);
