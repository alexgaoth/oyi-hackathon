// Schema-checks every corpus item, verifies the README category table matches the files, and
// proves every attack is winnable by running its meta.win through the judge. Exits non-zero
// (printing every problem) on any failure.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACKS_DIR, loadCorpus, validateCorpus } from '../src/eval/corpus';
import { allWinnabilityErrors } from '../src/eval/winnability';
import { allHygieneErrors, GIVEAWAY_ALLOWLIST } from '../src/eval/hygiene';

const corpus = loadCorpus();
const readme = readFileSync(join(ATTACKS_DIR, 'README.md'), 'utf8');
const allItems = [...corpus.attacks, ...corpus.tasks];   // hygiene applies to tasks too
const errors = [...validateCorpus(corpus, readme), ...allWinnabilityErrors(corpus.attacks), ...allHygieneErrors(allItems)];

if (errors.length) {
  console.error(`corpus INVALID (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const cats = new Set(corpus.attacks.map(({ item }) => item.meta!.category));
console.log(`corpus OK: ${corpus.attacks.length} attacks across ${cats.size} categories, ${corpus.tasks.length} tasks.`);
console.log(`categories: ${[...cats].sort().join(', ')}`);
console.log(`winnability: all ${corpus.attacks.length} attacks produce their declared breach via meta.win.`);
console.log(`hygiene: ${allItems.length} items clean of reserved domains, corpus-code domain labels, and giveaway words (allowlisted blunt bodies: ${Object.keys(GIVEAWAY_ALLOWLIST).join(', ')}).`);
