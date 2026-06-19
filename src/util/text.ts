/**
 * 文本工具集 —— 整个仓库共享，避免在 4 个文件各自实现 truncate。
 *
 * 设计取舍：truncate 接口故意与既有四份实现保持一致——尾部 ellipsis（`…`）、
 * trim 输入、长度阈值用 `<= max` 不截。任何调用方迁移过来都不会改变行为。
 */

/**
 * 截断字符串到 max 字符（含末尾 ellipsis），超出则尾部加 `…`。
 * 输入会先 trim——四个原实现里有三个都 trim 了，统一行为。
 *
 *   truncate('hello world', 5)  // 'hell…'
 *   truncate('  hi  ', 10)      // 'hi'
 *   truncate('exact', 5)        // 'exact'
 */
export function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/**
 * 双向前缀匹配：a 是 b 的前缀，或 b 是 a 的前缀（大小写不敏感）。
 * 主要用于 commit hash 比较——transcript 给短 hash（7 位），git 给全 hash（40 位）。
 *
 *   prefixMatch('abc1234567', 'abc12')  // true
 *   prefixMatch('abc12', 'abc1234567')  // true
 *   prefixMatch('abc', 'def')           // false
 *   prefixMatch('', 'x')                // false  （空串视为无效）
 */
export function prefixMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}
