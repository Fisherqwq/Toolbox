# Toolbox · 棋 · 密 · 工具箱

纯静态、本地运行的棋类与加密工具箱。所有计算都在浏览器里完成，不上传任何数据。
纯AI制作

## 快速开始

**必须通过 HTTP 服务访问**，直接双击 `index.html`（`file://` 协议）会导致
Web Worker、WebAssembly、`fetch` 探测全部失效。

```bash
cd Toolbox-main
python3 -m http.server 8000
# 然后浏览器打开 http://127.0.0.1:8000
```

任何静态服务器都可以，例如 `npx serve`、`php -S localhost:8000`。

## 功能

| 工具 | 路由 | 状态 |
| --- | --- | --- |
| 国际象棋 | `#/chess` | ✅ 可对弈 |
| 五子棋 | `#/gomoku` | ✅ 可对弈 |
| 中国象棋 | `#/xiangqi` | ✅ 可对弈（godogpaw 本地引擎，可离线） |
| 加密工具箱 | `#/crypto` | ✅ AES-GCM / Base64 / SHA-256 / SHA-512 |

## 目录结构

```
Toolbox-main/
├── index.html              页面骨架：所有视图的 HTML
├── css/style.css           全站样式（CSS 变量 + 各工具的独立前缀）
├── sw.js                   Service Worker：预缓存整站（含引擎 wasm），断网可用
├── vendor/                 自托管字体与图标（不再依赖 Google Fonts / Iconify CDN）
└── js/
    ├── main.js             hash 路由 + 加密工具的事件绑定
    ├── sw-register.js      Service Worker 注册 + 新版本提示条
    ├── fingerprint.js      设备指纹
    ├── lucky.js            今日幸运值
    ├── crypto-tools.js     AES / Base64 / SHA
    ├── gomoku.js           五子棋界面与对局
    ├── gomoku-worker.js    五子棋引擎 Worker（ES module）
    ├── gomoku-engine/      五子棋引擎（手写 JS 模块）
    │
    ├── chess.js            国际象棋界面与对局
    ├── chess-bridge.js     把 ESM 的 chess.js 挂到 window（供经典脚本用）
    ├── chess-worker.js     Stockfish 后端（经典 Worker，走 UCI）
    ├── chess-book.js       开局库（自动生成，见 tools/build-chess-book.mjs）
    ├── chess-engine/       国际象棋规则（chess.js）与兼底引擎
    │
    ├── xiangqi.js          中国象棋界面与对局（规则全在引擎里）
    ├── lib/godogpaw/       中国象棋引擎 godogpaw（Go/WASM）+ 桥接层
    └── lib/                Stockfish 可执行文件（不入库，见 js/lib/README.md）
tools/
    ├── build-chess-book.mjs      重新生成开局库（Node 脚本）
    ├── build-vendor-assets.mjs   重新生成 vendor/ 的字体与图标
    ├── check-xiangqi-page.mjs    中国象棋静态检查（34 项）
    ├── test-xiangqi.mjs          中国象棋引擎与桥接层回归（49 项）
    └── test-xiangqi-browser.mjs  中国象棋浏览器端到端（27 项，需 Chrome/Edge）
```

样式命名按工具分前缀：`.gomoku-*`、`.chess-*`、`.crypto-*`、`.game-*`。
新增工具请沿用各自前缀，不要改动其它工具的规则。

## 国际象棋

### 棋盘规则

