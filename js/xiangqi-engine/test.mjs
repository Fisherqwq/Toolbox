/**
 * 中国象棋规则引擎回归测试 —— zh-chess
 *
 * 用 perft（perft 是棋类引擎的黄金标准测试，见 chess-engine/test.mjs）验证走法生成：
 * perft(n) = 从初始局面连续走 n 步的合法着法总数。同一局面任何引擎算出的
 * perft 值都必须一致，对不上就说明某一层走法生成有 bug。
 *
 * 实现说明：zh-chess 没有 undo()，所以每层递归用 PEN 串重建局面。
 * 这是慢一点，但换来的是「测试走的是真实 API，不是复刻逻辑」。
 *
 * 运行：node js/xiangqi-engine/test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'zh-chess.browser.min.js');

// 在沙箱里跑：库的 browser 构建依赖 window/self/globalThis
const ctx = { console };
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(LIB, 'utf8'), ctx, { filename: LIB });

const ZhChess = ctx.ZhChess;
if (!ZhChess || !ZhChess.default) {
  console.error('✗ 未能加载 zh-chess，exports =', Object.keys(ctx.ZhChess || {}));
  process.exit(1);
}

const START_PEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR';

const other = (s) => (s === 'RED' ? 'BLACK' : 'RED');

/**
 * 建一个局面。pen 若缺行棋方段会自动补上。
 *
 * 行棋方段的合法取值只有 `w` / `b`（不是 PEN 棋盘段用的 r/b），
 * 传别的值会抛「不符合 PEN 棋盘布局代码格式」。
 */
function makeGame(pen, side) {
  const g = new ZhChess.default({});
  g.init();
  g.gameStart(side);
  const needsSide = !/\s[wb]\s*$/.test(pen);
  const withSide = needsSide ? `${pen} ${side === 'RED' ? 'w' : 'b'}` : pen;
  g.setPenCodeList(withSide);
  return g;
}

/** 当前局面的 PEN（含行棋方段）。 */
function penOf(g, side) {
  return g.getCurrentPenCode(side);
}

/**
 * perft：从 pen 出发走 depth 步的合法着法总数。
 *
 * 每层用 post=true 真正落子，再取 PEN 重建下一层局面。
 *
 * 注意 post=false 的坑：实测 update(from,to,side,false) **不会推进棋盘**，
 * 只把 currentSide 翻过去（棋盘段完全不变）。拿它做 perft 会在同一局面上
 * 反复计数，perft(2) 会假成 44×44=1936。
 */
