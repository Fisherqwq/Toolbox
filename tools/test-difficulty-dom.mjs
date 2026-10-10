/**
 * 自定义难度面板的交互仿真（不依赖 jsdom —— 本项目刻意零依赖）。
 *
 * 覆盖静态断言够不到的那半边：锁定到底会不会把模式按钮和输入框一起锁上，
 * 以及越界输入时界面显示什么。跑的是 **js/chess.js 的真源函数**，不是复刻逻辑。
 *
 * 注意：改这个文件只用编辑工具或 Python（显式 utf-8）。
 * PowerShell 的 Get-Content -Raw 会按 GBK 解码，把中文和引号吃掉。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const chessSrc = readFileSync(join(ROOT, 'js/chess.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => c
  ? (console.log('  OK   ' + n), pass++)
  : (console.log('  FAIL ' + n + (x ? '  -> ' + x : '')), fail++);

/* ---------- minimal DOM stub ---------- */
class El {
  constructor(id, cls) {
    this.id = id; this.dataset = {};
    this.disabled = false; this.textContent = '';
    // 真实 DOM 里 input.value 是 DOMString，赋数字会被强制转成字符串。
    // stub 必须照做，否则 `value === '60000'` 这种断言会假失败。
    this._value = '';
    this._cls = new Set(String(cls || '').split(/\s+/).filter(Boolean));
    this.children = [];
  }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  // classList 用方法而不是字段：字段初始化早于构造体赋值 this._cls，
  // 会把 _cls 捕获成 undefined，导致 querySelectorAll 一个都选不到（实测过）。
  get classList() {
    const self = this;
    return {
      add: (c) => self._cls.add(c),
      remove: (c) => self._cls.delete(c),
      contains: (c) => self._cls.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !self._cls.has(c) : !!on;
        want ? self._cls.add(c) : self._cls.delete(c);
        return want;
      },
    };
  }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c._cls.has(cls)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}
const registry = {};
const mk = (id, cls) => (registry[id] = new El(id, cls));

const panel = mk('chessCustomDiff', 'chess-diff-custom hidden');
const modeGroup = mk('chessDiffModeGroup', 'chess-diff-modes');
const modeBtns = [mk('m_depth', 'chess-diff-mode active'), mk('m_time', 'chess-diff-mode')];
modeBtns[0].dataset.mode = 'depth'; modeBtns[1].dataset.mode = 'time';
modeGroup.children.push(modeBtns[0], modeBtns[1]);
const rowDepth = new El('rowD', 'chess-diff-row'); rowDepth.dataset.field = 'depth';
const rowTime = new El('rowT', 'chess-diff-row hidden'); rowTime.dataset.field = 'time';
panel.children.push(rowDepth, rowTime);
const inDepth = mk('chessCustomDepth', 'chess-diff-input');
const inTime = mk('chessCustomTime', 'chess-diff-input');
inDepth.value = '12'; inTime.value = '1000';
// 预设按钮必须带 .chess-diff-btn，否则 querySelectorAll 选不到（与 HTML 一致）
const presetBtns = [mk('p_easy', 'chess-diff-btn'), mk('p_normal', 'chess-diff-btn active'),
                    mk('p_hard', 'chess-diff-btn'), mk('p_custom', 'chess-diff-btn')];
['easy', 'normal', 'hard', 'custom'].forEach((p, i) => { presetBtns[i].dataset.preset = p; });
presetBtns[1].classList.add('active');
const group = mk('chessDepthGroup', 'chess-difficulty');
// 注意 thisArg 必须是 group.children：写成 push.apply(group, ...) 会把元素
// push 到 group 自身上，querySelectorAll 遍历 children 就是一个都找不到。
group.children.push.apply(group.children, presetBtns);
const hint = mk('chessDepthHint', 'chess-card-hint');

const $ = (id) => registry[id] || null;

function extract(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('missing fn ' + name);
  const open = src.indexOf('{', s);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}' && --d === 0) return src.slice(s, i + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
const pick = (re) => { const m = chessSrc.match(re); if (!m) throw new Error('no match ' + re); return m[1]; };

