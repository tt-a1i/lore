import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dim, green, red } from '../ui.js';

/**
 * 推送式记忆模块（brief/guard）。惰性 import：只在 brief/guard 路径加载，
 * 不拖累其它命令（更重要的是不拖累钩子启动延迟——这些模块零重依赖，
 * 不碰匹配引擎/graph/parser）。
 */
async function loadBrief(): Promise<{
  renderBrief: typeof import('../../brief/render.js').renderBrief;
  readGeneratedAt: typeof import('../../brief/load.js').readGeneratedAt;
  readActiveNotes: typeof import('../../brief/load.js').readActiveNotes;
  readHeadTime: typeof import('../../brief/load.js').readHeadTime;
  detectLoreMcp: typeof import('../../brief/load.js').detectLoreMcp;
  parseHookInput: typeof import('../../brief/hook.js').parseHookInput;
  extractFilePath: typeof import('../../brief/hook.js').extractFilePath;
  sessionStartEnvelope: typeof import('../../brief/hook.js').sessionStartEnvelope;
  preToolUseEnvelope: typeof import('../../brief/hook.js').preToolUseEnvelope;
}> {
  const [render, load, hook] = await Promise.all([
    import('../../brief/render.js'),
    import('../../brief/load.js'),
    import('../../brief/hook.js'),
  ]);
  return {
    renderBrief: render.renderBrief,
    readGeneratedAt: load.readGeneratedAt,
    readActiveNotes: load.readActiveNotes,
    readHeadTime: load.readHeadTime,
    detectLoreMcp: load.detectLoreMcp,
    parseHookInput: hook.parseHookInput,
    extractFilePath: hook.extractFilePath,
    sessionStartEnvelope: hook.sessionStartEnvelope,
    preToolUseEnvelope: hook.preToolUseEnvelope,
  };
}

/**
 * `lore brief` —— 紧凑项目记忆简报。推送式记忆的 SessionStart 注入源。
 *
 * 性能契约 <150ms：只读 .lore/notes.json + report.json 的 generatedAt，外加
 * 一次 `git log -1`。绝不加载匹配引擎/graph/parser（loadBrief 模块零重依赖）。
 *
 * --format text     人读文本（默认）。
 * --format hook-json  SessionStart hookSpecificOutput.additionalContext 信封。
 * --file <f>        只输出与该文件相关的约束。
 */
export async function cmdBrief(opts: {
  repo: string;
  file?: string;
  format?: string;
}): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const b = await loadBrief();

  // 并发读三个来源——三者互不依赖，省往返。
  const [generatedAt, notes, headTime, hasMcp] = await Promise.all([
    b.readGeneratedAt(repoPath),
    b.readActiveNotes(repoPath),
    b.readHeadTime(repoPath),
    b.detectLoreMcp(repoPath),
  ]);

  const briefInput = {
    repoPath,
    generatedAt,
    headTime,
    nowMs: Date.now(),
    notes,
    hasMcp,
    ...(opts.file ? { file: opts.file } : {}),
  };
  const text = b.renderBrief(briefInput);

  if (opts.format === 'hook-json') {
    // SessionStart 信封。注意：即便文本为空也输出有效 JSON（钩子不报错）。
    console.log(b.sessionStartEnvelope(text));
    return;
  }
  console.log(text);
}

/**
 * `lore guard --hook` —— 专为 PreToolUse 钩子设计。
 *
 * 从 stdin 读 hook 协议 JSON（tool_input.file_path），找该文件的活跃约束：
 *   - 有 → PreToolUse additionalContext 信封注入（不带 permissionDecision，绝不 block）。
 *   - 无约束 / stdin 非 JSON / .lore 缺失 → 静默 exit 0（钩子绝不搞挂 session）。
 *
 * 容错铁律：任何异常都吞掉、静默 exit 0。同 <150ms 预算。
 */