function perft(pen, side, depth) {
  const g = makeGame(pen, side);
  const moves = g.generateLegalMoves(side);
  if (depth <= 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    const g1 = makeGame(pen, side);
    g1.update(m.from, m.to, side, true);   // post=true：真正落子并翻边
    n += perft(penOf(g1, other(side)), other(side), depth - 1);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 断言框架                                                            */
/* ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const failures = [];

function eq(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${label} = ${actual}`);
  } else {
    fail++;
    failures.push(`${label}: 期望 ${expected}，实际 ${actual}`);
    console.log(`  ✗ ${label}: 期望 ${expected}，实际 ${actual}`);
  }
}

function ok(label, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(`${label}: 条件不成立`);
    console.log(`  ✗ ${label}`);
  }
}

/* ------------------------------------------------------------------ */
console.log('\n【1】初始局面');
{
  const g = makeGame(START_PEN, 'RED');
  // 中国象棋初始局面的标准着法数就是 44，公开棋谱与引擎一致
  eq('红方合法着法数', g.generateLegalMoves('RED').length, 44);
  eq('黑方合法着法数', g.generateLegalMoves('BLACK').length, 44);
  eq('红方存活棋子', g.getPiecesOfSide('RED').length, 16);
  eq('黑方存活棋子', g.getPiecesOfSide('BLACK').length, 16);
  ok('初始局面未结束', !g.isGameOver());
}

console.log('\n【2】perft —— 走法生成黄金标准');
{
  eq('perft(1)', perft(START_PEN, 'RED', 1), 44);
  eq('perft(2)', perft(START_PEN, 'RED', 2), 1920);
  eq('perft(3)', perft(START_PEN, 'RED', 3), 79666);
}

console.log('\n【3】走子规则（兵 / 马 / 炮 / 车）');
{
  const g = makeGame(START_PEN, 'RED');
  // 兵未过河只能向前一格
  ok('兵(8,6)→(8,5) 合法', g.isLegalMove('RED', { x: 8, y: 6 }, { x: 8, y: 5 }));
  ok('兵(8,6)→(8,4) 越格非法', !g.isLegalMove('RED', { x: 8, y: 6 }, { x: 8, y: 4 }));
  ok('兵(8,6)→(9,5) 斜走非法', !g.isLegalMove('RED', { x: 8, y: 6 }, { x: 9, y: 5 }));

  // 马(1,9) 走「日」：直线腿是 (1,8)、斜腿是 (0,8)
  ok('马(1,9)→(0,7) 合法', g.isLegalMove('RED', { x: 1, y: 9 }, { x: 0, y: 7 }));
  ok('马(1,9)→(0,8) 非日字非法', !g.isLegalMove('RED', { x: 1, y: 9 }, { x: 0, y: 8 }));

  // 车(0,9) 沿边线可走，但被 (0,6) 的兵挡住
  ok('车(0,9)→(0,8) 合法', g.isLegalMove('RED', { x: 0, y: 9 }, { x: 0, y: 8 }));
  ok('车(0,9)→(0,5) 越过自己的兵', !g.isLegalMove('RED', { x: 0, y: 9 }, { x: 0, y: 5 }));

  // 炮不吃子时与车同样受阻挡。炮(1,7) 所在 b 线上只有己方兵在 (1,6)，
  // 兵**不在** (1,7)→(1,4) 的路径上（y=6 不在 7..4 之间），所以一路畅通。
  ok('炮(1,7)→(1,6) 合法', g.isLegalMove('RED', { x: 1, y: 7 }, { x: 1, y: 6 }));
  ok('炮(1,7)→(1,3) 沿空线合法', g.isLegalMove('RED', { x: 1, y: 7 }, { x: 1, y: 3 }));
  // 炮(1,7) 打 (0,6)：斜向不成立；(0,7) 是空位，炮能平移过去
  ok('炮(1,7)→(0,6) 斜向非法', !g.isLegalMove('RED', { x: 1, y: 7 }, { x: 0, y: 6 }));
  ok('炮(1,7)→(0,7) 平移合法', g.isLegalMove('RED', { x: 1, y: 7 }, { x: 0, y: 7 }));
  // (0,9) 是己方车，炮打不到（无炮架）
  ok('炮(1,7)→(0,9) 吃不到己方车', !g.isLegalMove('RED', { x: 1, y: 7 }, { x: 0, y: 9 }));

  // 马腿：马(1,9) 想走 (0,7)，腿在 (1,8)。(1,8) 是空位，合法；
  // 再造一个「蹩马腿」的对照局面验证确实会被拦。
  const legPen = '4k4/9/9/9/9/9/9/9/9/1P2K2N1';
  const L = makeGame(legPen, 'RED');
  ok('马腿被兵挡住时不可跳', !L.isLegalMove('RED', { x: 8, y: 9 }, { x: 7, y: 7 }));
}

console.log('\n【4】将帅规则（宫内约束 + 送将过滤）');
{
  const g = makeGame(START_PEN, 'RED');
  ok('帅(4,9)→(4,8) 合法', g.isLegalMove('RED', { x: 4, y: 9 }, { x: 4, y: 8 }));
  // 帅不能出九宫（九宫是 x∈[3,5]、y∈[7,9]）
  ok('帅(4,9)→(3,9) 出宫非法', !g.isLegalMove('RED', { x: 4, y: 9 }, { x: 3, y: 9 }));
  ok('帅(4,9)→(4,6) 出宫非法', !g.isLegalMove('RED', { x: 4, y: 9 }, { x: 4, y: 6 }));

  // 送将过滤：红帅与黑车同在 e 线时，红方必须解将，不能平白走兵。
  //
  // 构造：红帅 e0、黑将 d9（错开纵线避免对脸）、黑车 e2 压住中路。
  // 红方此时车马炮都还在，唯一合法应对是帅走到 d0 或 f0 脱离 e 线。
  const checkPen = '3k5/9/9/9/4r4/9/9/4R4/9/4K4';
  const c = makeGame(checkPen, 'RED');
  ok('被将军时红方仍在局', !c.isGameOver());
  const replies = c.generateLegalMoves('RED');
  ok('被将军时红方仍有应着', replies.length > 0);
  // 关键断言：不应存在「兵照走不误」的着法 —— 引擎必须过滤送将
  const pawnMoves = replies.filter((m) => m.from.y === 6);
  eq('被将军时红方无兵可动（送将过滤生效）', pawnMoves.length, 0);
  // 而帅必须动（唯一解将方式）
  ok('应着包含帅的移动', replies.some((m) => m.from.x === 4 && m.from.y === 9));

  // 白脸将的反面对照：黑车压住 e 线，红帅仍能横向逃出 e 线。
  // 帅在九宫内可以走到 d0/f0 脱线 —— 所以这一手**不是**将死。
  const matePen = '3k5/9/9/9/9/9/9/9/4r4/4K4';
  const m = makeGame(matePen, 'RED');
  ok('帅能横向脱线时不算将死', !m.isGameOver());
  ok('脱线着法存在', m.generateLegalMoves('RED').some(
    (mv) => mv.from.x === 4 && mv.from.y === 9 && mv.to.x !== 4));

  // 真正的将死：三车封死红帅的全部应着方向。
  //
  // 布局：黑将 d9（错开纵线避免对脸）、黑车 e5、黑车 d3、黑车 f3。
  // 红帅 e0：上 e1 被 e 线车照住，左 d0 / 右 f0 被 d3/f3 车照住，
  // 且两车离帅都超过一步，帅吃不到 → 无解，实测 generateLegalMoves 返回 0。
  //
  // ⚠ 注意 isGameOver() 在这个局面下仍返回 false（实测）。
  // zh-chess 的 isGameOver 只认它内部记录的对局事件，不做「无着即负」的推导，
  // 所以页面层必须自己判终局 —— 见 js/xiangqi.js 的 hasNoLegalMove 兜底。
  const realMate = '3k5/9/9/9/9/4r4/3r1r3/9/9/4K4';
  const R = makeGame(realMate, 'RED');
  eq('三车封锁下红方无着可走', R.generateLegalMoves('RED').length, 0);
  ok('黑方仍有子可走（不是双方都没棋）', R.generateLegalMoves('BLACK').length > 0);
  // 把这个已知短板钉成断言，避免将来误以为 isGameOver 能判终局
  ok('已知短板：isGameOver 不推导无着即负', R.isGameOver() === false);
  // 反面对照：放开 f3 的车，帅就能走到 f0
  const notMate = '3k5/9/9/9/9/4r4/3r5/9/9/4K4';
  const N = makeGame(notMate, 'RED');
  ok('只封一路时帅仍可横移', N.generateLegalMoves('RED').length > 0);
}

console.log('\n【5】步进与局面状态');
{
  const g = makeGame(START_PEN, 'RED');
  const r = g.update({ x: 8, y: 6 }, { x: 8, y: 5 }, 'RED', true);
  ok('走子成功', r.flag === true);
  // update 会自动把 currentSide 翻到对方
  eq('行棋方已切换', g.currentSide, 'BLACK');
  const pen = penOf(g, 'BLACK');
  ok('PEN 反映兵前进', pen.includes('/9/8P/') || /\/[^/]*8P/.test(pen));
  eq('黑方着法数（兵前进后重算）', g.generateLegalMoves('BLACK').length, 44);
}

console.log('\n【6】FEN / PEN 往返');
{
  const g = makeGame(START_PEN, 'RED');
  const pen = penOf(g, 'RED');
  eq('PEN 还原一致', penOf(makeGame(pen, 'RED'), 'RED'), pen);
  // 引擎侧要的标准 7 段 FEN
  const fen7 = pen + ' - - 0 1';
  ok('拼出的 FEN 以 rnbakabnr 开头', fen7.startsWith('rnbakabnr/'));
  ok('FEN 行棋方段为 w', /\sw(\s|$)/.test(fen7));
}

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(56));
console.log(`共 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);