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
  // Try to load kuzu dynamically; if the native binding is absent, fall back.
  let store: GraphStore | null = null;
  try {
    // Dynamic import keeps kuzu-store.ts out of the bundle on platforms without kuzu
    const mod = await import('./kuzu-store.js');
    store = mod.createKuzuStore(repoPath);
  } catch (err) {
    process.stderr.write(
      `[lore] kuzu native binding unavailable (${(err as Error).message}); falling back to JSON graph store.\n`,
    );
  }

  if (!store) {
    store = new JsonGraphStore(repoPath);
  }

  await store.init();
  return store;
};
