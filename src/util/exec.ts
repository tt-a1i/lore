/**
 * 进程执行工具 —— 全仓共享一份 promisify(execFile)，避免 5+ 处重复 `const execFileAsync = promisify(execFile);`。
 *
 * 类型保持与原生一致——any caller can `import { execFileAsync } from '../util/exec.js';`
 * 直接替换。
 *
 * 不暴露 spawn / exec：那些用法各处差异较大（流式、shell 兼容），抽象会泄漏。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** promisify(execFile) 单例。 */
export const execFileAsync = promisify(execFile);
