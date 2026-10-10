# 项目上下文交接摘要

> 记录**不能从代码里读出来的东西**——踩过的坑、被证伪的结论、可复用资产。
> 接手新会话/新项目时先读这里，再读 `README.md`（技术参考）。

生成时间：2026-10-01 · 对应交接包 `D:\toolbox-handover-20261001-200753.zip`

---

## 一、项目现状速览

**是什么**：纯静态、本地运行的网页工具箱（国际象棋 + 五子棋 + 加密工具）。
无后端、无账号、无上传，所有计算在浏览器内完成。

**路由**：`#/` 首页 · `#/chess` 国际象棋 · `#/gomoku` 五子棋 · `#/crypto` 加密 · `#/xiangqi` 占位页

**规模**：44 个文件 / 2.31 MB（含 Stockfish 模型）

**测试**：`node js/chess-engine/test.mjs` → 49 项断言，含 4 组 perft 标准局面

**状态**：可玩。引擎能跑、点击区域正确、翻转正常、棋子正常。

---

## 二、Stockfish 接入 —— 最贵的知识（改引擎前必读）

这条链路**反复返工 4 次**，每轮都是「看起来对但浏览器里跑不通」。
下面每条约束都有对应的**症状**，不是理论推导。

| # | 约束 | 违反后的症状 |
|---|---|---|
| 1 | **不要加 `#stockfish.wasm,worker` 后缀** | worker 加载成功、无 `onerror`、但**一个字节都不输出**，`uciok` 永不回来 |
| 2 | **就绪判据是 `uciok`，不是 `readyok`** | 探测/握手/徽标全绿，但 **AI 永远不走子**（队列永远滞留） |
| 3 | **绝对不要发 `setoption`** | 引擎彻底沉默，连一条 `info` 都不吐，但徽标/握手全显示正常 |
| 4 | **`go depth` 优先于 `go movetime`** | 每步硬等满时长（8 秒），看起来像卡死 |
| 5 | **必须是经典 Worker**，不能 `{type:'module'}` | 引擎无响应（依赖 `importScripts`） |
| 6 | **启动时要有界重发 `uci`** | 偶发等不到 `uciok` |

**原因**：

1. 引擎有 `self.location.hash.split(',')[1]==='worker'` 的判断，命中它会走进一条**早期特殊分支**，在浏览器里是死路。不带 hash 时该判断落空，引擎转而用 `typeof importScripts==='function'` 正常识别 Worker 环境。
2. `uciok` 一到就 `flush()` 放出排队的 `position`/`go`；等 `readyok` 会因时序把状态机卡死。
3. 该构建处理 `Threads` 会**重建线程池**，而它是单线程 wasm（`Threads max 1`），在无 pthread 环境会把引擎打挂。且默认值本就是 `Threads=1`/`Hash=16`，本来没必要发。
4. `movetime` 是**时间上限不是目标**，Stockfish 会用满才停；两者同给时 movetime 盖掉 depth。
6. 该构建启动函数跑在 `onmessage` 赋值**之前**，立刻发的 `uci` 可能被丢弃。当前每 0.9s 重发，最多 8 次，拿到 `uciok` 立即停。

**不需要的**：COOP/COEP 响应头（单线程版没用 `SharedArrayBuffer`）；外部 `.nnue`（权重已内嵌进 wasm）。

**排查手法**（务必掌握）：

```js
const w = new Worker('/js/lib/stockfish.js');   // 注意：不带 hash
w.onmessage = e => console.log('<<', String(e.data).slice(0, 70));
w.onerror = e => console.log('ERR', e.message, e.filename, e.lineno);
w.postMessage('uci');
setTimeout(() => { w.postMessage('position startpos'); w.postMessage('go depth 8'); }, 3000);
```

`chess-worker.js` 顶部 `const DBG = true` 会打印 `[sf]` 前缀的**每一条收发命令**和
**每一个静默丢弃分支**（标 `!!`）。这是定位问题的关键，别急着关掉。

> ⚠ 项目原 README 曾写「hash 后缀是必需的」——**这条是错的**，已被 A/B 实测推翻。
---

## 三、本次修复的 bug 清单

### 3.1 棋盘交互（5 个，全是真 bug）

| 问题 | 根因 | 修法 |
|---|---|---|
| 点击区域比棋盘少一格 | `eventToSquare` 把格子**左边缘**当中心（`Math.round` + 用 `cellX()` 做中心校验），每格只有左半边可点，最右列完全点不到 | `Math.floor` + 格子中心 +- 半格容差 |
| 棋盘上下颠倒 | `cellY(rank)` 让 rank 1 画在顶部 | 新增 `boardToScreen()` |
| 翻转棋盘完全失效 | `render()` 直接拿棋盘坐标当屏幕坐标，从不调用变换函数，棋子不动但点击映射翻了 | 5 处渲染点全部走 `cellOf()` |
| 坐标标签错位 | 标签画在格子左上角 | 对齐到格子中心 |
| 外框少一格 | `strokeRect(..., CELL*(SQ-1))` | 改成 `CELL*SQ` |

