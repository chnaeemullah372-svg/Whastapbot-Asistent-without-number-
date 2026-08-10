#!/bin/sh
# Increase file descriptor limit to prevent EMFILE errors with WhatsApp WebSocket
ulimit -n 65536 2>/dev/null || ulimit -n 16384 2>/dev/null || ulimit -n 4096 2>/dev/null || true

# Increase libuv thread pool for DNS/async operations
export UV_THREADPOOL_SIZE=32

exec node --enable-source-maps artifacts/api-server/dist/index.mjs
