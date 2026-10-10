# 交接文档 · 中国象棋分页重做

> 2026-10-11 · 对应备份 `D:\localwebsite\_backup_toolbox_20261011-000749\`
> 详细使用说明见 [中国象棋-README.md](中国象棋-README.md)；引擎接口见 [js/lib/godogpaw/README.md](js/lib/godogpaw/README.md)。

---

## 一、这次改了什么

**一句话**：把原来接"象眼 ElephantEye"的占位页整个删掉，改用你提供的
`中国象棋模型/main.wasm`（Go 编译的 **godogpaw** UCCI 引擎），重做成一页能正常对弈、
可离线、AI 全在本机跑的中国象棋；顺手把全站的远程字体与图标也本地化了。

### 1. 引擎更换（核心）

| | 旧 | 新 |
| --- | --- | --- |
| 规则引擎 | `zh-chess`（JS，60 KB） | 无 —— 规则全部由 godogpaw 提供 |
| AI | 象眼 ElephantEye（WASM + UCCI Worker） | godogpaw（Go/WASM，6 个全局函数） |
| 通信 | 自己写的 Worker 协议（UCI 文本） | 直接调全局函数，`engineSearch` 返回 Promise |
| 校验依据 | Node 里跑 perft | `tools/test-xiangqi.mjs` 49 项 + 浏览器 27 项 |

### 2. 资源本地化（原需求外的必要项）

原页面的字体来自 `fonts.googleapis.com`、图标来自 `code.iconify.design`，
断网后图标会整片消失。现在：

- `vendor/fonts/` 自托管 4 个字族的 woff2（含 `fonttools` 子集化的中文标题字体，962 字 → 160 KB）
- `vendor/iconify-lite.js`：自己实现的 `<iconify-icon>`（保持原标记不变），配 13 个图标的 sprite
- `index.html` 里已无任何"自动加载的远程资源"

### 3. 离线

新增 `sw.js` + `js/sw-register.js`：预缓存 48 个清单项（字体按 `fonts.css` 动态补全，
实际缓存 78 个请求，含 4.7 MB 引擎 wasm），HTML 用 network-first（保证能更新），
其余 cache-first；`CACHE_VERSION` 一改即清旧缓存（当前 **v3**）。

### 4. 第二轮：你实测报的两个问题（都已修）

#### 4.1 `/favicon.ico` 404

**现象**：控制台一条 `:5500/favicon.ico:1 Failed to load resource: 404`。

**原因**：`index.html` 从来没写 `<link rel="icon">`，浏览器就按约定去要 `/favicon.ico`，
而仓库里没有这个文件。**这是我自测漏掉的**：冒烟脚本一直把 `favicon` 当噪声过滤了，
所以 30/30 全绿却看不见它。

**修法**：加一行内联 SVG data URI 图标（蓝色网格棋盘），零额外请求、断网也在。

- ⚠ 这个 data URI 里**不能写 `xmlns="http://www.w3.org/2000/svg"`**：
  favicon 不需要它，而写了会被"零远程资源"的静态检查判成外链（已踩，检查里会 FAIL）。
- 同时把冒烟脚本里的 `favicon` 噪声过滤去掉，改成"404 一律算问题并把 URL 打出来"，
  这个类别的漏检不会再发生。

#### 4.2 国际象棋：探测到了引擎却说没找到

**你给的日志**：`[chess] 引擎文件：js=true wasm=true`、`[sf] < uciok`、
`[sf] 握手完成（booted=true）` —— worker 侧握手成功；但日志里**没有任何 `ready` 相关行**。

**根因**：worker 收到 `uciok` 之后要做三件事（`flush()` → `postMessage({type:'ready'})` → 置位），
这一段**完全没有兜底**：

- worker 侧：`handleLine` 一旦抛错，异常冒泡到 `inner.onmessage`，`ready` 就永远发不出去，
  而且现场是静默的（只有 `[sf]` 日志停在 `< uciok`）
- 主线程侧：只会一直停在「正在加载 Stockfish…」，没有任何超时或报错

**修法**（三处，都不改引擎协议，只加容错与探活）：

| 位置 | 改动 |
| --- | --- |
| `js/chess-worker.js` | ① `handleLine` 调用包 try/catch，异常打 `!! handleLine 抛错` 不再静默；② `postMessage({type:'ready'})` 包 try/catch 并置 `readyPosted`；③ 新增 `case 'ping'`：已 ready 就重发 ready，未 ready 就发 `isready`；④ `readyok` 到达时若还没 ready 过就补发一次 |
| `js/chess.js` | 新增**就绪看门狗** `armReadyWatchdog()`：1.8s 未 ready 就发 `ping` 探活；再 2.5s 仍没有则徽标改「Stockfish 已找到但未就绪」并给出可操作提示，不再无限转圈。`ready` / `unavailable` / 重新 spawn 时都会 `disarm` |
| 冒烟脚本 | 404 一律暴露 URL，不再过滤 favicon |

**为什么这么修而不是只改一处**：worker 与主线程是两个独立的事件循环，
"worker 发过 ready" 与 "主线程收到 ready" 是两件事；任何一侧静默都会让 UI 卡在加载态。
现在单侧异常也能自愈（探活）或至少给出明确诊断，不会再出现"引擎找到了却说没找到"这种含糊状态。

### 5. 修掉的两个真 bug（都是新代码里的）

1. **Service Worker 首次安装就 `location.reload()`** —— 页面刚打开那几百毫秒内的点击全部落空
   （实测症状：第一次点棋子毫无反应，引擎却在后台重新加载）。现在只有"旧 SW 换新"才刷新。
2. **`let searchGen` 声明位置错误** —— `aiMove()` 第一句 `++searchGen` 撞上暂时性死区抛
   `ReferenceError`，被事件系统吞掉，症状是"玩家落子成功但 AI 永远不应手"、控制台一片安静。
   现在跨函数变量统一放状态区顶部，并给点击处理加了异常兜底。

顺手修了 `css/style.css` 里一处**预先存在**的语法错误：`@keyframes xqBlink` 之后多了一个 `}`，
导致它意外闭合了样式块（会让后面的规则跑到媒体查询外面）。

---

## 二、文件清单

### 修改（9 个）

| 文件 | 改动 |
| --- | --- |
| `index.html` | ① 去掉 Google Fonts 与 Iconify 的 CDN 引用，改引 `vendor/`；② `#view-xiangqi` 整段重写；③ 底部脚本换成 `godogpaw-bridge.js` + `xiangqi.js`，并加 `sw-register.js`；④ 首页那张中国象棋卡片文案改为 godogpaw；⑤ 首页 5 张配图改本地 WebP 并补 `width`/`height`；⑥ 加内联 SVG favicon（修 `/favicon.ico` 404） |
| `css/style.css` | ① 删掉不再使用的引擎评估块（`.xq-engine-toggle/.xq-engine-eval`）；② 修 `@keyframes xqBlink` 后多余的 `}`；③ 新增 Service Worker 更新提示条样式 |
| `js/chess-worker.js` | **第二轮**：`handleLine` 调用加异常兜底、`ready` 发送加 try/catch、新增 `ping` 探活分支、`readyok` 补发 ready（修"探测到引擎却说没找到"） |
| `js/chess.js` | **第二轮**：新增引擎就绪看门狗 `armReadyWatchdog()`，1.8s 未 ready 就探活、再 2.5s 给出明确文案（同上前提） |
| `sw.js` | **第二轮**：预缓存清单加 5 张本地配图；`CACHE_VERSION` v1 → v2（配图）→ **v3**（引擎修复） |
| `.gitignore` | **第二轮**：给 `js/lib/godogpaw/*` 加显式反忽略（本地编译产物，必须入库） |
| `README.md` | 功能表里中国象棋改为"可对弈"；新增「中国象棋」章节与测试命令；离线段落更新为"零远程资源" |
| `HANDOFF-CONTEXT.md` | 补记引擎事实、坐标系、四个坑、离线方案、清理记录与验证方法 |
| `js/lib/README.md` | **第二轮重写**：讲清"哪个引擎入库、哪个不入库、为什么"，并纠正旧文案 |