export async function cmdGuard(opts: { repo: string }): Promise<void> {
  // 读 stdin（hook 协议 JSON）。读不到 / 出错 → 静默退出。
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    return; // 读 stdin 失败 → 静默
  }

  let b: Awaited<ReturnType<typeof loadBrief>>;
  try {
    b = await loadBrief();
  } catch {
    return; // 模块加载失败 → 静默（绝不报错给钩子）
  }

  const input = b.parseHookInput(raw);
  if (!input) return; // 非 JSON / 空 → 静默

  const filePath = b.extractFilePath(input);
  if (!filePath) return; // 没有被编辑文件 → 静默

  // repo 优先用 --repo；否则退回 hook 输入里的 cwd；再退回当前 cwd。
  const repoPath = path.resolve(
    opts.repo && opts.repo !== '.' ? opts.repo
      : (typeof input.cwd === 'string' && input.cwd ? input.cwd : '.'),
  );

  let notes: Awaited<ReturnType<typeof b.readActiveNotes>>;
  try {
    notes = await b.readActiveNotes(repoPath);
  } catch {
    return; // 读 notes 失败 → 静默
  }
  if (notes.length === 0) return; // 无 notes → 静默

  // 渲染 file-scoped 约束（renderBrief 在 file 模式下省略 freshness 头之外的指引）。
  // guard 只要「与该文件相关的约束」本身——给 renderBrief 传 file，并丢掉新鲜度行
  // 之外不必要的噪声：我们用 file 模式，但若该文件无相关约束则静默。
  const { noteRelatedToFile } = await import('../../brief/render.js');
  const relevant = notes.filter((n) => noteRelatedToFile(n, filePath, repoPath));
  if (relevant.length === 0) return; // 该文件无相关约束 → 静默

  const text = b.renderBrief({
    repoPath,
    generatedAt: null,
    headTime: null,
    nowMs: Date.now(),
    notes: relevant,
    hasMcp: false,
    file: filePath,
    suppressFreshness: true, // guard 不渲新鲜度行（保最短）——纯 file-scoped 约束
  });

  // PreToolUse 信封——永远放行，只注入上下文。
  console.log(b.preToolUseEnvelope(text));
}

/** 读 process.stdin 全文（hook 协议）。非 TTY 才读；TTY 立即返回空串。 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve, reject) => {
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Read a Claude Code settings.json (tolerates missing file → returns {}).
 * Returns { data, raw } where raw is the original file text (for diagnostics).
 * Throws if the file exists but cannot be JSON-parsed.
 */
async function readSettingsJson(settingsPath: string): Promise<{
  data: Record<string, unknown>;
  existed: boolean;
}> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    try {
      return { data: JSON.parse(raw) as Record<string, unknown>, existed: true };
    } catch {
      throw new Error(`${settingsPath}: JSON parse failed — aborting to avoid corruption`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { data: {}, existed: false };
    }
    throw e;
  }
}

/** Atomic write: write to tmp then rename. */
async function writeSettingsJson(settingsPath: string, data: unknown): Promise<void> {
  const tmp = settingsPath + '.lore-tmp-' + Date.now().toString(36);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, settingsPath);
}

/** The command string injected into Stop hooks. */
function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const HOOK_MARKER = 'LORE_HOOK=1';

function hookCommand(repoPath: string): string {
  return `${HOOK_MARKER} ${loreRunPrefix()} scan --repo ${shellQuote(repoPath)} --broad >/dev/null 2>&1 || true`;
}

/**
 * 解析「跑 lore CLI」的命令前缀，用于 SessionStart/PreToolUse 钩子。
 *
 * 性能要求：钩子在每次 session 启动 / 每次 Edit 前都跑，启动延迟敏感。
 * 优先用 `node <绝对 dist/cli.js>`（零 npx 解析延迟）；若当前进程不是从 dist 跑的
 * （如开发态 tsx），退回 `npx -y @tt-a1i/lore`（保证可用，牺牲启动速度）。
 */
function loreRunPrefix(): string {
  try {
    const self = _resolveReal(fileURLToPath(import.meta.url));
    const cliEntry = findDistCliEntry(self);
    if (cliEntry !== null) {
      return `${shellQuote(process.execPath)} ${shellQuote(cliEntry)}`;
    }
  } catch {
    // 落到 npx 兜底。
  }
  return 'npx -y @tt-a1i/lore';
}

function findDistCliEntry(realPath: string): string | null {
  if (!realPath.endsWith('.js')) return null;
  const parts = realPath.split(path.sep);
  const distIdx = parts.lastIndexOf('dist');
  if (distIdx === -1) return null;
  const distDir = parts.slice(0, distIdx + 1).join(path.sep) || path.sep;
  const cliEntry = _resolveReal(path.join(distDir, 'cli.js'));
  return fssync.existsSync(cliEntry) ? cliEntry : null;
}

