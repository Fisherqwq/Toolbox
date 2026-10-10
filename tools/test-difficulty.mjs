/**
 * 自定义难度回归测试 —— 验证「深度 or 时间」这条链路。
 *
 * 关键约束（HANDOFF-CONTEXT.md 第二节第 4 条）：
 *   worker 的 go 分支是 depth 优先，depth 为空才看 movetime。
 * 所以「按时间」必须传 depth: null，绝不能两个都给，否则 movetime 被静默吃掉。
 *
 * 这里**直接读并执行 js/chess.js 的真源**，而不是把逻辑抄一份重测 ——
 * 抄的那份和实际跑的那份迟早分叉，分叉后测试全绿而功能是坏的，比没测试更糟。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { console.log('  OK   ' + name); pass++; }
  else { console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); fail++; }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected),
     `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function group(title) { console.log('— ' + title + ' —'); }

/** 从真源里抠出某个函数的完整源码（大括号配平） */
function extract(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('真源里找不到函数 ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 的大括号没配平');
}

/* ============ 1. 抠出 chess.js 里的难度逻辑并执行 ============ */
const chessSrc = readFileSync(join(ROOT, 'js/chess.js'), 'utf8');

const pick = (re) => {
  const m = chessSrc.match(re);
  if (!m) throw new Error('正则没匹配到: ' + re);
  return m[1];
};

const harness = `
  const DIFFICULTY = ${pick(/const DIFFICULTY = (\{[\s\S]*?\n  \};?)/)};
  const MOVE_TIME_MS = ${pick(/const MOVE_TIME_MS = (\{[\s\S]*?\n  \};?)/)};
  const CUSTOM = ${pick(/const CUSTOM = (\{[\s\S]*?\n  \};)/)};
  const CUSTOM_LIMITS = ${pick(/const CUSTOM_LIMITS = (\{[\s\S]*?\n  \};)/)};
  let preset = 'normal';
  ${extract(chessSrc, 'currentDepth')}
  ${extract(chessSrc, 'currentMoveTime')}
  ${extract(chessSrc, 'clampCustom')}
  ${extract(chessSrc, 'formatMs')}
  return { currentDepth, currentMoveTime, clampCustom, formatMs,
           get preset() { return preset; }, set preset(v) { preset = v; },
           get CUSTOM() { return CUSTOM; },
           setMode(m) { CUSTOM.mode = m; }, setDepth(d) { CUSTOM.depth = d; },
           setTime(t) { CUSTOM.timeMs = t; } };
`;
const api = new Function(harness)();

/* ============ 2. 夹取边界 ============ */
group('自定义数值夹取（clampCustom）');
eq('深度 12 原样保留', api.clampCustom('depth', '12'), 12);
eq('深度 999 夹到上限 40', api.clampCustom('depth', '999'), 40);
eq('深度 0 夹到下限 1', api.clampCustom('depth', '0'), 1);
eq('深度 -5 夹到下限 1', api.clampCustom('depth', '-5'), 1);
eq('深度小数 12.6 取整 13', api.clampCustom('depth', '12.6'), 13);
eq('时间 60000 允许满值', api.clampCustom('timeMs', '60000'), 60000);
eq('时间 10 夹到下限 100', api.clampCustom('timeMs', '10'), 100);
eq('时间 999999 夹到 60000', api.clampCustom('timeMs', '999999'), 60000);
// 空值/垃圾值必须回落到「当前值」，绝不能变成 0：
// movetime 0 会让引擎直接交 bestmove 0000，主线程只能报「未返回着法」。
api.setTime(1500);
eq('空字符串回落原值而非 0', api.clampCustom('timeMs', ''), 1500);
eq('非数字回落原值而非 0', api.clampCustom('timeMs', 'abc'), 1500);
api.setDepth(12);
eq('空字符串回落原深度', api.clampCustom('depth', ''), 12);
ok('兜底值恒 > 0（不产生 0ms / 0 层）', api.clampCustom('timeMs', 'x') > 0);
// 清空输入框不能把难度静默改成最弱（Number('') === 0 且 isFinite(0) === true 的坑）
eq('null 也回落而非夹到下限', api.clampCustom('depth', null), 12);
eq('undefined 也回落', api.clampCustom('timeMs', undefined), 1500);

/* ============ 3. 预设档位没被改坏 ============ */
group('预设档位（回归）');
api.preset = 'easy';   eq('简单 → 深度 4', api.currentDepth(), 4);
api.preset = 'normal'; eq('中等 → 深度 8', api.currentDepth(), 8);
eq('中等 movetime 仍为 8000', api.currentMoveTime(), 8000);
api.preset = 'hard';   eq('困难 → 深度 14', api.currentDepth(), 14);
eq('困难 movetime 仍为 20000', api.currentMoveTime(), 20000);
api.preset = 'easy';   eq('简单 movetime 仍为 2000', api.currentMoveTime(), 2000);
api.preset = 'nonsense';
eq('未知档位回落中等 8', api.currentDepth(), 8);

