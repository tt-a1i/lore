/**
 * createGraphStore — 图谱存储工厂。
 *
 * 优先 Kuzu（嵌入式高性能），原生绑定加载失败时降级到 JsonGraphStore 并在 stderr 提示。
 * 两个后端均实现 GraphStore 接口，调用方无感知差异。
 */

import type { GraphStore, GraphStoreFactory } from './types.js';
import { JsonGraphStore } from './json-store.js';

/**
 * 工厂函数：优先 kuzu，失败降级 json。
 *
 * 采用动态 import + try/catch 而非 createRequire 直接调，
 * 以便 TypeScript 编译时不需要 kuzu 的类型声明。
 * 实际的 createRequire 封装在 kuzu-store.ts 的 createKuzuStore() 中。
 */
export const createGraphStore: GraphStoreFactory = async (
  repoPath: string,
): Promise<GraphStore> => {
  // 默认 JSON：kuzu 0.11.3 的 NAPI 终结器在对象（QueryResult/Connection/Database）
  // 跨生命周期被 GC 时会 flaky 地 use-after-free（SIGSEGV 139），JS 侧无法根治。
  // 功能上两后端同接口同语义；当前图谱规模（数千节点）JSON 在毫秒级。
  // kuzu 作为实验后端保留：LORE_GRAPH_BACKEND=kuzu 启用，等上游修绑定再考虑切默认。
  let store: GraphStore | null = null;
  if (process.env['LORE_GRAPH_BACKEND'] === 'kuzu') {
    try {
      const mod = await import('./kuzu-store.js');
      store = mod.createKuzuStore(repoPath);
      process.stderr.write(
        '[lore] experimental kuzu backend enabled (known issue: flaky SIGSEGV at process exit on kuzu 0.11.3)\n',
      );
    } catch (err) {
      process.stderr.write(
        `[lore] kuzu native binding unavailable (${(err as Error).message}); falling back to JSON graph store.\n`,
      );
    }
  }

  if (!store) {
    store = new JsonGraphStore(repoPath);
  }

  await store.init();
  return store;
};
