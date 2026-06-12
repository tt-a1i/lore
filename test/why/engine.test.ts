/**
 * WhyEngine 全管线测试。
 *
 * - 用 os.tmpdir() 起一个真实的临时 git 仓库（git blame 需要真 git）。
 * - 手工构造一份 fixture transcript（jsonl），不读真实 ~/.claude。
 * - GraphStore 用内存实现注入（不依赖 kuzu/json 具体后端）。
 * - 走通 blame → report.json candidate → parse sourcePath → 摘录 全链路。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createWhyEngine } from '../../src/why/engine.js';
import { claudeCodeParser } from '../../src/parsers/claude-code.js';
import type { GraphStore, GraphData, ProducedInfo, CommitNodeData } from '../../src/graph/types.js';
import type { SessionNodeData, EditedEdgeData } from '../../src/graph/types.js';
import type { LoreReportFileShape } from './helpers.js';

// ── git temp repo helpers ────────────────────────────────────────────────────

function git(repoDir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-why-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function writeRepoFile(repoDir: string, relPath: string, content: string): void {
  const full = join(repoDir, relPath);
  const dirPart = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dirPart, { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function commitAll(repoDir: string, message: string): string {
  git(repoDir, 'add', '-A');
  execFileSync('git', ['-C', repoDir, 'commit', '-m', message], { encoding: 'utf8' });
  return git(repoDir, 'rev-parse', 'HEAD');
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

function makeRepo(): string {
  const dir = initRepo();
  tmpDirs.push(dir);
  return dir;
}

// ── in-memory GraphStore (only the methods why() touches) ────────────────────

function fakeStore(opts: {
  produced?: Record<string, ProducedInfo[]>;
  editors?: Record<string, { session: SessionNodeData; edge: EditedEdgeData }[]>;
}): GraphStore {
  return {
    backend: 'json',
    init: async () => {},
    rebuild: async (_d: GraphData) => {},
    whoProducedCommit: async (hash: string) => opts.produced?.[hash] ?? [],
    fileHistory: async () => [],
    sessionsEditingFile: async (path: string) => opts.editors?.[path] ?? [],
    exportAll: async () =>
      ({ sessions: [], commits: [], files: [], produced: [], touches: [], edited: [] } as GraphData),
    close: async () => {},
  };
}

// ── fixture transcript ───────────────────────────────────────────────────────

/**
 * Build a minimal Claude Code transcript that edits `relFile` with `addedLine`.
 * Mirrors fixtures/claude-code/edit-tool.jsonl shape.
 * Returns the absolute transcript path; the parser will assign seq numbers.
 */
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
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId,
      cwd,
      gitBranch: 'main',
      version: '2.1.170',
      timestamp: '2026-06-01T11:00:00.000Z',
      isMeta: false,
      message: { role: 'user', content: userMsg },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId,
      cwd,
      gitBranch: 'main',
      version: '2.1.170',
      timestamp: '2026-06-01T11:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: assistantMsg },
          {
            type: 'tool_use',
            id: 'toolu_e1',
            name: 'Edit',
            input: { file_path: absFile, old_string: oldLine, new_string: newLine },
          },
        ],
        stop_reason: 'tool_use',
        model: 'claude-sonnet-4-5',
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      sessionId,
      cwd,
      gitBranch: 'main',
      version: '2.1.170',
      timestamp: '2026-06-01T11:00:05.000Z',
      isMeta: false,
      toolUseResult: {
        type: 'update',
        filePath: absFile,
        content: `${newLine}\n`,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [`-${oldLine}`, `+${newLine}`],
          },
        ],
        originalFile: `${oldLine}\n`,
        userModified: false,
      },
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_e1', content: 'File updated successfully.', is_error: false },
        ],
      },
    },
  ];
  const transcriptPath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return transcriptPath;
}

