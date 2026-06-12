import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // kuzu 原生绑定：每次 rebuild 要开新 DB + DDL（秒级），且与 tinypool 的
    // worker 复用相性差（超时后悬挂的异步 close 会炸掉 IPC 通道）。
    // singleFork 串行单进程最稳；全套目前 <60s，可接受。
    testTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