**验证方法**：两种朝向 x 64 格，断言渲染位置与命中检测**逐格一致**。
坐标类 bug 必须这样验证，肉眼看不出半格误差。

### 3.2 引擎链路（8 个）

握手顺序、`movetime` 优先级、`HEAD` 探测误判（服务器对 HEAD 返回 405 就误判「未下载」）、
半装状态（只有 js 没有 wasm 探测不出来）、空 `bestmove` 被误判为终局（**会污染 localStorage
里的永久战绩**）、引擎非法着法导致对局卡死、`badgeLoading` 与 `badgeWarn` 混用导致徽标永不转绿。

> 徽标那个值得单独记：`showEngineBadge('正在加载…', true)` 里的 `warn=true`，
> 和「真出错」的 `warn=true` 是同一个值，导致 `ready` 到来时判成出错。
> 修法是加 `badgeLoading` 标志**区分加载态与错误态**，而不是复用同一个布尔。

### 3.3 规则引擎：没发现问题

吃路兵专项测了 7 项**全部正确**，包括最难的「两兵同离一横线暴露己方王」
（`e5xd6` 被正确判为非法，而 `e5e6` 仍可用）。chess.js 规则层可信，**不要重写**。

### 3.4 顺手修的 + 测试教训

- 五子棋难度按钮失效：`gomoku.js` 查 `.diff-btn`，HTML 里是 `.gomoku-diff-btn`，
  选择器匹配不到任何元素
- **吃路兵测试我写错过 3 次**（不是代码 bug）：车放错位置导致王本就被将军、
  过路兵目标格摆反被引擎拒、黑兵放 c5 而非 c4 吃不到第 3 横线。
  教训：**构造局面优先用走子序列，不要手写 FEN**（chess.js 的 FEN 校验很严且易踩）

### 3.5 自定义难度（新增，**有一处尚未浏览器实测**）

难度加了第四档「自定」：手填搜索深度（1–40）或每步思考时间（100–60000ms），二选一。
锁定逻辑从「只锁预设按钮」扩到「预设 + 模式切换 + 两个输入框全锁」。

**已验证**（`node tools/test-difficulty.mjs` 73 项 + `tools/test-difficulty-dom.mjs`
25 项，两套都直接跑 `js/chess.js` / `js/chess-worker.js` 的**真源**函数）：
夹取边界、空值回落、锁定/解锁、看门狗预算、UI 发出的 UCI 命令对不对。

**⚠ 尚未验证，要开浏览器跑一次**：

1. **`go movetime 100` 这个下限是否真的安全。** 代码注释写的「低于 100ms 会交出
   `bestmove 0000`」是**推断**，没有实测数据。真引擎在 100ms 下能否交出合法着法，
   必须实测。若会交 0000，得把下限提到 500ms 左右 —— 否则玩家填了合法值
   却收到「引擎未返回着法」。
2. **「按时间」模式的实际等待时长。** `movetime` 是上限不是目标，
   预期接近设定值，但没量过。

**为什么没在 Node 里验**：试过用 `worker_threads` 加载 `js/lib/stockfish.js`，
引擎连 `uciok` 都不回 —— Emscripten 构建要的是真浏览器 Worker 环境
（就是第二节第 5 条那个约束）。**别再用 Node 模拟引擎**，那条路走不通；
要验就开页面看控制台的 `[sf]` 日志。

**顺手记一个测试自身的坑**：DOM stub 里 `classList` 别写成 class field。
字段初始化早于构造体给 `this._cls` 赋值，`querySelectorAll` 会一个都选不到，
症状是「锁定断言失败」，极易误判成产品 bug。

---

## 四、设计系统（可直接复用）

### 4.1 配色令牌

```css
--paper: #eaf2f9;   --paper-deep: #dde9f4;
--ink: #0f2c45;     --ink-soft: #4a6a83;   --ink-faint: #8aa3b8;
--sky: #2f7fbf;     --sky-deep: #1c5c92;   --sky-pale: #cfe4f5;
--amber: #d9873f;   /* 唯一暖色，点缀用 */
--rule: #b9d3e8;    --white: #fbfdff;
```

**零紫零靛蓝**（明确禁止紫/靛蓝/蓝紫渐变）。浅蓝纸感底色靠蓝灰分层而非纯白；
暖色只少量点缀，避免整页发蓝。

### 4.2 字体与动效

- **Instrument Serif**（标题，编辑感、反 SaaS）、**Space Grotesk**（正文）、
  **JetBrains Mono**（数字/标签）
- 三条回弹曲线，**禁止 `ease`**：
  `--snap: cubic-bezier(.22,1.4,.36,1)`、`--drift: cubic-bezier(.65,.02,.28,1)`、
  `--swing: cubic-bezier(.34,1.32,.48,1)`
