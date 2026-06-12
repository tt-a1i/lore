/**
 * 正确性核心：transcript 被清理后，`lore why` 的归因摘录从快照出（而非静默空）。
 *
 * 场景（建临时 repo + fixture transcript → 固化快照 → 删 transcript → why 命中快照）：
 *   1. 真实 git repo，提交一行代码（git blame 需要真 hash）。
 *   2. fixture transcript（jsonl）"产出"该编辑，写 .lore/report.json。
 *   3. 跑 scan 的摘录固化代码路径（computeExcerpts + writeSnapshot）→ .lore/excerpts.json。
 *   4. 删掉 transcript 文件（模拟 Claude Code 留存窗口清理）。
 *   5. why：实时 parse 落空，归因摘录改从快照出，形态不变。
 *
 * 对照组：快照也缺失时退化为无摘录（确认快照确实是兜底来源，而非别处偷来的）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { computeExcerpts } from '../../src/excerpts/compute.js';
import { writeSnapshot, loadSnapshot } from '../../src/excerpts/snapshot.js';
import { createWhyEngine } from '../../src/why/engine.js';
import { claudeCodeParser } from '../../src/parsers/claude-code.js';
import type { GraphStore, GraphData } from '../../src/graph/types.js';

// ── git temp repo helpers ────────────────────────────────────────────────────

function git(repoDir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-why-snap-'));
  tmpDirs.push(dir);
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function emptyStore(): GraphStore {
  return {
    backend: 'json',
    init: async () => {},
    rebuild: async (_d: GraphData) => {},
    whoProducedCommit: async () => [],
    fileHistory: async () => [],
    sessionsEditingFile: async () => [],
    exportAll: async () =>
      ({ sessions: [], commits: [], files: [], produced: [], touches: [], edited: [] } as GraphData),
    close: async () => {},
  };
}

/** Minimal Claude Code transcript that edits `relFile` from oldLine → newLine. */
function writeTranscript(
  dir: string,
  sessionId: string,
  cwd: string,
  relFile: string,
  userMsg: string,
  assistantMsg: string,
  oldLine: string,
  newLine: string,
): string {
  const absFile = `${cwd}/${relFile}`;
  const lines = [
    {
      type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd, gitBranch: 'main',
      version: '2.1.170', timestamp: '2026-06-01T11:00:00.000Z', isMeta: false,
      message: { role: 'user', content: userMsg },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd, gitBranch: 'main',
      version: '2.1.170', timestamp: '2026-06-01T11:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: assistantMsg },
          { type: 'tool_use', id: 'toolu_e1', name: 'Edit',
            input: { file_path: absFile, old_string: oldLine, new_string: newLine } },
        ],
        stop_reason: 'tool_use',
      },
    },
    {
      type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId, cwd, gitBranch: 'main',
      version: '2.1.170', timestamp: '2026-06-01T11:00:05.000Z', isMeta: false,
      toolUseResult: {
        type: 'update', filePath: absFile, content: `${newLine}\n`,
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          lines: [`-${oldLine}`, `+${newLine}`] }],
        originalFile: `${oldLine}\n`, userModified: false,
      },
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_e1', content: 'File updated successfully.', is_error: false },
      ] },
    },
  ];
  const p = join(dir, `${sessionId}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

/** Mirror of cmdScan's report write + step 6.5 snapshot固化. */
async function scanLike(repo: string, transcript: string, fullHash: string, relFile: string): Promise<number> {
  const parsed = await claudeCodeParser.parse(transcript);
  const editEvent = parsed.session.events.find((e) => e.kind === 'file-edit')!;
  mkdirSync(join(repo, '.lore'), { recursive: true });
  writeFileSync(
    join(repo, '.lore', 'report.json'),
    JSON.stringify({
      matches: [
        {
          commitHash: fullHash, filePath: relFile, sessionId: parsed.session.meta.sessionId,
          editSeqs: [editEvent.seq], sourcePath: transcript, matchedVia: 'content',
          matchedLines: 3, contentScore: 1, timeScore: 1, confidence: 0.95, evidence: [],
        },
      ],
    }),
    'utf8',
  );
  // The exact two calls cmdScan step 6.5 makes.
  const excerpts = await computeExcerpts(repo);
  await writeSnapshot(repo, excerpts);
  return editEvent.seq;
}

describe('why falls back to the excerpts snapshot when the transcript is gone', () => {
  it('serves attribution excerpts from .lore/excerpts.json after the transcript is deleted', async () => {
    const repo = initRepo();
    const newLine = 'function login(username: string, password: string): boolean {';

    writeFileSync(join(repo, 'auth.ts'), `${newLine}\n  return true;\n}\n`, 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'feat: add password param');
    const fullHash = git(repo, 'rev-parse', 'HEAD');

    const transcript = writeTranscript(
      repo, 'sess-edit', repo, 'auth.ts',
      'Add a password parameter to login.',
      "I'll update the function signature now.",
      'function login(username: string) {', newLine,
    );

    // "scan": write report + snapshot the excerpts.
    await scanLike(repo, transcript, fullHash, 'auth.ts');

    // Sanity: snapshot file exists and captured the commit.
    const snap = await loadSnapshot(repo);
    expect(snap).not.toBeNull();
    expect(snap!.byCommit[fullHash]).toBeDefined();

    // Simulate Claude Code clearing its retention window.
    unlinkSync(transcript);
    expect(existsSync(transcript)).toBe(false);

    // why: live parse now fails; excerpts must come from the snapshot.
    const engine = createWhyEngine(emptyStore(), claudeCodeParser);
    const result = await engine.why(repo, 'auth.ts', 1);

    expect(result.commit.hash).toBe(fullHash);
    expect(result.attributions).toHaveLength(1);
    const attr = result.attributions[0]!;
    // 形态不变：ConversationExcerpt 的字段齐全，锚点正确。
    expect(attr.excerpts.length).toBeGreaterThan(0);
    const userEx = attr.excerpts.find((e) => e.role === 'user');
    expect(userEx).toBeDefined();
    expect(userEx!.text).toContain('Add a password parameter');
    expect(userEx!.sessionId).toBe('sess-edit');
    expect(typeof userEx!.seq).toBe('number');
    expect(typeof userEx!.ts).toBe('string');
  });

  it('still serves live excerpts (not the snapshot) while the transcript exists', async () => {
    const repo = initRepo();
    const newLine = 'const live = 1;';
    writeFileSync(join(repo, 'live.ts'), `${newLine}\n`, 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add live');
    const fullHash = git(repo, 'rev-parse', 'HEAD');

    const transcript = writeTranscript(
      repo, 'sess-live', repo, 'live.ts',
      'Add the live constant.', 'Adding it.', 'const live = 0;', newLine,
    );
    await scanLike(repo, transcript, fullHash, 'live.ts');

    // transcript intact: why works via live parse.
    const engine = createWhyEngine(emptyStore(), claudeCodeParser);
    const result = await engine.why(repo, 'live.ts', 1);
    expect(result.attributions[0]!.excerpts.find((e) => e.role === 'user')!.text)
      .toContain('Add the live constant');
  });

  it('without a snapshot, a deleted transcript yields no excerpts (snapshot is the source)', async () => {
    const repo = initRepo();
    const newLine = 'const nosnap = 1;';
    writeFileSync(join(repo, 'nosnap.ts'), `${newLine}\n`, 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add nosnap');
    const fullHash = git(repo, 'rev-parse', 'HEAD');

    const transcript = writeTranscript(
      repo, 'sess-nosnap', repo, 'nosnap.ts',
      'Add nosnap.', 'ok', 'const nosnap = 0;', newLine,
    );
    // Write the report but DO NOT snapshot.
    const parsed = await claudeCodeParser.parse(transcript);
    const editEvent = parsed.session.events.find((e) => e.kind === 'file-edit')!;
    mkdirSync(join(repo, '.lore'), { recursive: true });
    writeFileSync(
      join(repo, '.lore', 'report.json'),
      JSON.stringify({
        matches: [{
          commitHash: fullHash, filePath: 'nosnap.ts', sessionId: 'sess-nosnap',
          editSeqs: [editEvent.seq], sourcePath: transcript, matchedVia: 'content',
          matchedLines: 3, contentScore: 1, timeScore: 1, confidence: 0.95, evidence: [],
        }],
      }),
      'utf8',
    );

    unlinkSync(transcript);

    const engine = createWhyEngine(emptyStore(), claudeCodeParser);
    const result = await engine.why(repo, 'nosnap.ts', 1);
    // Attribution still present (from report), but excerpts empty — no snapshot to fall back to.
    expect(result.attributions).toHaveLength(1);
    expect(result.attributions[0]!.excerpts).toEqual([]);
  });
});