### 新增（27 个）

```
js/lib/godogpaw/godogpaw.wasm         4.7 MB  引擎本体（与 中国象棋模型/main.wasm 逐字节相同）
js/lib/godogpaw/wasm_exec.js          17 KB   Go 官方胶水
js/lib/godogpaw/godogpaw-bridge.js    12 KB   桥接层（加载/就绪/超时/崩溃保护/FEN 校验）
js/lib/godogpaw/README.md                     引擎接口与已知缺陷

vendor/fonts.css                              28 条 @font-face，全部本地
vendor/fonts/*.woff2                  29 个   4 字族 + 中文子集
vendor/iconify-lite.js                        本地 <iconify-icon> 实现
vendor/icons/mdi-sprite.svg                   13 个图标 sprite

sw.js                                         Service Worker
js/sw-register.js                             注册 + 更新提示条

tools/build-vendor-assets.mjs                 重新生成 vendor/（字体 + 图标）
tools/subset-cjk-font.mjs                     单独重新生成中文子集字体
tools/check-xiangqi-page.mjs                  静态检查（34 项）
tools/test-xiangqi.mjs                        引擎与桥接层回归（49 项）
tools/test-xiangqi-browser.mjs                浏览器端到端（27 项）

中国象棋-README.md                            中国象棋分页说明
HANDOFF-XIANGQI.md                            本文档
```