const api = new Function('window', `
  const DIFFICULTY = ${pick(/const DIFFICULTY = (\{[\s\S]*?\n  \};?)/)};
  const MOVE_TIME_MS = ${pick(/const MOVE_TIME_MS = (\{[\s\S]*?\n  \};?)/)};
  const CUSTOM = ${pick(/const CUSTOM = (\{[\s\S]*?\n  \};)/)};
  const CUSTOM_LIMITS = ${pick(/const CUSTOM_LIMITS = (\{[\s\S]*?\n  \};)/)};
  let preset = 'normal';
  let gameStarted = false;
  const $ = (id) => window.$(id);
  ${extract(chessSrc, 'currentDepth')}
  ${extract(chessSrc, 'currentMoveTime')}
  ${extract(chessSrc, 'clampCustom')}
  ${extract(chessSrc, 'formatMs')}
  ${extract(chessSrc, 'updateDepthHint')}
  ${extract(chessSrc, 'updateDifficultyLock')}
  ${extract(chessSrc, 'renderCustomPanel')}
  return { renderCustomPanel, updateDifficultyLock, updateDepthHint,
           setStarted: (v) => { gameStarted = v; },
           setMode: (m) => { CUSTOM.mode = m; },
           setTime: (t) => { CUSTOM.timeMs = t; },
           setPreset: (p) => { preset = p; },
           getDepth: currentDepth, getTime: currentMoveTime };
`)({ $ });

/* ---------- initial state: panel collapsed under a preset ---------- */
api.renderCustomPanel(); api.updateDifficultyLock();
ok('initial preset normal -> custom panel hidden', panel.classList.contains('hidden'));
ok('initial hint is Stockfish 深度 8', hint.textContent === 'Stockfish 深度 8', hint.textContent);
ok('initially unlocked', presetBtns.every((b) => !b.disabled));

/* ---------- switch to custom ---------- */
api.setPreset('custom');
presetBtns[3].classList.add('active');
api.renderCustomPanel(); api.updateDifficultyLock();
ok('pick 自定 -> panel expands', !panel.classList.contains('hidden'));
ok('default depth mode -> only depth row visible',
   !rowDepth.classList.contains('hidden') && rowTime.classList.contains('hidden'));
ok('depth hint shows 12', hint.textContent === 'Stockfish 深度 12', hint.textContent);
ok('depth mode button highlighted, time mode not',
   modeBtns[0].classList.contains('active') && !modeBtns[1].classList.contains('active'));

/* ---------- switch to time mode (core requirement) ---------- */
api.setMode('time');
api.renderCustomPanel(); api.updateDifficultyLock();
ok('pick 按时间 -> only time row visible',
   !rowTime.classList.contains('hidden') && rowDepth.classList.contains('hidden'));
ok('time hint shows 1 秒', hint.textContent === 'Stockfish 每步最多 1 秒', hint.textContent);
ok('time mode yields null depth so worker uses movetime', api.getDepth() === null, String(api.getDepth()));
ok('time mode yields movetime 1000', api.getTime() === 1000, String(api.getTime()));

/* ---------- out-of-range input is echoed honestly ---------- */
api.setTime(60000);
inTime.value = '999999';
api.renderCustomPanel();
ok('out-of-range input rewritten to effective 60000', inTime.value === '60000', inTime.value);
ok('out-of-range input marked red', inTime.classList.contains('invalid'));
inTime.value = '60000';
api.renderCustomPanel();
ok('valid value clears red mark', !inTime.classList.contains('invalid'));

/* ---------- locked after first move (core requirement) ---------- */
api.setStarted(true);
api.updateDifficultyLock();
ok('all 4 preset buttons locked', presetBtns.every((b) => b.disabled));
ok('both mode buttons locked', modeBtns.every((b) => b.disabled));
ok('both number inputs locked', inDepth.disabled && inTime.disabled);
ok('hint explains the lock', /开局后锁定/.test(hint.textContent), hint.textContent);
ok('locked hint still shows the real 60 秒', /60 秒/.test(hint.textContent), hint.textContent);
ok('locking does not change effective params (60s / null depth)',
   api.getDepth() === null && api.getTime() === 60000, api.getDepth() + '/' + api.getTime());

/* ---------- new game unlocks ---------- */
api.setStarted(false);
api.updateDifficultyLock();
ok('new game unlocks everything', presetBtns.every((b) => !b.disabled)
   && modeBtns.every((b) => !b.disabled) && !inDepth.disabled && !inTime.disabled);
ok('lock note disappears after unlock', !/开局后锁定/.test(hint.textContent), hint.textContent);

/* ---------- back to a preset: panel hides but custom values persist ---------- */
api.setPreset('hard');
api.renderCustomPanel(); api.updateDifficultyLock();
ok('back to hard -> panel hides', panel.classList.contains('hidden'));
ok('back to hard -> hint is 深度 14', hint.textContent === 'Stockfish 深度 14', hint.textContent);
api.setPreset('custom');
api.renderCustomPanel(); api.updateDifficultyLock();
ok('returning to custom keeps time mode and 60000',
   api.getDepth() === null && api.getTime() === 60000, api.getDepth() + '/' + api.getTime());

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
