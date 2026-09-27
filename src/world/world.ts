// In-memory, deterministic world for one episode. Nothing here does real I/O except
// reading the seed files once.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Inbound } from '../types';
import { parseContacts, parseVendors } from './parse';
import type { Contact, Vendor, WorldState } from './types';

const SEED_DIR = join(import.meta.dir, '../../world/seed');

let seedCache: WorldState | undefined;

function loadSeed(): WorldState {
  if (!seedCache) {
    const brainDir = join(SEED_DIR, 'brain');
    const brain: Record<string, string> = {};
    const files = (readdirSync(brainDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).sort();
    for (const f of files) brain[f.split(sep).join('/')] = readFileSync(join(brainDir, f), 'utf8');
    const seed = JSON.parse(readFileSync(join(SEED_DIR, 'world.json'), 'utf8'));
    seedCache = {
      brain, calendar: seed.calendar, ledger: seed.ledger, docs: seed.docs,
      outbox: [], drafts: [], invites: [], inbox: [], trigger: null,
      fetches: [], vaultReads: [], vaultReadAt: {}, questions: [], summary: null,
    };
  }
  return structuredClone(seedCache);
}

/** JSON with object keys sorted recursively, so equal states serialize identically. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, canonical(o[k])]));
  }
  return v;
}

export function hashState(s: WorldState): string {
  return createHash('sha256').update(JSON.stringify(canonical(s))).digest('hex');
}

export class World {
  /** State at creation, before the episode ran — the judge's "before". */
  readonly baseline: WorldState;

  constructor(public state: WorldState) {
    this.baseline = structuredClone(state);
  }

  static fresh(): World {
    return new World(loadSeed());
  }

  /** Receive the item this episode processes: inbox + trigger; a doc item registers its content at its url. */
  deliver(item: Inbound): void {
    this.state.inbox.push(structuredClone(item));
    this.state.trigger = item.id;
    if (item.channel === 'doc' && item.url) this.state.docs[item.url] = item.body;
  }

  /** The inbound item that triggered this episode (policy checks its sender + auth). */
  get trigger(): Inbound | undefined {
    return this.state.inbox.find((i) => i.id === this.state.trigger);
  }

  contacts(): Contact[] {
    return parseContacts(this.state.brain);
  }

  vendors(): Vendor[] {
    return parseVendors(this.state.brain);
  }

  snapshot(): WorldState {
    return structuredClone(this.state);
  }

  snapshotHash(): string {
    return hashState(this.state);
  }
}
