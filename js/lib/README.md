# js/lib —— 引擎文件目录

本目录存放**国际象棋 AI 引擎**的可执行文件。棋盘规则不在这里（规则由
`js/chess-engine/chess.js` 负责），这里只有「负责想棋」的引擎。

## 当前文件

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `stockfish.js` | 21 KB | 引擎胶水脚本，由 Worker 通过 `importScripts` 加载 |
| `stockfish.wasm` | 1.7 MB | 引擎本体（WebAssembly），NNUE 权重已**内嵌**，无需额外的 `.nnue` |

两个文件必须**同名且同目录**。引擎脚本按 `stockfish.wasm` 这个固定名字去
`self.location.pathname` 下取二进制，改名会导致加载失败。

## 来源与许可

Stockfish.js © Chess.com, LLC，**GPLv3**。
上游：<https://github.com/nmrugg/stockfish.js>，版本 v19.0.0，
构建变体 `stockfish-19-lite-single`（单线程 lite 版）。

选择 lite-single 的原因：

- 单文件 + WASM 共约 1.8 MB，而完整多线程版 WASM 约 94 MB，不适合塞进网页仓库
- 单线程版**不需要** COOP/COEP 跨域隔离响应头，普通静态托管即可运行
- 深度 10~14 的棋力对普通对弈已经足够

完整许可证见 <https://github.com/nmrugg/stockfish.js/blob/master/Copying.txt>。

## 换成更强的引擎

想要更强的棋力，把上游的完整版下载到本目录并改名为 `stockfish.js` +
`stockfish.wasm` 即可，页面代码无需改动：

```bash
# 完整多线程版：需要服务器发送 COOP/COEP 头才能多线程
curl -L -o stockfish.js     https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0/stockfish-19.js
curl -L -o stockfish.wasm   https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0/stockfish-19.wasm
```

注意：完整版约 94 MB，且 `setoption name Threads` 只有在跨域隔离环境下才生效。
若不配置响应头，请保持使用 lite 单线程版。

## 未安装引擎时的行为

`js/chess.js` 启动时用 `fetch(..., { method: 'HEAD' })` 探测 `js/lib/stockfish.js`：

- **探测不到** → 侧栏显示「安装引擎」引导卡，对局仍可进行，
  AI 退回到 `js/chess-engine/eval.js` 里的纯 JS 兼底引擎（强度较弱，界面会标注）
- **探测到** → 走 UCI 协议调用 Stockfish，界面标注引擎名称与搜索深度

因此本目录为空时页面不会白屏，只是棋力变弱。
