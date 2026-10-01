# Toolbox · 棋 · 密 · 工具箱

纯静态、本地运行的棋类与加密工具箱。所有计算都在浏览器里完成，不上传任何数据。

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
| 中国象棋 | `#/xiangqi` | 🚧 占位页（开发中） |
| 加密工具箱 | `#/crypto` | ✅ AES-GCM / Base64 / SHA-256 / SHA-512 |

## 目录结构

```
Toolbox-main/
├── index.html              页面骨架：所有视图的 HTML
├── css/style.css           全站样式（CSS 变量 + 各工具的独立前缀）
└── js/
    ├── main.js             hash 路由 + 加密工具的事件绑定
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
    └── lib/                Stockfish 可执行文件（不入库，见 js/lib/README.md）
tools/
    └── build-chess-book.mjs  重新生成开局库（Node 脚本）
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

### AI 引擎

引擎在 `js/lib/stockfish.js`，**单文件 asm.js 构建，约 1.5 MB，二进制已内嵌**。

几个关键特性（都是踩过坑之后定下来的，改动前务必读完）：

- **不需要额外的 `.wasm` 文件**。旧版 wasm 构建要 `stockfish.js` + `stockfish.wasm` 两个文件，
  且靠 URL 上的 `#<wasm名>,worker` 后缀让引擎拼出 `locateFile`。asm.js 版把这套去掉了：
  它的 `locateFile` 就是 `function(file){ return file }`，**加 hash 反而可能干扰解析**。
- **不需要 COOP/COEP 响应头**。这是单线程版，没用到 `SharedArrayBuffer`，
  所以静态服务器（`python -m http.server`、VS Code Live Server）直接就能跑。
  只有多线程版才需要那两个头，见下方「想换多线程版」。
- **必须是经典 Worker**，不能 `{ type: 'module' }`：引擎依赖 `importScripts`，而 module worker 没有这个函数。

页面启动时会 `HEAD` 探测 `js/lib/stockfish.js`（拿不准时用 `GET` 复核，
避免服务器对 `HEAD` 返回 405 造成误判）：

| 探测结果 | 表现 |
| --- | --- |
| 文件存在 | 侧栏显示「已加载 · Stockfish」，可选深度 4/8/14 |
| 文件不存在 | 侧栏显示「缺少 Stockfish 引擎」并弹出下载面板，**无法对弈** |

简易引擎已删除：棋力太弱，且曾因未同步局面导致 AI 走出非法着法。
现在没有 Stockfish 就没有对手，页面会明确报错并给出下载入口，不做静默降级。

**换引擎**：把上游的单文件 asm.js 构建放到 `js/lib/stockfish.js` 即可，
页面代码无需改动。若换回 wasm 构建，则需要同时放回 `stockfish.wasm`
并把 `chess-worker.js` 里的 `new Worker(ENGINE_URL)` 改回带 hash 的形式。

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

### 难度开局后锁定

走出第一步后难度按钮置灰，**只有点「新对局」才解锁**。理由是走到一半换档
等于随时给自己降难度。锁定状态由 `gameStarted` 标记，不看 `history`，
否则一路悔棋回原点会把难度意外解锁。

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

## 本次改动（国际象棋功能）

新增：

- `js/chess-engine/`：`chess.js`（规则）、`chess.js.LICENSE`、
  `test.mjs`（规则回归测试）
- `js/lib/`：`stockfish.js`、`stockfish.wasm`、`README.md`
- `js/chess.js`、`js/chess-bridge.js`、`js/chess-worker.js`

已删除：

- `js/chess-fallback-worker.js`（简易引擎 worker）
- `js/chess-engine/eval.js`（简易引擎本体）

修改：

- `index.html`
  - 填充原先的 `#view-chess` 占位视图为完整对局界面
  - 引入 `chess-bridge.js`（module）与 `chess.js`
  - 首页卡片改用五子棋页面的视觉风格（22px 圆角、图标底座、状态标签）
  - 修正缩进错乱的 `crypto-entry-wrap` 块
- `js/main.js`
  - `showView()` 增加 `#/chess` 的 init 钩子
- `css/style.css`
  - 新增 `.chess-*` 全套样式（与 `.gomoku-*` 同一套设计语言与响应式断点）
  - `.game-card`、`.crypto-entry` 圆角由 1.5rem 改为 22px，
    补上与 gomoku 卡片一致的阴影、图标底座、`.tag-soon` 状态标签

未改动：`gomoku.js`、`gomoku-worker.js`、`gomoku-engine/`、
`crypto-tools.js`、`fingerprint.js`、`lucky.js`。

## 待办

- [ ] **浏览器实测**：起 HTTP 服务后走一遍完整对局，
      重点确认 Stockfish 加载成功、悔棋/翻转/难度切换正常
- [ ] 中国象棋（`#/xiangqi`）仍是占位页
- [ ] `js/gomoku-engine/` 与 `js/chess-engine/` 缺 PGN 导入导出
- [ ] 顶部导航目前只有「首页 / 加密工具」，可考虑补上各棋类入口

## 许可

| 组件 | 许可 |
| --- | --- |
| 本项目代码 | 见仓库 LICENSE |
| chess.js | BSD-2-Clause（`js/chess-engine/chess.js.LICENSE`） |
| Stockfish.js | GPLv3（`js/lib/README.md` 内有链接） |

Stockfish 是 GPL 软件，若要分发本项目，需一并提供其源码。