function _resolveReal(p: string): string {
  try {
    return fssync.realpathSync(p);
  } catch {
    return p;
  }
}

/** SessionStart 钩子命令：注入项目简报（hook-json 信封）。 */
function sessionStartCommand(repoPath: string): string {
  return `${HOOK_MARKER} ${loreRunPrefix()} brief --repo ${shellQuote(repoPath)} --format hook-json 2>/dev/null || true`;
}

/** PreToolUse 钩子命令：注入被编辑文件的相关约束（绝不 block）。 */
function preToolUseCommand(repoPath: string): string {
  return `${HOOK_MARKER} ${loreRunPrefix()} guard --hook --repo ${shellQuote(repoPath)} 2>/dev/null || true`;
}

interface HookEntry {
  type: string;
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

/** PreToolUse 钩子的 matcher：仅在写文件类工具上触发。 */
const GUARD_MATCHER = 'Edit|Write|MultiEdit';

/**
 * 三钩规格：event → { matcher, command }。install/uninstall 共用同一份清单，
 * 保证两端对称（uninstall 移除的正是 install 装的）。
 */
function hookSpecs(repoPath: string): {
  event: string;
  matcher: string;
  command: string;
}[] {
  return [
    { event: 'SessionStart', matcher: '', command: sessionStartCommand(repoPath) },
    { event: 'PreToolUse', matcher: GUARD_MATCHER, command: preToolUseCommand(repoPath) },
    { event: 'Stop', matcher: '', command: hookCommand(repoPath) },
  ];
}

/**
 * 把一条 (event, matcher, command) 幂等地装进 settings.hooks。
 * 返回 true=新装，false=已存在（按 command 字面相等判定，不重复追加）。
 *
 * 注意：guard/brief 命令含 loreRunPrefix()（可能是绝对 node 路径），幂等判定按
 * 完整 command 字符串相等。若 dist 路径变了（如 npm 全局升级），旧 command 不匹配，
 * 会并存——uninstall 用「event+repo 关键片段」宽松匹配清掉残留（见 removeHookSpec）。
 */
function installHookSpec(
  hooks: Record<string, unknown>,
  event: string,
  matcher: string,
  command: string,
): boolean {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  const list = hooks[event] as HookMatcher[];
  const exists = list.some(
    (m) => Array.isArray(m.hooks) && m.hooks.some((h) => h.command === command),
  );
  if (exists) return false;
  list.push({ matcher, hooks: [{ type: 'command', command }] });
  return true;
}

/**
 * 从 settings.hooks 移除某 event 下属于本 repo 的 lore 钩子。
 * 宽松匹配：command 同时含 lore hook marker（或旧版 lore CLI 形态）+
 * 该 repoPath（原文或 shell-quoted 形式）+ lore 子命令，即视为本 repo 的 lore 钩子，
 * 不论前缀是 `node …/dist/cli.js` 还是 `npx -y @tt-a1i/lore`（容忍升级导致的路径漂移）。
 * 返回移除条数。
 */
function commandLooksLikeLoreHook(cmd: string): boolean {
  return (
    cmd.includes(HOOK_MARKER) ||
    cmd.includes('@tt-a1i/lore') ||
    cmd.includes('npx -y lore') ||
    cmd.includes('/dist/cli.js') ||
    cmd.includes('\\dist\\cli.js')
  );
}

function removeHookSpec(
  hooks: Record<string, unknown>,
  event: string,
  repoPath: string,
  subcommand: string,
): number {
  if (!Array.isArray(hooks[event])) return 0;
  const list = hooks[event] as HookMatcher[];
  let removed = 0;
  const quotedRepoPath = shellQuote(repoPath);
  const filtered = list
    .map((m) => {
      if (!Array.isArray(m.hooks)) return m;
      const kept = m.hooks.filter((h) => {
        const cmd = h.command ?? '';
        const isLoreForRepo =
          commandLooksLikeLoreHook(cmd) &&
          (cmd.includes(repoPath) || cmd.includes(quotedRepoPath)) &&
          cmd.includes(subcommand);
        if (isLoreForRepo) { removed++; return false; }
        return true;
      });
      return { ...m, hooks: kept };
    })
    .filter((m) => Array.isArray(m.hooks) && m.hooks.length > 0);
  hooks[event] = filtered;
  return removed;
}

/** 解析 install/uninstall 的 settings.json 路径（--global → ~/.claude）。 */
function resolveSettingsPath(repoPath: string, global?: boolean): string {
  if (global) {
    const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
    if (!homeDir) {
      console.error(`${red('Error:')} cannot determine home directory for --global flag`);
      process.exit(1);
    }
    return path.join(homeDir, '.claude', 'settings.json');
  }
  return path.join(repoPath, '.claude', 'settings.json');
}

export async function cmdHookInstall(opts: { repo: string; global?: boolean }): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const settingsPath = resolveSettingsPath(repoPath, opts.global);