- 背景：34px 蓝图网格 + 两团错位径向光晕，`background-attachment: fixed`

### 4.3 布局模式（刻意反模板）

- **非对称栅格**：`1.25fr/.85fr`、`1.45fr/1fr`，卡片可跨行
  拒绝 Hero+三卡片、拒绝完美居中、拒绝等宽多栏
- **直角 2px + 错位硬阴影**（`translate(-3px,-3px)` 配 offset box-shadow），不用 22px 圆角药丸
- 配图**轻微旋转**（1.1 度）打破对齐感；章节用「编号+标题+细分隔线」代替彩色左边框

### 4.4 图标与图片

- **Iconify**：`<iconify-icon icon="mdi:xxx">`。
  图标名要先对 `https://api.iconify.design/<集合>/<名称>.svg` 验证存在再用
- **Picsum** 配固定 seed（`picsum.photos/seed/xxx/W/H`），带 `loading="lazy"`
- 两者都要有降级方案（图片失败回退到字符/占位，别让版面开天窗）

---

## 五、工作方法教训（最重要的一节）

本次引擎接入返工 4 轮，**根因全是同一个**：

> **在没有浏览器的情况下，基于推断改代码。**

具体的四个错误：

1. 删掉 `stockfish.wasm`，依据是对二进制内容的误读
   （把 Emscripten 兜底分支的 `"use asm"` 当成了主路径）
2. 把搜索深度从 4/8/14 砍到 2/4/6，**拿功能换时间，方向完全错**：
   超时说明引擎根本没跑起来，不是跑得慢
3. 乱发 `isready`，违反 UCI 协议（必须在 `uciok` 之后）
4. 加回坏 hash，照着项目 README 的错误说明改

### 由此得到的硬性做法

- **先埋日志，再动手**。在 worker 里打印每一条收发命令和每一个静默 `break` 分支
  （标 `!!`），让程序自己说话。埋完日志**一次定位**，而之前四次全靠猜。
- **不信任继承来的文档**。项目 README 说「hash 是必需的」，A/B 实测证明恰好相反。
- **超时 != 慢**。先确认「命令到底有没有送达引擎」，再谈性能。
- **不隐藏问题**。引擎空着法、非法着法这类情况要显式报错交回玩家，
  而不是把局面判成终局（那会污染永久战绩数据）。
- **不删第三方资源**。除非确认引用关系，否则先备份。
- **绝不用 PowerShell 的 `Set-Content` 改 UTF-8 文件**。实测它把 `js/gomoku.js` 吃掉
  12 个字符、合并多行、语法直接崩。改文件用编辑工具，
  或 Python 显式 `encoding="utf-8", newline="\n"`。

---

## 六、用户偏好

- **用中文交流**
- **反 SaaS 模板美学**，明确禁止：紫/靛蓝/蓝紫渐变、纯平背景、Hero+三卡片、
  完美居中、等宽多栏、shadcn/Material 默认样式、emoji 图标、线性缓动、空话文案、
  被动语态长句
- 文案要求：**口语化、有数字、有场景**
- 图标用 Iconify，图片用 Pexels/Picsum
- **要证据不要结论**，他会自己跑控制台验证。所以「实测通过」和「推测可行」
  必须说清楚区别。

---

## 七、可复用到新项目的资产

| 资产 | 路径 | 许可 | 说明 |
|---|---|---|---|
| 国际象棋规则引擎 | `js/chess-engine/` | BSD-2-Clause | 含 49 项断言的回归测试 |
| 五子棋引擎 | `js/gomoku-engine/` | 项目自有 | 纯 JS 模块，带置换表 |
| 棋子 SVG x12 | `img/chess/` | **CC BY-SA 3.0** | cburnett，chess.com 同款，注意 share-alike |
| 开局库 | `js/chess-book.js` | CC0 数据 | `node tools/build-chess-book.mjs` 可重新生成 |
| 设计令牌 | `css/style.css` 的 `:root` | 无 | 直接复制第四节变量 |
| UCI worker 模式 | `js/chess-worker.js` | 无 | 队列 + flush + uciok 就绪 + 断点日志，可套用任何 UCI 引擎 |
| 徽标状态机 | `js/chess.js` | 无 | 加载态与错误态分离的写法 |

---

## 八、下一项目开工前的检查清单

- [ ] 本地能跑：`python3 -m http.server 8000`
      （**不要用 `file://`**，Worker / WASM / fetch 全部失效）
- [ ] 语法与测试：`node --check <每个 js>`、`node js/chess-engine/test.mjs`
- [ ] **确认有浏览器可验证**，否则先按第五节埋日志，别靠猜
- [ ] `.gitignore` 已排除 `js/lib/stockfish.*`，**换机器时要单独拷模型文件**
- [ ] 对外分发前补 cburnett 署名（CC BY-SA）与 Stockfish 源码（GPLv3）