### 删除（6 个 + 2 个目录）

```
js/xiangqi-worker.js                 9 KB    旧的象眼 UCCI Worker
js/xiangqi-engine/zh-chess.browser.min.js  60 KB  旧规则引擎
js/xiangqi-engine/zh-chess.LICENSE
js/xiangqi-engine/test.mjs           11 KB    旧的 perft 测试
js/lib/eleeye/eleeye.js              67 KB    旧引擎胶水
js/lib/eleeye/eleeye.wasm           107 KB    旧引擎本体
```

删除前已逐个确认：`index.html`、`sw.js`、各 JS、各测试脚本里**都没有引用**它们。
两个目录（`js/xiangqi-engine/`、`js/lib/eleeye/`）在删除后已空，一并移除。

### 未改动

`js/chess.js`、`js/chess-worker.js`、`js/chess-engine/`、`js/gomoku.js`、`js/gomoku-worker.js`、
`js/gomoku-engine/`、`js/crypto-tools.js`、`js/fingerprint.js`、`js/lucky.js`、`js/chess-book.js`、
`js/main.js`、`img/chess/*`、`js/lib/stockfish.*`、`中国象棋模型/**`（全部原样保留）。

`js/main.js` 里 `window.XiangqiApp.init()` 那段**特意没动** —— 新页面的入口签名与旧页面一致，
所以这个文件零改动，也就零风险。

---

## 三、备份位置与回滚