规则由 **[chess.js](https://github.com/jhlywa/chess.js) v1.4.0** 提供
（BSD-2-Clause），已内置在 `js/chess-engine/chess.js`，无需联网。

覆盖：走子生成、王车易位、吃过路兵、兵升变、将军 / 将死 / 逼和判定、
50 回合规则、三次重复局面、子力不足判定、FEN 与 SAN 记谱。

正确性用 **perft**（国际象棋引擎的黄金标准测试）验证过：

```bash
node js/chess-engine/test.mjs
```

该脚本包含 4 组 perft 标准局面（初始局面、Kiwipete、Position3/4）以及
终局判定、FEN、兼底引擎等共 **49 项断言**，全部通过。

难度相关的另外两套（同样直接跑 `js/chess.js` / `js/chess-worker.js` 的**真源**
函数，而不是复刻一份逻辑——复刻的那份迟早和实际跑的那份分叉）：

```bash
node tools/test-difficulty.mjs      # 73 项：夹取边界、depth/movetime 映射、watchdog、HTML/CSS 契约
node tools/test-difficulty-dom.mjs  # 25 项：面板显隐、锁定/解锁、越界回显（零依赖 DOM stub）
```

### AI 引擎

引擎是 **Stockfish.js v19.0.0 `lite-single`**（单线程 lite 版），两个文件：

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `js/lib/stockfish.js` | 21 KB | 引擎胶水脚本 |
| `js/lib/stockfish.wasm` | 1.7 MB | 引擎本体，NNUE 权重已**内嵌**，无需额外 `.nnue` |

几个关键特性（踩过坑之后定下来的，改动前务必读完）：

- ⚠ **不要加 `#stockfish.wasm,worker` 后缀**。引擎源码里确实有
  `self.location.hash.split(',')[1] === 'worker'` 这段判断，但命中它会走进一条
  早期特殊分支，实测在浏览器里彻底卡死：worker 脚本加载成功、无 `onerror`，
  但一个字节都不输出，`uciok` 永不回来。**不带 hash 反而正常** —— 引擎转而用
  `typeof importScripts === 'function'` 识别 Worker 环境。A/B 实测确认。
- ⚠ **启动时有界重发 `uci`**。该构建的启动函数跑在 `onmessage` 赋值**之前**，
  立刻发出的 `uci` 可能被丢弃，所以 `boot()` 里每 0.9s 重发一次，拿到 `uciok` 立即停止。
- **就绪判据是 `uciok`，不是 `readyok`**。`uciok` 一到就 `flush()` 放出排队的
  `position` / `go`；等 `readyok` 会因为时序把状态机卡死（队列永远滞留 → AI 不走子）。
- **不需要 COOP/COEP 响应头**。单线程版没用到 `SharedArrayBuffer`，
  `python -m http.server`、VS Code Live Server 直接就能跑。只有多线程版才需要那两个头。
- **必须是经典 Worker**，不能 `{ type: 'module' }`：引擎依赖 `importScripts`，而 module worker 没有这个函数。
- **`go depth` 优先于 `go movetime`**。`movetime` 是时间上限不是目标，Stockfish 会用满才停；
  深度 8 只要 0.3 秒而 `movetime 8000` 会让每步硬等 8 秒。`movetime` 仅作慢机器兜底。

页面启动时会 `HEAD` 探测 `js/lib/stockfish.js`（拿不准时用 `GET` 复核，
避免服务器对 `HEAD` 返回 405 造成误判）：

| 探测结果 | 表现 |
| --- | --- |
| 文件存在 | 侧栏显示「已加载 · Stockfish」，可选深度 4/8/14 |
| 文件不存在 | 侧栏显示「缺少 Stockfish 引擎」并弹出下载面板，**无法对弈** |

简易引擎已删除：棋力太弱，且曾因未同步局面导致 AI 走出非法着法。
现在没有 Stockfish 就没有对手，页面会明确报错并给出下载入口，不做静默降级。

**换引擎**：把上游构建的 `stockfish.js` + `stockfish.wasm` 一起放进 `js/lib/` 即可，
页面代码无需改动（只要沿用「**不要**加 hash 后缀 + 就绪判据是 `uciok`」这两条约定）。

### 想换多线程版？

多线程 Stockfish.wasm 走 `SharedArrayBuffer`，浏览器只在**跨源隔离**状态下开放它，
所以服务器必须返回这两个响应头：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

代价是：开了 COEP 之后所有跨域资源（CDN 图标、字体）都要带 `CORP` 头，
否则被拦。本项目默认用单线程版，正是为了避开这套服务器配置。

### Worker 类型

| 文件 | Worker 类型 | 原因 |
| --- | --- | --- |
| `chess-worker.js` | 经典 Worker | Stockfish 的 Emscripten 构建依赖 `importScripts`，而 module worker 里没有这个函数 |

### ⛔ 不要发 setoption（血的教训）

```js
send('setoption name Threads value 1');   // ← 千万别加
send('setoption name Hash value 16');     // ← 千万别加
```

加了这两条，**引擎会彻底沉默 —— 连一条 `info` 都不吐**，表现为「AI 永远不走子」，
但探测、握手、徽标全都显示正常，极难定位。

原因：Stockfish 处理 `Threads` 选项会**重建线程池**，而本构建是单线程 wasm
（`Threads max 1`），在无 pthread 的环境下重建线程池会把引擎打挂。
而且这两条本来就没必要 —— 默认值已经是 `Threads=1` / `Hash=16`。

浏览器控制台三段对照实验的结论（务必记住这个排查手法）：

| 命令 | 结果 |
| --- | --- |
| `position startpos` + `go depth 8` | ✅ `bestmove e2e4` |
| `position fen <FEN>` + `go depth 8` | ✅ `bestmove d7d5` |
| `setoption`×2 + `ucinewgame` + `position` + `go` | ❌ 完全无输出 |

### go 命令：depth 优先于 movetime

`movetime` 是**时间上限不是目标** —— Stockfish 会把时间用满才停。
两者同时给时 `movetime` 会盖掉 `depth`，导致每一步都硬等满时长。
所以 `chess-worker.js` 里 **depth 优先**，`movetime` 只在没给 depth 时兜底。

### 开局库

`js/chess-book.js`（约 279 KB，3990 个局面）是**自动生成**的，别手工编辑：

```bash
node tools/build-chess-book.mjs
```

数据来自 [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
（**CC0 1.0 Universal**，公共领域，可自由使用）。工具会回放每条 ECO 主变，
用项目自带的 `chess.js` 推出每个局面的候选着法，键是 FEN 前 4 段。

AI 在**前 8 个回合**优先走库（比引擎快，且是公认的好棋），之后交给引擎。
引擎信息栏此时会显示「开局库」。

> 库只存着法、**不存开局名**：同一局面常被多个 ECO 共用，强行贴名字会给出
> 误导性结论（实测会出现「1.e4 e5 后叫 Bongcloud Attack」这种）。

### 自定义难度（深度或时间）

难度卡里除了简单 / 中等 / 困难（对应深度 4 / 8 / 14），还有第四档「自定」，
可以自己填**搜索深度**（1–40 层）或**每步思考时间**（100–60000 毫秒），
两种模式互斥切换。

**为什么必须二选一**：worker 的 `go` 分支是 `depth` 优先，只有 `depth` 为空
才看 `movetime`。两个都发给引擎，`movetime` 会被静默丢掉 —— 界面上看着
「我设了 5 秒」，实际引擎在按深度跑。所以「按时间」模式下 `currentDepth()`
返回 `null`，而不是同时给两个参数。`tools/test-difficulty.mjs` 里有一条
反证断言专门守着这个坑。

取值一律先夹紧再回显（`clampCustom`）：填 999 层会回显成 40 并标红，
让人看见「我填的」和「实际生效的」不是一回事。空值单独判掉，
因为 `Number('') === 0` 且 `isFinite(0) === true`，否则清空输入框会
悄悄把难度改成最弱。

思考看门狗跟着 movetime 走（`max(60000, movetime * 2 + 10000)`），
否则设成 60 秒慢慢等时，到点的是看门狗而不是引擎。

### 难度开局后锁定

走出第一步后难度按钮、模式切换、数字输入框**全部**置灰，**只有点「新对局」
才解锁**。理由是走到一半换档等于随时给自己降难度。锁定状态由 `gameStarted`
标记，不看 `history`，否则一路悔棋回原点会把难度意外解锁。

锁定文案由 `updateDepthHint()` 统一拼（只有它知道实际生效参数），
不再用 `hint.dataset.base` 缓存 —— 那套在切到自定义后会与真实值脱节。

### 排查：引擎没反应怎么办

引擎「静默无响应」时，在浏览器控制台跑这段（**注意先 `Ctrl+Shift+R` 强刷**）：

```js
const w = new Worker('/js/lib/stockfish.js');
w.onmessage = e => console.log('<<', String(e.data).slice(0, 70));
w.onerror = e => console.log('ERR', e.message, e.filename, e.lineno);
w.postMessage('uci');
setTimeout(() => { w.postMessage('position startpos'); w.postMessage('go depth 8'); }, 3000);
```

- 看到 `uciok` + `bestmove` → 引擎正常，问题在 `chess-worker.js`
- 引擎回了 `uciok` 但 `go` 无输出 → 检查有没有误发 `setoption`（见上）
- 连 banner 都没有 → 脚本没加载成功，确认 `js/lib/stockfish.js` 存在且
  服务器返回 `application/javascript`

`chess-worker.js` 顶部有 `const DBG = true`，会在控制台打印 `[sf]` 前缀的
收发日志（发出什么、收到什么、哪一步被丢弃），排查时非常好用。

#### 「探测到了引擎，界面却说没找到」

这是 **worker 侧已 `uciok`、主线程却没收到 `ready`** 的典型症状（worker 日志里有
`< uciok`、`握手完成（booted=true）`，但没有任何 `ready` 相关行）。现在有三层保护：

| 现象 | 含义 |
| --- | --- |
| 控制台 `[chess] 引擎 1.8s 未就绪，发 isready 探活` 之后徽标变绿 | `ready` 确实丢过一次，兜底生效，可以正常下棋 |
| 控制台 `[chess] 引擎经 isready 探活后就绪` | 同上，且已确认是探活救回来的 |
| 徽标显示「Stockfish 已找到但未就绪」 | 兜底也没救回来，请把控制台 `[sf]` + `[chess]` 全部日志发出来 |

worker 侧也加了兜底：`handleLine` 抛错会打印 `[sf] !! handleLine 抛错:`（以前是静默半死），
`postMessage({type:'ready'})` 失败会打印 `[sf] !! postMessage(ready) 失败:`。

## 中国象棋

完整说明见 **[中国象棋-README.md](中国象棋-README.md)**，引擎接口与已知缺陷见
[js/lib/godogpaw/README.md](js/lib/godogpaw/README.md)。这里只放要点。

### 引擎

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `js/lib/godogpaw/godogpaw.wasm` | 4.7 MB | **godogpaw** 本体，Go 1.27.1 编译的 WebAssembly |
| `js/lib/godogpaw/wasm_exec.js` | 17 KB | Go 官方胶水，**必须与 wasm 同版本** |
| `js/lib/godogpaw/godogpaw-bridge.js` | 12 KB | 桥接层：加载 / 就绪 / 超时 / 崩溃保护 / FEN 校验 |

引擎往 `window` 挂 6 个函数（都是**实测**确认的，`tools/test-xiangqi.mjs` 逐条跑）：
`engineNewGame(fen)`、`engineGetBoard()`、`engineGetLegalMovesFrom(sq)`、
`engineDoMoveBySquares(from,to)`、`engineUndoMove()`、`engineSearch(depth,ms)`。

**三条最容易踩的**：

- ⚠ **坐标系**：`sq = file + rank*9`，**rank 0 = 红方底线**（画布下方），红 `1..7` / 黑 `9..15`。
- ⚠ **`engineSearch` 自己就把棋走掉了**，返回 `"b2e2"` 这类着法串；调用方不要再补一次 `doMove`。
- ⚠ **`engineGetLegalMovesFrom` 只生成"轮到走子那一方"的着法**：问对方棋子一律返回 `[]`。这是设计。

规则（走法生成、合法性、将军、将死/困毙）**全部来自引擎**，`js/xiangqi.js` 里没有一行象棋规则。
页面只负责画棋盘、交互、难度、记谱、离线。

### 难度

简单 `depth 2` / 中等 `depth 4` / 困难 `depth 8`（1200 ms 上限）/ 自定义（深度 1–20 或每步 100–30000 ms，二选一）。
实测耗时（Node 开局）：`d2 = 8ms`、`d4 = 64ms`、`d6 = 451ms`、`d8 = 1548ms`。
**走出第一步后难度锁定**，只有「新对局」解锁（理由同国际象棋那边）。

### 测试

```bash
node tools/check-xiangqi-page.mjs      # 静态检查 34 项
node tools/test-xiangqi.mjs            # 引擎与桥接层回归 49 项
node tools/test-xiangqi-browser.mjs    # 浏览器端到端 27 项（需 Chrome/Edge）
```

### ⚠ 引擎自身的两个缺陷（前端只隔离，不修）

1. **畸形 FEN 会崩坏引擎**：实测要么 Go 侧 panic、runtime 退出，要么静默接受并污染盘面。
   所以桥接层做 FEN 结构校验 + 白名单，界面**不提供**自定义局面 / 粘贴 FEN / 复制局面。
2. **AI 可能走出"自己送将"的着法**：自我对弈实测出现过。按约定前端**不做规则补丁**，
   只记录复现步骤，等引擎作者修。

## 离线（Service Worker）

`sw.js` 把整站预缓存（**48 个清单项 + 动态补全 29 个字体文件，含 4.7 MB 引擎 wasm**），
首屏加载完成后断网仍可玩：

- 预缓存清单（HTML / CSS / JS / wasm / 字体 / 图标 / 配图）→ install 时装好，fetch 走 **cache-first**
- **HTML 文档走 network-first**，断网才回退缓存 —— 这样刷新一定能拿到新版，不会"更新不动"
- 改样式或脚本后记得把 `sw.js` 里的 `CACHE_VERSION` 加一，`activate` 阶段会清掉所有旧缓存
- 页面顶部有更新提示条，新版本就绪时浮出，用户确认后才 `skipWaiting` 切换（不打断对局）

**字体、图标、配图全部自托管**：字体与图标在 `vendor/`（`node tools/build-vendor-assets.mjs`
重新生成），首页 5 张配图在 `img/home/`（WebP 共 130 KB，`node tools/localize-images.mjs` 重新生成）。
结果是 **`index.html` 里没有任何自动加载的远程资源**，只剩 2 条用户点击才走的跳转外链
（国际象棋的 Stockfish 下载指引等），断网不影响任何页面渲染。

## 交接说明（给接手的人 / AI）

### 本次会话做了什么

**A. 国际象棋的 4 个真 bug（都已修，都有回归验证）**

| # | 问题 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 点击区域比棋盘少一格 | `eventToSquare` 把格子的**左边缘**当成中心（`Math.round` + 用 `cellX()` 当中心校验），每格只有左半边可点，最右一整列完全点不到 | 改用 `Math.floor` + 格子中心 ±半格容差 |
| 2 | 棋盘上下颠倒 | `cellY(rank)` 让 rank 1 画在顶部 | 新增 `boardToScreen()` 变换，统一渲染与命中检测共用 |
| 3 | 翻转棋盘功能失效 | `render()` 直接拿棋盘坐标当屏幕坐标，从不调用变换函数；于是棋子不动、但点击映射翻了 | 同上，5 处渲染点全部走 `cellOf()` |
| 4 | 坐标标签错位 | 标签画在格子左上角而非中心 | 标签与格子中心对齐 |

坐标变换验证：两种朝向 × 64 格，渲染位置与命中检测**逐格一致**。

**B. 棋子换成 chess.com 同款**

`img/chess/{w,b}{K,Q,R,B,N,P}.svg` 共 12 个 cburnett 棋子（**CC BY-SA 3.0**，非 MIT/GPL，
对外分发需署名）。图片异步加载，未就绪时回退 Unicode 棋子，棋盘不会开天窗。

**C. 引擎接入（改动最大的一块，见上文「AI 引擎」全部 ⚠ 条目）**

修掉的：hash 后缀、就绪判据、`movetime` 优先级、`HEAD` 探测误判、
半装状态（只有 js 没有 wasm）、引擎非法着法导致对局卡死、空 bestmove 被误判为终局。

**D. UI 改版（浅蓝 + 反 SaaS）**

首页重做：非对称栅格（`1.25fr/.85fr`、`1.45fr/1fr`）、Instrument Serif 标题、
蓝图网格纸纹背景、Iconify 替代全部 emoji、Picsum 图片、三条自定义回弹曲线
（`--snap/--drift/--swing`）。删掉了顶部冗余的「加密工具」导航项。
配色变量在 `:root`，旧变量名（`--card`/`--primary` 等）保留为别名，
供尚未改造的棋类页使用 —— 属于过渡措施，后续可清理。

**E. 顺手修的**

- 五子棋难度按钮失效：`gomoku.js` 查 `.diff-btn`，HTML 里是 `.gomoku-diff-btn`，选择器匹配不到
- 吃路兵专项测试 7/7 通过（含「两兵同离一横线暴露己方王」这个经典非法例）

### 当前状态：可以玩

引擎能跑、点击区域正确、翻转正常、棋子正常。走一步 e4 黑棋应 1 秒内应声。

### 待办

- [ ] **中国象棋（`#/xiangqi`）仍是占位页**，计划接 Pikafish 本地引擎
- [ ] **PGN 导入导出**：`js/chess-engine/` 与 `js/gomoku-engine/` 都没有
- [ ] **顶部导航补全**：目前只有「首页 / 国际象棋 / 五子棋」，缺加密工具与中国象棋入口
- [ ] **清理过渡别名**：`css/style.css` 里旧变量名映射可逐步移除
- [ ] **cburnett 棋子授权**：若对外分发，需在 README/LICENSE 补署名与 CC BY-SA 说明
- [ ] **移除调试日志**：`chess-worker.js` 顶部 `const DBG = true`，确认稳定后可关掉

### ⚠ 接手前必读：工作方法

本次引擎接入连续返工 4 次（删 wasm、砍搜索深度、乱发 `isready`、加回坏 hash），
**根因全是「没有浏览器却基于推断改代码」**。后来改成先在 worker 里埋日志、
打印每一条收发命令和每一个静默丢弃分支，程序自己说话，一次定位。

所以：**改动引擎链路前，先跑一遍上面「排查：引擎没反应怎么办」那段控制台脚本**，
拿到实测输出再动手。不要凭猜测调参数 —— 这个引擎对时序极其敏感。

## 许可

本项目**自己写的代码**是 **MIT**，见 [LICENSE](LICENSE)。
项目同时**打包分发**了若干第三方组件，它们各自的许可优先：

| 组件 | 许可 | 位置 |
| --- | --- | --- |
| 本项目代码 | MIT | 见 [LICENSE](LICENSE) |
| **Stockfish.js**（国际象棋 AI） | **GPLv3** | `js/lib/stockfish.js` + `.wasm` |
| **cburnett 棋子图** | **CC BY-SA 3.0** | `img/chess/*.svg` |
| Instrument Serif | **OFL-1.1** | `vendor/fonts/Instrument-Serif-*` |
| Space Grotesk | **OFL-1.1** | `vendor/fonts/Space-Grotesk-*` |
| JetBrains Mono | **OFL-1.1** | `vendor/fonts/JetBrains-Mono-*` |
| Noto Serif SC（子集化） | **OFL-1.1** | `vendor/fonts/NotoSerifSC-subset.woff2` |
| Material Design Icons | Apache-2.0 | `vendor/icons/mdi-sprite.svg` |
| **godogpaw**（中国象棋引擎） | MIT | `js/lib/godogpaw/*` |
| Go `wasm_exec.js` | BSD-3-Clause | `js/lib/godogpaw/wasm_exec.js` |
| chess.js（国际象棋规则） | BSD-2-Clause | `js/chess-engine/chess.js.LICENSE` |
| 首页配图 5 张 | Unsplash License | `img/home/*.webp` |
| 开局库数据源 lichess chess-openings | CC0（公共领域） | 生成 `js/chess-book.js` |

**完整清单（含版本号、每张配图的作者、每条署名义务、对外分发检查清单）见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**；OFL-1.1 全文见 [licenses/OFL-1.1.txt](licenses/OFL-1.1.txt)。

**对外分发前必须做的两件事**：

1. **Stockfish 是 GPLv3** —— 要一并提供它的完整对应源码（不能只给 binary）。
2. **棋子图是 CC BY-SA 3.0** —— 要保留 Cburnett 署名与许可说明；若改编了棋子图，
   衍生图必须继续以 CC BY-SA 3.0 发布（这条只约束图，不约束本项目代码）。

仅本地自己用（不分发）则以上义务都不触发。
