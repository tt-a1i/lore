/**
 * Idempotently inject (or refresh) a "## lore" section into a markdown file.
 * Pure function — exported from cli.ts for compatibility with existing tests.
 *
 * Returns { content, injected } where:
 *   - content is the final file text (with section present)
 *   - injected is true if the section was newly added (false if already present / updated)
 */
export function injectLoreSection(existing: string): { content: string; injected: boolean } {
  const MARKER_START = '<!-- lore:start -->';
  const MARKER_END = '<!-- lore:end -->';

  const section = [
    '',
    '## lore — AI-conversation ↔ commit traceability',
    '',
    MARKER_START,
    '<!-- This block is managed by `lore init` — do not edit manually. -->',
    '',
    '**When to use lore (trigger moments):**',
    '',
    '1. **Before editing a file changed by another session in the last 30 days** →',
    '   ```',
    '   lore why <file>:<line> --repo .',
    '   ```',
    '',
    '2. **Before proposing a design decision** →',
    '   ```',
    '   lore ask "<your question>" --repo .',
    '   # To check constraints on a specific file:',
    '   lore ask "<question>" --repo . --file <path>',
    '   ```',
    '',
    '3. **After making an important decision, discovering a hard constraint, or rejecting an approach** →',
    '   ```',
    '   lore note --repo . --kind decision --title "..." --body "..." --source agent',
    '   lore note --repo . --kind constraint --title "..." --body "..." --source agent',
    '   lore note --repo . --kind rejected-approach --title "..." --body "..." --source agent',
    '   ```',
    '',
    '4. **At session start — check data freshness** →',
    '   ```',
    '   lore status --repo .',
    '   ```',
    '',
    'Distilled constraints in `.lore/notes.json` encode prior decisions — respect them.',
    '',
    MARKER_END,
  ].join('\n');

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Section already present — replace its content (idempotent update)
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MARKER_END.length);
    const newContent = before + MARKER_START + section.slice(
      section.indexOf(MARKER_START) + MARKER_START.length,
      section.indexOf(MARKER_END) + MARKER_END.length,
    ) + after;
    return { content: newContent, injected: false };
  }

  // Not present — append
  const newContent = existing.trimEnd() + '\n' + section + '\n';
  return { content: newContent, injected: true };
}
