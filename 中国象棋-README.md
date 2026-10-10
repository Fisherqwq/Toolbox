# 中国象棋分页说明

> 这份文档讲**中国象棋这一页**怎么用、怎么改、怎么测。
> 整站说明看 [README.md](README.md)，本次改动的前后脉络看 [HANDOFF-XIANGQI.md](HANDOFF-XIANGQI.md)。

## 一句话

人执红先行，点两下走子；对手是 **godogpaw**（Go 编译的 UCCI 引擎，跑在浏览器里的 WebAssembly）。
整个对局**不联网**：引擎、棋盘、字体、图标全在本地，断网照下。

## 怎么玩

1. 起本地服务（**不能双击 `index.html`**，`file://` 下 WASM 与 Service Worker 都会被拦）：

   ```bash
   cd Toolbox
   python tools/serve.py 8000
   # 或 python -m http.server 8000 / npx serve
   ```

2. 浏览器打开 `http://127.0.0.1:8000/#/xiangqi`
3. 走子：**先点自己的棋子**（会显示蓝色落点），**再点落点**。点自己另一颗子可换选，点空白取消。
4. 侧栏：

   | 区域 | 作用 |
   | --- | --- |
   | 状态卡 | 轮到谁、是否被将军、最近一手；AI 思考时显示三个跳动点 |
   | 引擎 | 加载状态徽标；就绪后显示最近一手的耗时 |
   | 难度 | 简单 / 中等 / 困难 / 自定义。**走出第一步后锁定**，只有点「新对局」解锁 |
   | 对局 | 新对局、悔棋、翻转棋盘、认输、复制开局 FEN；下面是胜负战绩（存 localStorage） |
   | 走子记录 | 点标题展开，显示中文记谱（如「炮二平五」）+ ICCS 坐标 |

## 难度参数

| 档位 | 引擎参数 | 实测耗时（Node 开局） |
| --- | --- | --- |
| 简单 | `depth 2` | 约 8 ms |
| 中等 | `depth 4` | 约 64 ms |
| 困难 | `depth 8` + 1200 ms 上限 | 约 1.5 s |
| 自定义 | 搜索深度 1–20 **或** 每步思考 100–30000 ms，二选一 | — |

自定义里两个参数互斥（界面只让选一个）：引擎的 `engineSearch(depth, ms)` 两个都认，
同时给时**先到者生效**，摆两个都填的输入框会让人误以为都生效。

## 离线能力

| 层 | 做法 |
| --- | --- |
| 页面骨架 / 脚本 / 样式 / 引擎 wasm | `sw.js` 预缓存清单（install 时装好），fetch 走 **cache-first** |
| HTML 文档 | **network-first**，断网回退缓存 —— 保证刷新能拿到新版，不会"更新不动" |
| 字体 | 自托管在 `vendor/fonts/`（Google Fonts 的 woff2 已下载 + 中文用 fonttools 子集化到 160 KB） |
| 图标 | `vendor/iconify-lite.js`（本地实现 `<iconify-icon>`）+ `vendor/icons/mdi-sprite.svg`（13 个图标） |
| 配图 | 首页 5 张图本地化在 `img/home/`（WebP 共 130 KB），`node tools/localize-images.mjs` 可重新生成 |
| 版本更新 | 改 `sw.js` 的 `CACHE_VERSION` → `activate` 阶段删掉所有旧缓存；页面顶部浮条提示刷新 |

**首屏加载完成后即可断网**：DevTools → Network 勾 Offline，刷新，页面与对局都应正常。
整站的图片、字体、图标现在都在本地，断网不会开天窗。

`file://` 协议下 Service Worker 不注册，控制台会给出提示；请用 HTTP 打开。

## 文件结构

```
index.html                                  #view-xiangqi 这一段是中国象棋的 DOM
css/style.css                               .xq-* 段（中国象棋专用样式）
js/xiangqi.js                               页面逻辑：canvas 棋盘、交互、对局流程、难度、记谱
js/lib/godogpaw/godogpaw-bridge.js          桥接层：加载/就绪/超时/崩溃保护/FEN 校验
js/lib/godogpaw/godogpaw.wasm               引擎本体（4.7 MB）
js/lib/godogpaw/wasm_exec.js                Go 官方胶水
js/lib/godogpaw/README.md                   引擎接口与已知缺陷
vendor/fonts.css + vendor/fonts/*           自托管字体
vendor/iconify-lite.js + vendor/icons/*     本地图标
sw.js + js/sw-register.js                   离线缓存
tools/build-vendor-assets.mjs               重新生成 vendor/（字体 + 图标）
tools/subset-cjk-font.mjs                   单独重新生成中文子集字体
tools/serve.py                              本地静态服务器（认 wasm/mime）
```

`js/main.js` 的 hash 路由在切到 `#/xiangqi` 时调用 `window.XiangqiApp.init()`，`init()` 幂等。

## 规则来自哪里

**全部来自引擎**，`js/xiangqi.js` 里没有一行象棋规则：

- 走法生成、合法性、将军 → `engineGetLegalMovesFrom` / `engineDoMoveBySquares`
- 将死与困毙 → `engineGetBoard().isGameOver`（引擎判定"无着可走"）。中国象棋里
  将死与困毙**同判负**，所以页面统一显示「无着可走 —— 对方胜」
