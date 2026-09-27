// CLI: render deterministic tables from one or more run dirs.
//   bun run scripts/report.ts results/<run> [results/<run> ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport } from '../src/eval/report';
import type { Summary } from '../src/eval/summary';

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('usage: bun run scripts/report.ts <run dir> [<run dir> ...]');
  process.exit(1);
}
const summaries = dirs.map((d) => JSON.parse(readFileSync(join(d, 'summary.json'), 'utf8')) as Summary);
process.stdout.write(renderReport(summaries));
