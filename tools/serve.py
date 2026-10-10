#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地静态服务器 —— 带跨域隔离响应头。

为什么需要它
------------
中国象棋页的 Pikafish 引擎（brianhliou/pikafish-wasm 构建）用到 pthread，
内部需要 SharedArrayBuffer，而 SharedArrayBuffer 只在**跨域隔离**的页面里可用。
跨域隔离要求服务器发两个响应头：

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

`python3 -m http.server` 不发这两个头，所以中国象棋页的引擎在它上面起不来
（症状是引擎线程一启动就报 SharedArrayBuffer 不可用 / 直接 unavailable）。
国际象棋页的 Stockfish 用的是单线程 lite 构建，不需要隔离，所以不受影响。

用法
----
    python tools/serve.py            # 默认 http://127.0.0.1:8000
    python tools/serve.py 8848       # 指定端口

然后浏览器打开 http://127.0.0.1:8000/

⚠ 跨域隔离对跨域资源更严格：CDN 上的脚本/字体必须自带 CORP 头，否则会被拦。
  若 Google Fonts / Iconify 加载失败，把下方 COEP 改成 'credentialless' 会宽松些。
"""

import functools
import http.server
import os
import socketserver
import sys

# COEP 取值：'require-corp' 最严格；'credentialless' 对 CDN 更友好
COEP = 'require-corp'

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class IsolatedHandler(http.server.SimpleHTTPRequestHandler):
    """在标准静态处理器上加跨域隔离响应头。"""

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', COEP)
        super().end_headers()

    def guess_type(self, path):
        # SimpleHTTPRequestHandler 认不出 wasm / nnue，这里补上
        if path.endswith('.wasm'):
            return 'application/wasm'
        if path.endswith('.nnue'):
            return 'application/octet-stream'
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # 只在出错时打印，正常的静态请求太吵
        status = str(args[1]) if len(args) > 1 else ''
        if status.startswith('4') or status.startswith('5'):
            super().log_message(fmt, *args)


def main():
    handler = functools.partial(IsolatedHandler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), handler) as httpd:
        print('摆摊 · 本地摊位  ->  http://127.0.0.1:%d/' % PORT)
        print('跨域隔离已开启（COOP: same-origin, COEP: %s）' % COEP)
        print('中国象棋页的 Pikafish 引擎依赖它；Ctrl+C 停止。')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n停。')


if __name__ == '__main__':
    main()