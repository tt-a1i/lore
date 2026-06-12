

## lore — AI-conversation ↔ commit traceability

<!-- lore:start -->
<!-- This block is managed by `lore init` — do not edit manually. -->

**When to use lore (trigger moments):**

1. **Before editing a file changed by another session in the last 30 days** →
   ```
   npx lore why <file>:<line> --repo .
   ```

2. **Before proposing a design decision** →
   ```
   npx lore ask "<your question>" --repo .
   # To check constraints on a specific file:
   npx lore ask "<question>" --repo . --file <path>
   ```

3. **After making an important decision, discovering a hard constraint, or rejecting an approach** →
   ```
   npx lore note --repo . --kind decision --title "..." --body "..." --source agent
   npx lore note --repo . --kind constraint --title "..." --body "..." --source agent
   npx lore note --repo . --kind rejected-approach --title "..." --body "..." --source agent
   ```

4. **At session start — check data freshness** →
   ```
   npx lore status --repo .
   ```

Distilled constraints in `.lore/notes.json` encode prior decisions — respect them.

<!-- lore:end -->