function writeReport(repoDir: string, report: LoreReportFileShape): void {
  const loreDir = join(repoDir, '.lore');
  mkdirSync(loreDir, { recursive: true });
  writeFileSync(join(loreDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
}

function commitNode(hash: string, subject: string): CommitNodeData {
  return {
    hash,
    subject,
    authorDate: '2026-06-01T12:00:00.000Z',
    committerDate: '2026-06-01T12:00:00.000Z',
    isMerge: false,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('WhyEngine.why — full pipeline', () => {
  it('traces a committed line back to its conversation excerpts', async () => {
    const repo = makeRepo();
    const newLine = 'function login(username: string, password: string): boolean {';

    // commit the file so blame has a hash
    writeRepoFile(repo, 'src/auth.ts', `${newLine}\n  return true;\n}\n`);
    const fullHash = commitAll(repo, 'feat: add password param');

    // fixture transcript that "produced" the edit
    const transcript = writeTranscript(
      repo,
      'sess-edit',
      repo,
      'src/auth.ts',
      'Add a password parameter to login.',
      "I'll update the function signature now.",
      'function login(username: string) {',
      newLine,
    );

    // parse it to learn the seq of the file-edit (engine re-parses by sourcePath)
    const parsed = await claudeCodeParser.parse(transcript);
    const editEvent = parsed.session.events.find((e) => e.kind === 'file-edit')!;

    // report.json with one strong candidate
    writeReport(repo, {
      matches: [
        {
          commitHash: fullHash,
          filePath: 'src/auth.ts',
          sessionId: 'sess-edit',
          editSeqs: [editEvent.seq],
          sourcePath: transcript,
          matchedVia: 'content',
          matchedLines: 3,
          contentScore: 1,
          timeScore: 1,
          confidence: 0.95,
          evidence: [],
        },
      ],
    });

    const store = fakeStore({
      produced: {
        [fullHash]: [
          {
            sessionId: 'sess-edit',
            commitHash: fullHash,
            confidence: 0.95,
            matchedVia: 'content',
            sourcePath: transcript,
            matchedLines: 3,
            fileCount: 1,
            session: {
              id: 'sess-edit',
              agent: 'claude-code',
              startedAt: '2026-06-01T11:00:00.000Z',
              endedAt: '2026-06-01T11:00:05.000Z',
              cwd: repo,
              gitBranch: 'main',
              sourcePaths: [transcript],
            },
          },
        ],
      },
    });

    const engine = createWhyEngine(store, claudeCodeParser);
    const result = await engine.why(repo, 'src/auth.ts', 1);

    expect(result.commit.hash).toBe(fullHash);
    expect(result.commit.subject).toBe('feat: add password param');
    expect(result.lineContent).toBe(newLine);
    expect(result.attributions).toHaveLength(1);

    const attr = result.attributions[0]!;
    expect(attr.produced.sessionId).toBe('sess-edit');
    expect(attr.produced.confidence).toBe(0.95);
    expect(attr.editSeqs).toEqual([editEvent.seq]);

    // excerpts: nearest user + assistant messages around the edit
    const userExcerpt = attr.excerpts.find((e) => e.role === 'user');
    const asstExcerpt = attr.excerpts.find((e) => e.role === 'assistant');
    expect(userExcerpt?.text).toContain('Add a password parameter');
    expect(asstExcerpt?.text).toContain('update the function signature');
    // anchors carry sessionId + seq
    expect(userExcerpt?.sessionId).toBe('sess-edit');
    expect(typeof userExcerpt?.seq).toBe('number');
  });

  it('truncates excerpts to 400 characters', async () => {
    const repo = makeRepo();
    const newLine = 'const answer = 42;';
    writeRepoFile(repo, 'a.ts', `${newLine}\n`);
    const fullHash = commitAll(repo, 'add answer');

    const longUser = 'X'.repeat(900);
    const transcript = writeTranscript(
      repo,
      'sess-long',
      repo,
      'a.ts',
      longUser,
      'short assistant',
      'const answer = 0;',
      newLine,
    );
    const parsed = await claudeCodeParser.parse(transcript);
    const editEvent = parsed.session.events.find((e) => e.kind === 'file-edit')!;

    writeReport(repo, {
      matches: [
        {
          commitHash: fullHash,
          filePath: 'a.ts',
          sessionId: 'sess-long',
          editSeqs: [editEvent.seq],
          sourcePath: transcript,
          matchedVia: 'content',
          matchedLines: 3,
          contentScore: 1,
          timeScore: 1,
          confidence: 0.9,
          evidence: [],
        },
      ],
    });

    const engine = createWhyEngine(fakeStore({}), claudeCodeParser);
    const result = await engine.why(repo, 'a.ts', 1);
    const userExcerpt = result.attributions[0]!.excerpts.find((e) => e.role === 'user')!;
    expect(userExcerpt.text.length).toBeLessThanOrEqual(400);
    expect(userExcerpt.text.endsWith('…')).toBe(true);
  });

  it('falls back to editedBy (blind spot) when no attribution exists', async () => {
    const repo = makeRepo();
    writeRepoFile(repo, 'manual.ts', 'hand written line one\n');
    const fullHash = commitAll(repo, 'manual commit');

    // report has no matching candidate for this commit/file
    writeReport(repo, { matches: [] });

    const store = fakeStore({
      editors: {
        'manual.ts': [
          {
            session: {
              id: 'sess-touch',
              agent: 'claude-code',
              startedAt: '2026-06-01T10:00:00.000Z',
              endedAt: '2026-06-01T10:30:00.000Z',
              cwd: repo,
              gitBranch: 'main',
              sourcePaths: ['/tmp/sess-touch.jsonl'],
            },
            edge: {
              sessionId: 'sess-touch',
              filePath: 'manual.ts',
              sourcePath: '/tmp/sess-touch.jsonl',
              editCount: 1,
              firstTs: '2026-06-01T10:10:00.000Z',
              lastTs: '2026-06-01T10:20:00.000Z',
            },
          },
        ],
      },
    });

    const engine = createWhyEngine(store, claudeCodeParser);
    const result = await engine.why(repo, 'manual.ts', 1);

    expect(result.commit.hash).toBe(fullHash);
    expect(result.attributions).toHaveLength(0);
    expect(result.editedBy).toEqual([
      { sessionId: 'sess-touch', agent: 'claude-code', lastTs: '2026-06-01T10:20:00.000Z' },
    ]);
  });

  it('outputs gracefully when the blame commit is outside the graph/report', async () => {
    const repo = makeRepo();
    writeRepoFile(repo, 'orphan.ts', 'orphan line\n');
    const fullHash = commitAll(repo, 'orphan commit');

    // report.json exists but has no candidate for this commit; store empty.
    writeReport(repo, { matches: [] });
    const engine = createWhyEngine(fakeStore({}), claudeCodeParser);
    const result = await engine.why(repo, 'orphan.ts', 1);

    // commit metadata still resolved from git; no attributions; no editors.
    expect(result.commit.hash).toBe(fullHash);
    expect(result.commit.subject).toBe('orphan commit');
    expect(result.attributions).toEqual([]);
    expect(result.editedBy).toEqual([]);
  });

  it('works even when .lore/report.json is missing (treats as blind spot)', async () => {
    const repo = makeRepo();
    writeRepoFile(repo, 'noreport.ts', 'some line\n');
    const fullHash = commitAll(repo, 'no report yet');

    const engine = createWhyEngine(fakeStore({}), claudeCodeParser);
    const result = await engine.why(repo, 'noreport.ts', 1);
    expect(result.commit.hash).toBe(fullHash);
    expect(result.attributions).toEqual([]);
  });

  it('throws a clear error for an uncommitted (all-zero) line', async () => {
    const repo = makeRepo();
    writeRepoFile(repo, 'committed.ts', 'line one\n');
    commitAll(repo, 'init');
    // add an uncommitted line 2
    writeRepoFile(repo, 'committed.ts', 'line one\nuncommitted line two\n');

    const engine = createWhyEngine(fakeStore({}), claudeCodeParser);
    await expect(engine.why(repo, 'committed.ts', 2)).rejects.toThrow(/not committed yet/i);
  });

  // Shared fixture for the confidence-floor tests below: four candidates on the
  // same (commit, file) — two strong (≥0.8), two weak (<0.8).
  function makeFloorRepo(): string {
    const repo = makeRepo();
    const newLine = 'export const shared = true;';
    writeRepoFile(repo, 'shared.ts', `${newLine}\n`);
    const fullHash = commitAll(repo, 'shared edit');

    const mk = (sid: string, conf: number) => {
      const t = writeTranscript(
        repo,
        sid,
        repo,
        'shared.ts',
        `user for ${sid}`,
        `assistant for ${sid}`,
        'export const shared = false;',
        newLine,
      );
      return { sid, conf, t };
    };
    const c1 = mk('sess-a', 0.6);
    const c2 = mk('sess-b', 0.95);
    const c3 = mk('sess-c', 0.8);
    const c4 = mk('sess-d', 0.55);

    const matches = [c1, c2, c3, c4].map(({ sid, conf, t }) => ({
      commitHash: fullHash,
      filePath: 'shared.ts',
      sessionId: sid,
      editSeqs: [] as number[],
      sourcePath: t,
      matchedVia: 'content' as const,
      matchedLines: 3,
      contentScore: 1,
      timeScore: 1,
      confidence: conf,
      evidence: [] as string[],
    }));
    writeReport(repo, { matches });
    return repo;
  }

  it('filters weak (<0.8) attributions by default — only strong survive', async () => {
    const repo = makeFloorRepo();
    const engine = createWhyEngine(fakeStore({}), claudeCodeParser);
    const result = await engine.why(repo, 'shared.ts', 1);
    // Default floor 0.8: only 0.95 and 0.8 pass; 0.6 and 0.55 are filtered out.
    const confs = result.attributions.map((a) => a.produced.confidence);
    expect(confs).toEqual([0.95, 0.8]);
  });

  it('includeWeak admits weak candidates, ranked by confidence, capped at top 3', async () => {
    const repo = makeFloorRepo();
    const engine = createWhyEngine(fakeStore({}), claudeCodeParser);
    const result = await engine.why(repo, 'shared.ts', 1, { includeWeak: true });
    expect(result.attributions).toHaveLength(3);
    const confs = result.attributions.map((a) => a.produced.confidence);
    expect(confs).toEqual([0.95, 0.8, 0.6]); // descending, top 3 (0.55 drops off)
  });

  it('honours an explicit minConfidence floor', async () => {
    const repo = makeFloorRepo();
    const engine = createWhyEngine(fakeStore({}), claudeCodeParser);
    // floor 0.9 keeps only the single 0.95 candidate
    const result = await engine.why(repo, 'shared.ts', 1, { minConfidence: 0.9 });
    const confs = result.attributions.map((a) => a.produced.confidence);
    expect(confs).toEqual([0.95]);
  });

  it('matches short report hashes against the full blame hash (prefix)', async () => {
    const repo = makeRepo();
    const newLine = 'const prefixTest = 1;';
    writeRepoFile(repo, 'p.ts', `${newLine}\n`);
    const fullHash = commitAll(repo, 'prefix test');
    const shortHash = fullHash.slice(0, 7);

    const transcript = writeTranscript(
      repo,
      'sess-prefix',
      repo,
      'p.ts',
      'do the prefix thing',
      'doing it',
      'const prefixTest = 0;',
      newLine,
    );
    const parsed = await claudeCodeParser.parse(transcript);
    const editEvent = parsed.session.events.find((e) => e.kind === 'file-edit')!;

    writeReport(repo, {
      matches: [
        {
          commitHash: shortHash, // report stored a short hash
          filePath: 'p.ts',
          sessionId: 'sess-prefix',
          editSeqs: [editEvent.seq],
          sourcePath: transcript,
          matchedVia: 'sha',
          matchedLines: 3,
          contentScore: 1,
          timeScore: 1,
          confidence: 1.0,
          evidence: [],
        },
      ],
    });

    const engine = createWhyEngine(fakeStore({}), claudeCodeParser);
    const result = await engine.why(repo, 'p.ts', 1);
    expect(result.attributions).toHaveLength(1);
    expect(result.attributions[0]!.produced.sessionId).toBe('sess-prefix');
  });
});
