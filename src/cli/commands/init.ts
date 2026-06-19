import fs from 'node:fs/promises';
import path from 'node:path';

import { injectLoreSection } from '../inject.js';
import { blue, green, dim } from '../ui.js';

export async function cmdInit(opts: { repo: string }): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  console.log(`\n${blue('▶')} lore init: ${repoPath}\n`);

  const targets: { file: string; label: string }[] = [
    { file: path.join(repoPath, 'CLAUDE.md'), label: 'CLAUDE.md' },
    { file: path.join(repoPath, 'AGENTS.md'), label: 'AGENTS.md' },
  ];

  let anyChanged = false;
  for (const { file, label } of targets) {
    let existing = '';
    let exists = true;
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch {
      exists = false;
    }

    const { content, injected } = injectLoreSection(existing);

    if (!exists) {
      // File does not exist — only create CLAUDE.md, not AGENTS.md
      if (label === 'CLAUDE.md') {
        await fs.writeFile(file, content, 'utf8');
        console.log(`${green('✓')} created ${label} with lore section`);
        anyChanged = true;
      } else {
        console.log(`${dim('–')} ${label} — not found, skipping`);
      }
    } else if (injected) {
      await fs.writeFile(file, content, 'utf8');
      console.log(`${green('✓')} injected lore section into ${label}`);
      anyChanged = true;
    } else {
      // Section already present — refresh content (idempotent)
      if (existing !== content) {
        await fs.writeFile(file, content, 'utf8');
        console.log(`${dim('↻')} ${label} — lore section refreshed`);
        anyChanged = true;
      } else {
        console.log(`${dim('–')} ${label} — lore section already up to date`);
      }
    }
  }

  if (!anyChanged) {
    console.log(`\n${dim('All files already up to date — no changes made.')}`);
  }
  console.log('');
}