/* ============ 4. 自定义：深度模式 ============ */
group('自定义 · 按深度');
api.preset = 'custom';
api.setMode('depth');
api.setDepth(20);
eq('发 depth 20', api.currentDepth(), 20);
ok('同时仍给 movetime 兜底', api.currentMoveTime() > 0);
ok('兜底覆盖深度所需（深度 20 → >= 20s）', api.currentMoveTime() >= 20000,
   '实际 ' + api.currentMoveTime());
api.setDepth(1);
ok('深度 1 的兜底时间仍有下限 2s', api.currentMoveTime() >= 2000, '实际 ' + api.currentMoveTime());

/* ============ 5. 自定义：时间模式（本次需求核心） ============ */
group('自定义 · 按时间');
api.setMode('time');
api.setTime(3000);
eq('时间模式 depth 必须是 null（否则 worker 优先走 go depth）', api.currentDepth(), null);
eq('时间模式 movetime = 玩家填的 3000', api.currentMoveTime(), 3000);
api.setTime(60000);
eq('最大 60 秒原样生效', api.currentMoveTime(), 60000);
eq('60 秒时 depth 依然为 null', api.currentDepth(), null);
api.setTime(100);
eq('最小 100ms 原样生效', api.currentMoveTime(), 100);

/* ============ 6. 毫秒文案 ============ */
group('提示文案');
eq('1500ms → 1.5 秒', api.formatMs(1500), '1.5 秒');
eq('1000ms → 1 秒', api.formatMs(1000), '1 秒');
eq('60000ms → 60 秒', api.formatMs(60000), '60 秒');

/* ============ 7. 看门狗必须长于玩家设的时间 ============ */
group('思考看门狗预算');
const watchdog = (moveTime) => Math.max(60000, moveTime * 2 + 10000);
ok('预设 8000ms → 60 秒看门狗', watchdog(8000) === 60000);
ok('玩家设 60 秒 → 看门狗 130 秒，不误杀合法搜索',
   watchdog(60000) === 130000, '实际 ' + watchdog(60000));
ok('看门狗恒大于 movetime', [2000, 8000, 20000, 60000].every((m) => watchdog(m) > m));
// 真源里看门狗确实用的是算出来的 budget，而不是写死 60000
ok('真源存在 budget 计算', !!chessSrc.match(/const budget = ([^;]+);/));
ok('真源 setTimeout 用的是 budget（不是写死 60000）', /\}, budget\);/.test(chessSrc));
ok('真源已无写死的 }, 60000);', !/\}, 60000\);/.test(chessSrc));

/* ============ 8. worker 真源：depth 为空必须落到 go movetime ============ */
group('chess-worker.js 的 go 分支（对真源求值）');
const workerSrc = readFileSync(join(ROOT, 'js/chess-worker.js'), 'utf8');
// 抠出 case 'go' 整段，按真源原样包进 switch 执行 —— 不重写判定顺序，
// 因为「depth 优先于 movetime」正是本测试要守住的约束，抄一遍就等于没测。
const goBranch = workerSrc.slice(
  workerSrc.indexOf("case 'go': {"),
  workerSrc.indexOf("case 'stop':"));
const goFn = new Function('data', `
  const queue = [];
  const dlog = () => {};
  // worker 里 flush 会把队列发给引擎；这里 uciReady=true，等价于立即放行，
  // 所以 flush 的效果就是「队列留着给我们断言」。
  const flush = () => {};
  let currentGen = 1, mode = 'stockfish', uciReady = true;
  let seenInfo = false;
  switch ('go') {
${goBranch}
  }
  return queue;
`);
ok('worker 真源里 depth 判定仍在 movetime 之前',
   workerSrc.indexOf("queue.push('go depth ' + data.depth)")
   < workerSrc.indexOf("queue.push('go movetime ' + data.movetime)"));

api.preset = 'custom'; api.setMode('depth'); api.setDepth(18);
const a = goFn({ gen: 1, depth: api.currentDepth(), movetime: api.currentMoveTime() });
ok('自定义深度 18 → 含 go depth 18',
   a.some((c) => c === 'go depth 18'), JSON.stringify(a));
ok('深度模式下不发 go movetime（否则参数语义混乱）',
   !a.some((c) => c.startsWith('go movetime')), JSON.stringify(a));

