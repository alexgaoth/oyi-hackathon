// Deterministic text report over one or more run summaries. No timestamps, sorted keys, fixed
// number formatting -> running it twice on the same input is byte-identical.
import type { RateBucket, Summary } from './summary';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const frac = (b: RateBucket) => `${pct(b.breachRate)}  (${b.breaches}/${b.count})`;
const padR = (s: string, w: number) => s.padEnd(w);
const padL = (s: string, w: number) => s.padStart(w);

/** `label` + `value` rows, label column padded to the widest label. */
function rows(pairs: [string, string][]): string {
  const w = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `  ${padR(k, w)}  ${v}`).join('\n');
}

function single(s: Summary): string {
  const goals = Object.keys(s.attacks.byGoal).sort();
  const cats = Object.keys(s.attacks.byCategory).sort();
  const gw = Math.max(0, ...goals.map((g) => g.length));
  const cw = Math.max(0, ...cats.map((c) => c.length));
  return [
    '=== Eval report ===',
    `Run:    ${s.run.name}`,
    `Config: tier=${s.run.tier} backend=${s.run.backend} model=${s.run.model}`,
    '',
    'Overall (breach/utility rates exclude adapter-error items)',
    rows([
      ['items', String(s.totals.items)],
      ['attacks scored', String(s.attacks.count)],
      ['breaches', String(s.attacks.breaches)],
      ['breach rate', pct(s.attacks.breachRate)],
      ['tasks scored', String(s.tasks.count)],
      ['tasks passed', String(s.tasks.passed)],
      ['utility rate', pct(s.tasks.utilityRate)],
      ['errors', String(s.status.error)],
      ['max-steps', String(s.status.maxSteps)],
      ['malformed', String(s.status.malformed)],
    ]),
    '',
    'Breach rate by goal',
    goals.map((g) => `  ${padR(g, gw)}  ${frac(s.attacks.byGoal[g]!)}`).join('\n'),
    '',
    'Breach rate by category',
    cats.map((c) => `  ${padR(c, cw)}  ${frac(s.attacks.byCategory[c]!)}`).join('\n'),
  ].join('\n');
}

function comparison(summaries: Summary[]): string {
  const runs = [...summaries].sort((a, b) => a.run.name.localeCompare(b.run.name));
  const goals = [...new Set(runs.flatMap((s) => Object.keys(s.attacks.byGoal)))].sort();
  const labelRows: [string, (s: Summary) => string][] = [
    ['overall breach rate', (s) => pct(s.attacks.breachRate)],
    ['utility rate', (s) => pct(s.tasks.utilityRate)],
    ['errors', (s) => String(s.status.error)],
    ...goals.map((g) => [`goal:${g}`, (s: Summary) => (s.attacks.byGoal[g] ? pct(s.attacks.byGoal[g]!.breachRate) : '-')] as [string, (s: Summary) => string]),
  ];
  const lw = Math.max('metric'.length, ...labelRows.map(([k]) => k.length));
  const colW = runs.map((s) => Math.max(s.run.name.length, 8));
  const header = `${padR('metric', lw)}  ${runs.map((s, i) => padL(s.run.name, colW[i]!)).join('  ')}`;
  const body = labelRows.map(([k, f]) => `${padR(k, lw)}  ${runs.map((s, i) => padL(f(s), colW[i]!)).join('  ')}`);
  return ['=== Eval comparison ===', header, ...body].join('\n');
}

export function renderReport(summaries: Summary[]): string {
  if (summaries.length === 0) return 'no runs to report\n';
  return (summaries.length === 1 ? single(summaries[0]!) : comparison(summaries)) + '\n';
}