- 中文记谱 → 页面自己按"起点 + 终点 + 棋盘"推（红方纵线从右往左一~九，黑方从左往右 1~9）。
  兵/卒同线多子时的"前/后"不做，宁可少写也不写错谱

引擎的接口细节与**两个已知缺陷**（畸形 FEN、AI 可能自送将）见
[js/lib/godogpaw/README.md](js/lib/godogpaw/README.md)。

## 测试

四层，都能在本机跑：

```bash
# 1. 静态检查：文件齐不齐、id 有没有缺、有没有残留远程资源、语法（34 项）
node tools/check-xiangqi-page.mjs

# 2. 引擎与桥接层回归：坐标系、走法、悔棋、限时、FEN 护栏（49 项）
node tools/test-xiangqi.mjs

# 3. 浏览器端到端：点两下走子、AI 应手、锁定难度、翻转、悔棋、Service Worker、控制台报错（27 项）
#    需要系统装了 Chrome 或 Edge；脚本自己起服务器
node tools/test-xiangqi-browser.mjs 8011
```

浏览器测试会顺手截图到 `tmp_verify/`（`xq-page.png`、`xq-view.png`），方便肉眼复核视觉。

**改中国象棋相关代码后，至少跑 1 和 2；改了 DOM/交互就跑 3。**

### 手工验证离线（脚本测不了）

1. 打开 `http://127.0.0.1:8000/`，点「中国象棋」，**等引擎徽标变成「已就绪」**
2. `F12` → Application → Service Workers，确认 `sw.js` 是 activated 状态
3. Network 面板勾 **Offline**，然后 `Ctrl+Shift+R` 强制刷新
4. 预期：页面正常打开、棋盘正常、能走子、AI 能应手，Network 里所有请求都标 `(ServiceWorker)`
5. 取消 Offline，刷新一次，确认能拿到最新文件（network-first）

### 排查用埋点

页面内置了调试埋点，控制台里执行：

```js
window.XiangqiDebug = true;      // 之后每个关键分支都会打印 [xq] xxx
window.__xqLog;                  // 最近的埋点记录（含 click/hit/ai-*/undo 等）
window.Godogpaw.state;           // idle | loading | ready | error | crashed
window.Godogpaw.error;           // 出错时的 Error 对象
```

`window.GodogpawDebug = true` 会额外打印桥接层的每次 undo/加载动作。

## 改这一页时要注意的坑（都踩过）

1. **渲染与命中检测必须共用同一套坐标变换**（`cellCenter` / `squareAt`）。
   国际象棋分页当初就是两者各写一套，结果翻转棋盘后棋子不动、点击错位。
2. **画布逻辑尺寸 640×709**，CSS 只给 `width:100%` + `aspect-ratio`。
   测试里把页面坐标换算成逻辑坐标时用的是 `LOGICAL_H / rect.height`，别写死 640。
3. **`engineSearch` 自己会落子**，不要再补一次 `doMove`，否则一步走两手。
4. **悔棋不要靠"数手数"**：玩家落子后、AI 应手前那个瞬间，本地记录与引擎历史会差一拍。
   现在的做法是记住"上次玩家落子之前的盘面"，撤到该盘面为止，可自我纠正。
5. **悔棋按钮在 AI 思考期间是禁用的**，自动化测试点它之前要等它可用，否则点击被吞。
6. **`let` 声明位置**：`searchGen` 曾经写在 `playMove` 后面，而 `aiMove()` 第一句就 `++searchGen`，
   撞上暂时性死区抛 `ReferenceError`，被事件系统吞掉 —— 症状是"AI 永远不走子"，控制台一片安静。
   新加的跨函数变量一律放到状态区顶部。
7. **Service Worker 首次安装不要 `location.reload()`**：首装接管不影响正确性，
   重载反而会让页面刚打开那几百毫秒内的点击全部落空。只有"旧 SW 换新 SW"才刷新。
8. **绝不用 PowerShell 的 `Set-Content` 改 UTF-8 源码**（会按 GBK 重解码 + 合并换行）。
   改文件用编辑工具，或用 Node 显式 `fs.writeFileSync(p, s, 'utf8')`。

## 已知问题

| # | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| 1 | 引擎收到畸形 FEN 会崩坏 runtime | 页面护栏已挡住（白名单），不提供自定义局面 | 引擎作者待修 |
| 2 | AI 偶尔走出"自己送将"的着法 | 对局可能出现违规着法 | 引擎作者待修，前端不做规则补丁 |
| 3 | 深搜时主线程被占，界面会卡一下 | 困难档（depth 8）思考期间点击无响应，属预期 | 已知，未做 Worker 化 |
| 4 | 悔棋后难度仍保持锁定 | 与"开局后锁难度"一致，点「新对局」解锁 | 设计如此 |
| 5 | 记谱不写"前/后"（兵卒同线多子） | 极少数局面记谱不够严谨 | 有意为之，避免写错谱 |
| 6 | 引擎 wasm 有 4.7 MB | 首次打开要等一下（有加载徽标） | 已进 SW 预缓存，第二次起即离线可用 |
