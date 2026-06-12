/**
 * 共享 fixture：GraphStore 行为测试的数据集。
 * 被 vitest（json 后端）与 scripts/test-kuzu-store.mts（kuzu 后端，
 * 独立进程跑——kuzu 原生绑定与 vitest worker 池不兼容）共用。
 */

import type { GraphData } from '../../src/graph/types.js';

export function makeData(): GraphData {
  return {
    sessions: [
      {
        id: 'ses-alpha',
        agent: 'claude-code',
        startedAt: '2026-06-01T10:00:00.000Z',
        endedAt: '2026-06-01T11:00:00.000Z',
        cwd: '/home/user/proj',
        gitBranch: 'feat/x',
        sourcePaths: ['/home/user/.claude/projects/proj/ses-alpha.jsonl'],
      },
      {
        id: 'ses-beta',
        agent: 'claude-code',
        startedAt: '2026-06-02T08:00:00.000Z',
        endedAt: null,
        cwd: null,
        gitBranch: null,
        sourcePaths: ['/home/user/.claude/projects/proj/ses-beta.jsonl'],
      },
    ],
    commits: [
      {
        hash: 'abc111',
        subject: 'feat: add foo',
        authorDate: '2026-06-01T10:30:00.000Z',
        committerDate: '2026-06-01T10:31:00.000Z',
        isMerge: false,
      },
      {
        hash: 'def222',
        subject: 'fix: bar crash',
        authorDate: '2026-06-02T09:00:00.000Z',
        committerDate: '2026-06-02T09:01:00.000Z',
        isMerge: false,
      },
      {
        hash: 'ghi333',
        subject: 'chore: lint',
        authorDate: '2026-06-02T10:00:00.000Z',
        committerDate: '2026-06-02T10:01:00.000Z',
        isMerge: false,
      },
    ],
    files: [
      { path: 'src/foo.ts' },
      { path: 'src/bar.ts' },
      { path: 'README.md' },
    ],
    produced: [
      {
        sessionId: 'ses-alpha',
        commitHash: 'abc111',
        confidence: 0.95,
        matchedVia: 'sha',
        sourcePath: '/home/user/.claude/projects/proj/ses-alpha.jsonl',
        matchedLines: 8,
        fileCount: 2,
      },
      {
        sessionId: 'ses-beta',
        commitHash: 'abc111',
        confidence: 0.60,
        matchedVia: 'content',
        sourcePath: '/home/user/.claude/projects/proj/ses-beta.jsonl',
        matchedLines: 3,
        fileCount: 1,
      },
      {
        sessionId: 'ses-beta',
        commitHash: 'def222',
        confidence: 0.85,
        matchedVia: 'content',
        sourcePath: '/home/user/.claude/projects/proj/ses-beta.jsonl',
        matchedLines: 5,
        fileCount: 1,
      },
    ],
    touches: [
      // abc111 touches foo.ts and bar.ts
      { commitHash: 'abc111', filePath: 'src/foo.ts', status: 'A', addedLines: 20, removedLines: 0 },
      { commitHash: 'abc111', filePath: 'src/bar.ts', status: 'M', addedLines: 5, removedLines: 2 },
      // def222 touches bar.ts
      { commitHash: 'def222', filePath: 'src/bar.ts', status: 'M', addedLines: 3, removedLines: 1 },
      // ghi333 touches README
      { commitHash: 'ghi333', filePath: 'README.md', status: 'M', addedLines: 1, removedLines: 0 },
    ],
    edited: [
      {
        sessionId: 'ses-alpha',
        filePath: 'src/foo.ts',
        sourcePath: '/home/user/.claude/projects/proj/ses-alpha.jsonl',
        editCount: 3,
        firstTs: '2026-06-01T10:05:00.000Z',
        lastTs: '2026-06-01T10:20:00.000Z',
      },
      {
        sessionId: 'ses-alpha',
        filePath: 'src/bar.ts',
        sourcePath: '/home/user/.claude/projects/proj/ses-alpha.jsonl',
        editCount: 1,
        firstTs: '2026-06-01T10:25:00.000Z',
        lastTs: '2026-06-01T10:25:00.000Z',
      },
      {
        sessionId: 'ses-beta',
        filePath: 'src/bar.ts',
        sourcePath: '/home/user/.claude/projects/proj/ses-beta.jsonl',
        editCount: 2,
        firstTs: '2026-06-02T08:10:00.000Z',
        lastTs: '2026-06-02T08:30:00.000Z',
      },
    ],
  };
}
