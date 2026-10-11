# js/lib —— 引擎文件目录

本目录存放各个棋类的 **AI 引擎可执行文件**。棋盘规则不在这里：

| 子目录 / 文件 | 属于 | 是否入库 | 说明 |
| --- | --- | --- | --- |
| `stockfish.js` + `stockfish.wasm` | 国际象棋 | **是**（`.gitignore` 已显式反忽略） | Stockfish 19 Lite，GitHub Pages 上没有它就无法对弈，必须随仓库部署 |
| `godogpaw/` | 中国象棋 | **是** | godogpaw（Go/WASM），本地编译产物，上游没有现成 wasm |
| `pikafish/` | —— | —— | **已删除**（2026-10-11 清理：曾尝试接入，最终未用，无人引用） |

各引擎的细节看各自的 README：`godogpaw/README.md`、本文件下半部分（Stockfish）。

---

## 国际象棋：Stockfish

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `stockfish.js` | 21 KB | 引擎胶水脚本，由 Worker 通过 `importScripts` 加载 |
| `stockfish.wasm` | 1.7 MB | 引擎本体（WebAssembly），NNUE 权重已**内嵌**，无需额外 `.nnue` |

两个文件必须**同名且同目录**。引擎脚本按 `stockfish.wasm` 这个固定名字去
`self.location.pathname` 下取二进制，改名会导致加载失败。

### 来源与许可

Stockfish.js © Chess.com, LLC，**GPLv3**。
上游：<https://github.com/nmrugg/stockfish.js>，版本 v19.0.0，
构建变体 `stockfish-19-lite-single`（单线程 lite 版）。

选择 lite-single 的原因：

- 单文件 + WASM 共约 1.8 MB，而完整多线程版 WASM 约 94 MB，不适合塞进网页仓库
- 单线程版**不需要** COOP/COEP 跨域隔离响应头，普通静态托管即可运行
- 深度 10~14 的棋力对普通对手已经足够

完整许可证见 <https://github.com/nmrugg/stockfish.js/blob/master/Copying.txt>。

### 换成更强的引擎

把上游的完整版下载到本目录并改名为 `stockfish.js` + `stockfish.wasm` 即可，
页面代码无需改动：

```bash
# 完整多线程版：需要服务器发送 COOP/COEP 头才能多线程
curl -L -o stockfish.js     https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0/stockfish-19.js
curl -L -o stockfish.wasm   https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0/stockfish-19.wasm
```

注意：完整版约 94 MB，且 `setoption name Threads` 只有在跨域隔离环境下才生效。
若不配置响应头，请保持使用 lite 单线程版。

### 没安装引擎时的行为

`js/chess.js` 启动时用 `fetch(..., { method: 'HEAD' })` 探测 `js/lib/stockfish.js`：

- **探测不到** → 侧栏显示「缺少 Stockfish 引擎」引导卡，**无法对弈**
  （简易引擎已删除：棋力太弱，且曾因未同步局面走出非法着法）
- **探测到** → 走 UCI 协议调用 Stockfish，界面标注引擎名称与搜索深度

所以本目录缺少 Stockfish 时页面不会白屏，只是明确报错并给出下载入口，不做静默降级。

---

## 中国象棋：godogpaw

见 [`godogpaw/README.md`](godogpaw/README.md) —— 6 个桥接函数、坐标系、性能实测、
两个已知缺陷，以及"换引擎时怎么重新验证"。

**和 Stockfish 的关键差别**：godogpaw 的 wasm 是本地编译的，上游仓库
（<https://github.com/hmgle/godogpaw>）只提供 Go 源码，没有 release 好的 wasm。
所以它**必须入库**，`.gitignore` 里也做了显式反忽略。
