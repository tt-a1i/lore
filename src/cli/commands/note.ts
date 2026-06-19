import path from 'node:path';

import type { NoteKind } from '../../distill/types.js';
import { notesStore } from '../../notes/store.js';
import { green, red } from '../ui.js';

export async function cmdNote(opts: {
  repo: string;
  kind: string;
  title: string;
  body: string;
  files?: string;
  supersedes?: string;
  source?: string;
  json?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  const validKinds: NoteKind[] = ['decision', 'constraint', 'rejected-approach'];
  if (!validKinds.includes(opts.kind as NoteKind)) {
    console.error(
      `${red('Error:')} --kind must be one of: ${validKinds.join(', ')}\n  Got: ${opts.kind}`,
    );
    process.exit(1);
  }
  const kind = opts.kind as NoteKind;

  const source: 'agent' | 'human' = opts.source === 'agent' ? 'agent' : 'human';
  const files = opts.files ? opts.files.split(',').map((f) => f.trim()).filter(Boolean) : [];

  const appendArgs: {
    kind: NoteKind;
    title: string;
    body: string;
    files: string[];
    source: 'agent' | 'human';
    supersedes?: string;
  } = { kind, title: opts.title, body: opts.body, files, source };
  if (opts.supersedes !== undefined) appendArgs.supersedes = opts.supersedes;
  const result = await notesStore.appendNote(repoPath, appendArgs);

  if (opts.json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      id: result.id,
      updated: result.updated,
      superseded: result.superseded,
    }, null, 2));
    return;
  }

  const action = result.updated ? 'updated' : 'added';
  const superMsg = result.superseded ? `  supersedes: ${result.superseded}` : '';
  console.log(`${green('✓')} note ${action}: ${result.id}  [${kind}]  source=${source}${superMsg}`);
}
