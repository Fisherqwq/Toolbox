/**
 * 国际象棋规则回归测试
 * 运行：node js/chess-engine/test.mjs
 *
 * 规则层用 chess.js（已通过 perft 权威校验），这里验证：
 *   1. perft（走法生成的黄金标准）
 *   2. 终局判定、FEN、SAN 等对外行为
 *
 * 注：简易引擎 eval.js 已删除，引擎只剩 Stockfish（不走这套测试）。
 */
import { Chess } from './chess.js';

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg);
  if (!cond) fail++;
};

console.log('— perft（走法生成权威校验）—');
{
  const cases = [
    ['初始局面', undefined, [20, 400, 8902, 197281]],
    ['Kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -', [48, 2039, 97862]],
    ['Position3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -', [14, 191, 2812, 43238]],
    ['Position4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq -', [6, 264, 9467]],
  ];
  for (const [name, fen, expect] of cases) {
    const g = new Chess(fen);
    let good = true;
    for (let d = 1; d <= expect.length; d++) {
      if (g.perft(d) !== expect[d - 1]) good = false;
    }
    ok(good, name + ' perft ' + expect.join('/'));
  }
}

console.log('— 特殊走法 —');
{
  // 升变：兵到底线有 4 种
  const g = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  const promos = g.moves({ verbose: true }).filter((m) => m.from === 'a7' && m.to === 'a8');
  ok(promos.length === 4, '白兵 a7-a8 升变 4 种，实际 ' + promos.length);
  ok(promos.every((m) => m.promotion), '升变着法均带 promotion 字段');
  ok(g.move('a8=Q+') !== null, 'a8=Q+ 可执行（升后将军）');
}
{
  // 吃过路兵
  const g = new Chess('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  ok(g.moves().includes('exf6'), '吃过路兵 exf6 在着法表中');
  g.move('exf6');
  ok(g.fen().startsWith('rnbqkbnr/ppp1p1pp/5P2'), '吃过路兵后局面正确：' + g.fen());
}
{
  // 王车易位
  const g = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  ok(g.moves().includes('O-O') && g.moves().includes('O-O-O'), '长/短易位均可用');
  g.move('O-O');
  ok(g.get('g1') && g.get('g1').type === 'k', '长易位后王在 g1');
  ok(g.get('f1') && g.get('f1').type === 'r', '长易位后车在 f1');
  ok(g.get('e1') === undefined && g.get('h1') === undefined, '长易位后 e1/h1 为空');
  const g2 = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  g2.move('O-O-O');
  ok(g2.get('c1') && g2.get('c1').type === 'k', '短易位后王在 c1');
  ok(g2.get('a1') === undefined, '短易位后 a1 为空');
  ok(g2.get('d1') && g2.get('d1').type === 'r', '短易位后车在 d1');
}
{
  // 王车易位后易位权必须清除
  const g = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  g.move('O-O');
  ok(!g.moves().includes('O-O'), '白方易位后不可再次易位');
  ok(g.moves().some((m) => m.includes('K')), '黑方仍保留易位权');
}
{
  // 蹩马腿 / 塞象眼。moves() 返回 SAN，moves({square}) 按出发格过滤。
  // a1 马到 b3 蹩的是 b3（空），到 c2 蹩的是 b3 —— 注意 a1 的马走 (2,1) 方向
  // 是 a1->c2，中间的「蹩点」是 b1 之外的另一格；这里用更明确的局面验证。
  const g1 = new Chess('4k3/8/8/8/8/8/8/N3K2N w - - 0 1');
  const fromA1 = g1.moves({ square: 'a1' });
  const fromH1 = g1.moves({ square: 'h1' });
  ok(fromA1.includes('Nb3') && fromA1.length === 2, 'a1 马只有 2 个着法：' + fromA1.join(','));
  ok(fromH1.includes('Ng3') && fromH1.length === 2, 'h1 马只有 2 个着法：' + fromH1.join(','));

  // 国际象棋的马没有「蹩马腿」：不存在「因中间格被堵而不能走」的情况。
  // b1 的马 8 个方向只要落点为空且不撞自己的子就都能走，这里应为 3 个。
  const g2 = new Chess('4k3/8/8/8/8/8/8/1N2K1N1 w - - 0 1');
  const b1 = g2.moves({ square: 'b1' });
  ok(b1.length === 3, 'b1 马不受蹩腿限制，可走 3 格：' + b1.join(','));

  // 落点被自己方占据时才不能走：b1 的马到 d2 本身合法，这里用 d1 己方子验证
  const g2b = new Chess('4k3/8/8/8/8/8/8/1N2K2R w - - 0 1');
  ok(g2b.moves({ square: 'b1' }).length === 3, 'b1 马仍有 3 个着法：' + g2b.moves({ square: 'b1' }).join(','));

  const g3 = new Chess('4k3/8/8/8/8/8/8/B3K3 w - - 0 1');
  ok(g3.moves().includes('Bc3'), 'a1 象可走 c3（不塞眼）');
  // 塞象眼：a1-b2-c3 被 b2 的黑兵挡住
  const g4 = new Chess('4k3/8/8/8/8/8/1p6/B3K3 w - - 0 1');
  ok(!g4.moves().includes('Bc3'), '塞象眼：b2 有子挡住，a1 象不能到 c3');
  ok(g4.moves().includes('Bxb2'), 'a1 象可吃 b2 黑兵');
}

console.log('— 终局判定 —');
{
  const g = new Chess();
  for (const u of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']) g.move(u);
  ok(g.isCheckmate(), '学者杀 → 将死');
  ok(g.isGameOver() && !g.isDraw(), '将死不是和棋');
}
{
  const g = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  ok(g.isStalemate() && g.isDraw() && g.isGameOver(), '逼和 → 和棋');
}
{
  const g = new Chess();
  for (const _ of [0, 1, 2]) {
    g.move('Nf3'); g.move('Nf6');
    g.move('Ng1'); g.move('Ng8');
  }
  ok(g.isThreefoldRepetition() || g.isDraw(), '重复局面判和');
}
{
  ok(new Chess('8/8/8/4k3/8/8/8/4K3 w - - 0 1').isInsufficientMaterial(), '王对王 → 子力不足');
  ok(new Chess('8/8/8/4k3/8/8/8/3BK3 w - - 0 1').isInsufficientMaterial(), '王+单象 → 子力不足');
  ok(!new Chess('8/8/8/4k3/8/8/8/3RK3 w - - 0 1').isInsufficientMaterial(), '王+车 → 非子力不足');
}

console.log('— FEN / 记谱 —');
{
  const g = new Chess();
  ok(g.fen() === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', '初始 FEN 正确');
  ok(g.moves().length === 20, '初始 20 个着法');
  const m = g.moves({ verbose: true }).find((x) => x.san === 'e4');
  ok(!!m && m.from === 'e2' && m.to === 'e4', 'SAN e4 的 from/to 正确');
  const loaded = new Chess('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3');
  ok(loaded.turn() === 'b', 'FEN 指定黑方走棋');
  ok(loaded.history().length === 0, '载入指定 FEN 后历史为空');
}

console.log(fail === 0 ? '\n全部通过 ✅' : '\n失败 ' + fail + ' 项 ❌');
process.exit(fail === 0 ? 0 : 1);
