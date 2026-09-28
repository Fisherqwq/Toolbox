# 五子棋 · Gomoku

纯静态单页五子棋对弈应用，内置本地 AI 引擎，**无需联网、无需后端、无任何依赖**。

## 特性

- **本地 AI 引擎**：Minimax + α-β 剪枝 + 迭代加深 + VCT/VCF 算杀，运行在 Web Worker 中，完全不阻塞界面
- **三档难度**（实测标定耗时，AI 思考不再卡顿）：
  - 简单：深度 2 · 无算杀（~0.05s/步）
  - 中等：深度 4 · VCT 算杀 8 层（~1.5s/步）
  - 困难：深度 6 · VCT 算杀 8 层（最强算力，不考虑耗时）
- **对局体验**：悔棋、新对局、手数统计、战绩记录（localStorage 本地保存）
- **精致棋盘**：木纹棋盘、A–O / 1–15 坐标、最后一手标记、获胜连线高亮、落子动画、悬停预览
- **响应式布局**：桌面左右分栏，移动端自动堆叠，支持触屏
- **无障碍**：支持 `prefers-reduced-motion`，语义化标签与 `aria` 属性
- 高分屏（Retina）适配，棋盘按 devicePixelRatio 渲染

## 运行

页面使用 ES Module Worker，**需要通过 HTTP 服务访问**（直接双击 `file://` 打开无法加载 AI 引擎）：

```bash
cd gomoku
python3 -m http.server 8000
# 或
npx serve .
```

然后访问 <http://localhost:8000>。

## 目录结构

```
gomoku/
├── index.html              # 单页入口
├── css/style.css           # 深色雅致主题
└── js/
    ├── gomoku.js           # 界面逻辑：渲染 / 交互 / 动画 / 状态
    ├── gomoku-worker.js    # AI Worker（消息协议 + 对局代数防竞态）
    └── gomoku-engine/      # AI 引擎（Minimax + VCT/VCF）
        ├── board.js        # 棋盘：落子 / 悔棋 / Zobrist 哈希
        ├── eval.js         # 增量评分器：棋型识别 + 候选点生成
        ├── shape.js        # 棋型模式匹配（连五/活四/冲四/活三…）
        ├── minmax.js       # 搜索主体：α-β 剪枝 + 迭代加深 + VCT/VCF
        ├── zobrist.js      # Zobrist 哈希（置换表键）
        ├── cache.js        # 置换表缓存
        ├── position.js     # 坐标转换 / 同线判定
        └── config.js       # 搜索参数配置
```

## 相较原版 Toolbox 的改动

1. **只保留五子棋**：移除加密工具、设备指纹、幸运值及象棋/国象占位页
2. **修复致命 Bug**：`minmax.js` 的 `import "./cache"` 缺少 `.js` 扩展名，浏览器无法解析 ES Module，原版 AI 实际无法启动
3. **修复崩溃 Bug**：`minmax` 包装层未判空——迭代加深只搜偶数层，奇数深度下 `_minmax` 返回 `move=null`，随后 `board.put(move[0], …)` 直接 TypeError
4. **修复性能陷阱**：原版 VCT 算杀深度固定为 `depth+8`，中等局面单步可达 12~40 秒；现支持自定义算杀深度并实测标定三档难度（同局面下 VCT8 与 VCT12 选点完全一致，耗时 1.5s vs 12s）
5. **修复竞态**：新增对局代数（generation），重开对局后丢弃过期的 AI 计算结果
6. **修复泄漏**：`init()` 增加一次性守卫，不再重复创建 Worker / 重复绑定事件
7. **移除调试输出**：搜索根节点的 `console.log` 刷屏
8. **离线可用**：移除 Google Fonts 依赖，改用系统字体栈
9. **全新 UI**：深色主题 + 木纹棋盘 + 玻璃卡片 + 动效，新增难度选择、悔棋、战绩

## License

MIT
