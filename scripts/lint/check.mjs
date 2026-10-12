import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

// Keep the strict rules active; grandfather existing diagnostics by file, rule and source line.
// New diagnostics fail even when unrelated old diagnostics are removed.
const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'));
const eslint = new ESLint();
const results = await eslint.lintFiles(['.']);
const seen = {};
let added = 0, existing = 0;
for (const result of results) {
  const lines = (result.source ?? '').split('\n');
  for (const message of result.messages.filter((item) => item.severity === 2)) {
    const key = JSON.stringify([relative(process.cwd(), result.filePath), message.ruleId, lines[message.line - 1]?.trim() ?? '']);
    seen[key] = (seen[key] ?? 0) + 1;
    if (!message.fatal && seen[key] <= (baseline[key] ?? 0)) existing++;
    else {
      added++;
      console.error(`${relative(process.cwd(), result.filePath)}:${message.line}:${message.column} ${message.ruleId ?? 'parse'}: ${message.message}`);
    }
  }
}
console.log(`Lint: ${added} new errors; ${existing} existing errors (see scripts/lint/baseline.json). npm run lint:strict reports all diagnostics.`);
process.exitCode = added ? 1 : 0;