api.setMode('time'); api.setTime(2500);
const b = goFn({ gen: 1, depth: api.currentDepth(), movetime: api.currentMoveTime() });
ok('自定义 2500ms → 含 go movetime 2500',
   b.some((c) => c === 'go movetime 2500'), JSON.stringify(b));
ok('时间模式下绝不发 go depth（这就是本次要验证的坑）',
   !b.some((c) => c.startsWith('go depth')), JSON.stringify(b));

api.preset = 'hard';
const c = goFn({ gen: 1, depth: api.currentDepth(), movetime: api.currentMoveTime() });
ok('困难档仍是 go depth 14', c.some((x) => x === 'go depth 14'), JSON.stringify(c));

// 边界：depth 必须是「假值」而不是某个真数字。0 与 null 同义（都会落 movetime），
// 真正的坑是填成 1 / 4 这种真值 —— movetime 会被静默吃掉。
for (const falsy of [null, 0, undefined]) {
  const r = goFn({ gen: 1, depth: falsy, movetime: 2500 });
  ok(`depth=${JSON.stringify(falsy)} → 正确落到 go movetime 2500`,
     r.includes('go movetime 2500') && !r.some((x) => x.startsWith('go depth')),
     JSON.stringify(r));
}
const truthy = goFn({ gen: 1, depth: 1, movetime: 2500 });
ok('反证：depth=1（真值）会让 movetime 被静默吃掉 —— 这是要防的坑',
   truthy.includes('go depth 1') && !truthy.includes('go movetime 2500'),
   JSON.stringify(truthy));

/* ============ 9. 锁定后无法改难度 ============ */
group('开局后锁定');
ok('锁定判定用 gameStarted', /const lock = gameStarted;/.test(chessSrc));
ok('不看 history（否则一路悔棋回原点会把难度误解锁）',
   !/const lock = history/.test(chessSrc));
ok('锁定禁用模式切换按钮',
   /chessDiffModeGroup[\s\S]{0,140}chess-diff-mode/.test(chessSrc));
ok('锁定禁用两个输入框', /'chessCustomDepth', 'chessCustomTime'/.test(chessSrc));
ok('锁定文案由 updateDepthHint 统一拼',
   /gameStarted \? base \+ ' · 开局后锁定/.test(chessSrc));
ok('旧的 dataset.base 方案已移除（会与自定义值不同步）',
   !/dataset\.base/.test(chessSrc));
ok('预设点击挡 disabled', /if \(!btn \|\| btn\.disabled\) return;/.test(chessSrc));
ok('走出第一步即上锁', /if \(!gameStarted\) \{ gameStarted = true; updateDifficultyLock\(\); \}/.test(chessSrc));
ok('新对局解锁', /gameStarted = false;/.test(chessSrc));
ok('预设入口调 renderCustomPanel', /preset = btn\.dataset\.preset;\s*\n\s*renderCustomPanel\(\);/.test(chessSrc));
ok('模式入口调 renderCustomPanel', /CUSTOM\.mode = [^;]+;\s*\n\s*renderCustomPanel\(\);/.test(chessSrc));
ok('输入入口调 renderCustomPanel',
   /CUSTOM\[field\] = clampCustom\(field, input\.value\);\s*\n\s*renderCustomPanel\(\);/.test(chessSrc));

/* ============ 10. HTML / CSS 契约 ============ */
group('HTML 与 CSS 契约');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'css/style.css'), 'utf8');
ok('存在自定义预设按钮', /data-preset="custom"/.test(html));
ok('存在模式切换组', /id="chessDiffModeGroup"/.test(html));
ok('深度输入框上限 40', /id="chessCustomDepth"[\s\S]{0,160}?max="40"/.test(html));
ok('时间输入框上限 60000', /id="chessCustomTime"[\s\S]{0,160}?max="60000"/.test(html));
ok('自定义面板默认 hidden', /class="chess-diff-custom hidden" id="chessCustomDiff"/.test(html));
ok('非当前模式那一行默认 hidden',
   /class="chess-diff-row hidden" data-field="time"/.test(html));
ok('CSS: .chess-diff-custom.hidden', /\.chess-diff-custom\.hidden/.test(css));
ok('CSS: .chess-diff-row.hidden', /\.chess-diff-row\.hidden/.test(css));
ok('CSS: 输入框禁用态', /\.chess-diff-input:disabled/.test(css));
ok('CSS: 模式按钮禁用态', /\.chess-diff-mode:disabled/.test(css));
ok('CSS: 越界标红', /\.chess-diff-input\.invalid/.test(css));
ok('JS 用到的 id 在 HTML 里都存在',
   ['chessCustomDiff', 'chessDiffModeGroup', 'chessCustomDepth', 'chessCustomTime']
     .every((id) => html.includes('id="' + id + '"')));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