  let data: Record<string, unknown>;
  try {
    const result = await readSettingsJson(settingsPath);
    data = result.data;
  } catch (e) {
    console.error(`${red('Error:')} ${String(e)}`);
    process.exit(1);
  }

  // hooks 对象——缺则建，其它 key 不动。
  if (typeof data['hooks'] !== 'object' || data['hooks'] === null) {
    data['hooks'] = {};
  }
  const hooks = data['hooks'] as Record<string, unknown>;

  // 三钩幂等安装：SessionStart(brief) + PreToolUse(guard) + Stop(scan refresh)。
  const specs = hookSpecs(repoPath);
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const spec of specs) {
    const added = installHookSpec(hooks, spec.event, spec.matcher, spec.command);
    if (added) installed.push(spec.event);
    else skipped.push(spec.event);
  }

  if (installed.length === 0) {
    console.log(`${dim('–')} all hooks already installed in: ${settingsPath}`);
    console.log(`  (SessionStart + PreToolUse + Stop present — no changes made)`);
    return;
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  try {
    await writeSettingsJson(settingsPath, data);
  } catch (e) {
    console.error(`${red('Error:')} failed to write ${settingsPath}: ${String(e)}`);
    process.exit(1);
  }

  console.log(`${green('✓')} lore hooks installed: ${settingsPath}`);
  console.log(`  ${green('SessionStart')} → inject project-memory brief at session start`);
  console.log(`  ${green('PreToolUse')}   → inject file constraints before Edit/Write/MultiEdit`);
  console.log(`  ${green('Stop')}         → auto-refresh lore index at session end`);
  console.log(`  repo: ${repoPath}`);
  if (skipped.length > 0) {
    console.log(`  ${dim('(' + skipped.join(', ') + ' already present)')}`);
  }
}

export async function cmdHookUninstall(opts: { repo: string; global?: boolean }): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const settingsPath = resolveSettingsPath(repoPath, opts.global);

  let data: Record<string, unknown>;
  let existed: boolean;
  try {
    const result = await readSettingsJson(settingsPath);
    data = result.data;
    existed = result.existed;
  } catch (e) {
    console.error(`${red('Error:')} ${String(e)}`);
    process.exit(1);
  }

  if (!existed) {
    console.log(`${dim('–')} settings file not found: ${settingsPath}  (nothing to remove)`);
    return;
  }

  const hooksObj = data['hooks'];
  if (typeof hooksObj !== 'object' || hooksObj === null) {
    console.log(`${dim('–')} no hooks found in: ${settingsPath}  (nothing to remove)`);
    return;
  }
  const hooks = hooksObj as Record<string, unknown>;

  // 三钩全移除（按 event + repo + 子命令宽松匹配，容忍前缀路径漂移）。
  let removed = 0;
  removed += removeHookSpec(hooks, 'SessionStart', repoPath, 'brief');
  removed += removeHookSpec(hooks, 'PreToolUse', repoPath, 'guard');
  removed += removeHookSpec(hooks, 'Stop', repoPath, 'scan');

  if (removed === 0) {
    console.log(`${dim('–')} no lore hooks found in: ${settingsPath}  (nothing to remove)`);
    return;
  }

  try {
    await writeSettingsJson(settingsPath, data);
  } catch (e) {
    console.error(`${red('Error:')} failed to write ${settingsPath}: ${String(e)}`);
    process.exit(1);
  }

  console.log(`${green('✓')} lore hooks removed from: ${settingsPath}  (${removed} hook${removed === 1 ? '' : 's'})`);
  console.log(`  Push-based memory + auto-refresh for ${repoPath} is now disabled.`);
}