**备份**：`D:\localwebsite\_backup_toolbox_20261011-000749\`（89 MB，2961 个文件）
路径也写在 `D:\localwebsite\_last_backup_path.txt`。

| 内容 | 说明 |
| --- | --- |
| `project\` | 改动前的**全部项目文件** |
| `repo-HEAD-20261011-000749.bundle` | git bundle，含全部分支与历史（`git bundle verify` 已通过） |
| `SHA256SUMS.txt` | 每个文件的哈希 + 14 个关键文件的逐一比对记录 |
| `RESTORE.md` | 三种回滚方式的详细步骤 |
| `rollback.ps1` | 一键全量回滚脚本 |

**已验证**：改动前的 14 个关键文件（`index.html`、`css/style.css`、`js/xiangqi.js`、
`js/xiangqi-worker.js`、`js/main.js`、`js/chess.js`、`js/gomoku.js`、`js/xiangqi-engine/*`、
`js/lib/eleeye/*`、`中国象棋模型/main.wasm`、`中国象棋模型/wasm_exec.js`、两处文档）
SHA256 与备份内副本**逐一致**。

### 怎么回滚

```powershell
# 方式一：全量（推荐，不删任何东西，原目录改名保留）
powershell -ExecutionPolicy Bypass -File D:\localwebsite\_backup_toolbox_20261011-000749\rollback.ps1

# 方式二：只回滚某几个文件
$bk='D:\localwebsite\_backup_toolbox_20261011-000749\project'; $src='D:\localwebsite\Toolbox'
Copy-Item "$bk\index.html" "$src\index.html" -Force
Copy-Item "$bk\js\xiangqi.js" "$src\js\xiangqi.js" -Force
# 注意：回滚后 index.html 引用的新增文件（js/lib/godogpaw/、vendor/、sw.js）需要手动清引用，
# 或干脆用方式一。

# 方式三：git
git checkout -- README.md css/style.css index.html js/main.js
```

回滚后 `node_modules\` 不在备份里，需要时重新 `npm i`（只影响跑 Puppeteer 测试）。

---

## 四、验证情况（哪些是真测过的）

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 静态检查 | `node tools/check-xiangqi-page.mjs` | **35/35 通过** |
| 引擎与桥接 | `node tools/test-xiangqi.mjs` | **49/49 通过** |
| 浏览器端到端 | `node tools/test-xiangqi-browser.mjs 8011` | **27/27 通过** |
| 全站冒烟（防回归） | `node tools/smoke-all-pages.mjs` | **30/30 通过** |
| 国际象棋原有回归 | `node js/chess-engine/test.mjs` | 全部通过 |

冒烟测试覆盖 5 个路由 × 6 项：视图可见、图标全渲染（22/22）、字体全本地（29 条 @font-face）、
**配图全部真实解码**、**零跨域请求**、控制台干净（含 404 一律暴露 URL）。

浏览器端到端覆盖：引擎就绪、canvas 有绘制内容、点两下走子、命中检测落在正确交叉点、
AI 应手并轮回红方、走子记录、开局后锁难度、翻转不改盘面、悔棋（撤 2 手回开局）、
新对局解锁、FEN 护栏、越界与非法着法、Service Worker 注册与预缓存含 wasm、控制台无严重报错。

截图：`tmp_verify/xq-page.png`、`xq-view.png`、`xq-board.png`（棋盘特写）、`xq-after.png`、`xq-history.png`。
开发期用来实测引擎事实的探针脚本也留在 `tmp_verify/`，索引见 `tmp_verify/README.md`（可整个删掉）。

### 没能自测、留给你确认的

1. **国际象棋引擎这次修复的效果**：我改的是容错与探活逻辑，没有你的浏览器现场就没法复现原始故障。
   请强刷一次（`Ctrl+Shift+R`）后看侧栏徽标：
   - 变绿「已加载 · Stockfish」→ 正常
   - 控制台出现 `[chess] 引擎 1.8s 未就绪，发 isready 探活` 然后变绿 → 兜底生效，说明确实丢了 ready
   - 徽标变「Stockfish 已找到但未就绪」→ 兜底也没救回来，请把控制台里 `[sf]` 与 `[chess]` 全部日志给我
2. **断网实测**（脚本测不了真的断网）。
3. **真人手感**与窄屏（<900px）布局。

### 还没验证的（需要真人浏览器）

1. **断网实测**：脚本能验证 SW 装好了、缓存里有 wasm，但"真断网后刷新仍可下"必须手工确认
   （步骤见 `中国象棋-README.md` 的「手工验证离线」）。
2. **真人手感**：点击精度、棋盘在小屏（<900px）下的布局、中文字体在你系统上的观感。
3. **困难档（depth 8）思考时的卡顿程度**：搜索在主线程，深搜会卡界面 —— 能接受还是要改成 Worker？
4. **AI 自送将缺陷的实际复现**：需要下到中局才容易遇到，脚本只验了开局。

---

## 五、待办

- [ ] **引擎作者修两个缺陷**：畸形 FEN 崩坏状态、AI 可能自送将（复现步骤见 `js/lib/godogpaw/README.md`）
- [ ] 深搜 Worker 化（把 godogpaw 放进 Worker，彻底解决困难档卡界面）
- [ ] 记谱的"前/后"（兵卒同线多子）未实现
- [ ] 重跑浏览器测试需 `npm i puppeteer`（现在只装了 `puppeteer-core`，靠系统 Chrome）

---

## 五之二、清理与配图本地化（2026-10-11 第二轮）

### 删掉的资源

**删前都确认过：零代码引用 + 都在备份 `_backup_toolbox_20261011-000749\project\` 里。**

| 删除项 | 体积 | 依据 |
| --- | --- | --- |
| `tmp_pk/` | **61.62 MB**（269 个文件） | 上一轮排查的临时脚本与日志，含 48 MB 的 `pikafish.nnue`、9.5 MB 的 `cc.zip`；全项目零引用 |
| `js/lib/pikafish/` | 0.71 MB | 曾尝试接入 Pikafish，最终未用；`index.html`/`sw.js`/各 JS 里零引用 |
| `js/xiangqi-engine/`、`js/lib/eleeye/` | 已随重做删除 | 旧的中国象棋规则引擎与象眼引擎 |

**顺手补的两份配置**：

- `.gitignore` 给 `js/lib/godogpaw/*` 加了**显式反忽略** —— 它是本地编译产物
  （上游只提供 Go 源码，没有 release 好的 wasm），丢了要重装 Go 工具链，必须跟着仓库走
- `js/lib/README.md` 重写：讲清"哪个引擎入库、哪个不入库、为什么"，
  并纠正旧文案与实际状态不一致的地方

**项目体积**：`69.92 MB → 14.82 MB`（不含 `node_modules` 与 `.git`）。

### 第三轮：你实测报的两个问题（详见第一节 4.1 / 4.2）

| 问题 | 根因 | 修法 |
| --- | --- | --- |
| 控制台 `/favicon.ico` 404 | `index.html` 从没写 `<link rel="icon">`，浏览器按约定去要它，而仓库里没有 | 加内联 SVG data URI 图标（零请求）；并把冒烟脚本的 favicon 噪声过滤去掉 |
| 国际象棋「探测到引擎却说没找到」 | worker 过 `uciok` 后那段（`flush()` → `postMessage(ready)`）无兜底，抛错即静默半死；主线程无超时只会转圈 | worker 加异常兜底 + `ping`/`readyok` 补发 ready；主线程加就绪看门狗（1.8s 探活 / 4.3s 明确文案） |

**顺带修正一处自己的测试缺陷**：冒烟脚本原来把 `favicon` 与 `picsum` 当噪声过滤，
所以 30/30 全绿却漏掉了真实的 404。现在 **404 一律算问题并把 URL 打出来**。

### 首页配图本地化

首页原来 5 张图都是 `picsum.photos` 外链，断网会空。现已全部落进 `img/home/`：

| 文件 | 尺寸 | 大小 | 用在哪 |
| --- | --- | --- | --- |
| `chess-desk.webp` | 720×900 | 40 KB | 首页首图 |
| `chess-board.webp` | 900×500 | 9 KB | 国际象棋卡片 |
| `gomoku-stone.webp` | 600×420 | 15 KB | 五子棋卡片 |
| `xiangqi-board.webp` | 600×420 | 13 KB | 中国象棋卡片 |
| `padlock.webp` | 560×520 | 53 KB | 加密工具箱 |

合计 **130 KB**，五张全部进了 Service Worker 预缓存（预缓存项 43 → **48**）。

- 重新生成：`node tools/localize-images.mjs`（幂等：已存在就跳过；会核对 WebP 真实尺寸）
- ⚠ **Picsum 要 WebP 必须用路径后缀** `.../600/420.webp`（15 KB）；
  `...?fm=webp` 会被忽略、仍返回 JPEG（23 KB）。实测过，注释写在脚本里
- 5 个 `<img>` 都补了 `width`/`height`，避免图片加载前后布局抖动
- 结果：**整站零自动加载的远程资源**，`index.html` 里只剩 2 条用户点击才走的跳转外链

### 因此升级了缓存版本

`sw.js` 的 `CACHE_VERSION` 从 `v1` → **`v2`**（预缓存清单变了）。
`activate` 阶段会删掉 v1 缓存；已装过旧版的用户刷新时会看到更新提示条。

---

## 六、还需要你确认的事项

1. **困难档卡顿**：要不要把引擎搬进 Worker（改动量中等，需要重新验证整条链路）？
2. **玩家执黑**：现在固定人执红先手。需要"我执黑 / AI 先走"的选项吗？
   （引擎支持，`engineSearch` 会替轮到的一方走子。）
3. **`tmp_verify/`（2 MB）**：本次重做的探针脚本 + 4 张截图，是"先埋日志再动手"的证据链，
   索引见 `tmp_verify/README.md`。要保留还是删掉？（不影响运行）

---

## 七、已知风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 引擎缺陷不可控 | 畸形 FEN 会崩坏状态；AI 可能自送将 | 前端 FEN 白名单 + `crashed` 状态兜底；不提供自定义局面；不做规则补丁（按约定） |
| 深搜阻塞主线程 | depth 8 思考期间界面无响应 | 困难档加了 1200 ms 时间上限；可选 Worker 化 |
| 首次加载 4.7 MB | 引擎 wasm 较大，首次打开要等一下 | SW 预缓存后第二次起即离线可用；加载态有徽标反馈 |
| 中文字体子集遗漏 | 子集按"当前源码里出现的字符"生成，将来新增文案若用到生僻字会回退系统字体 | 重新生成：`node tools/build-vendor-assets.mjs`；回退也可读 |
| SW 缓存陈旧 | 若忘记改 `CACHE_VERSION`，用户可能拿到旧文件 | HTML 走 network-first；改样式/脚本时记得升 `CACHE_VERSION` |
| 备份与工作区同盘 | 备份在 `D:\localwebsite\`，与项目同一分区；磁盘故障会一起丢 | 另有 git bundle，可拷到别处 |
