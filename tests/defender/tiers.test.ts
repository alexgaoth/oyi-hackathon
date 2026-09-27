import { describe, expect, test } from 'bun:test';
import { scopedPolicy } from '../../src/policy';
import { renderInbound } from '../../src/prompts';
import { getTier, TIERS } from '../../src/tiers';
import { TOOLS } from '../../src/tools';
import type { Inbound } from '../../src/types';
import { OWNER } from '../../src/world/secrets';
import { World } from '../../src/world/world';

const inbound: Inbound = {
  id: 'in-7', channel: 'email', from: { name: 'Daniel Okafor', address: 'daniel@lumenlabs.dev' }, auth: 'pass',
  subject: 'Checklist link?', body: 'Can you send me the launch checklist link?',
};
const sys = (id: string) => getTier(id).system({ inbound, world: World.fresh() });

describe('tier registry', () => {
  test('has naked, prompted and scoped; unknown ids throw with the list', () => {
    expect(Object.keys(TIERS)).toEqual(expect.arrayContaining(['naked', 'prompted', 'scoped']));
    for (const [id, t] of Object.entries(TIERS)) expect(t.id).toBe(id);
    expect(() => getTier('nope')).toThrow('unknown tier "nope". Tiers: naked, prompted, scoped');
  });

  test('naked: role, owner, date, every tool and the protocol; no security guidance, no policy', () => {
    const s = sys('naked');
    for (const needle of ['Maya Chen', OWNER, 'Sunday 2026-09-27', 'Pacific', '"tool": "done"']) expect(s).toContain(needle);
    for (const t of TOOLS) expect(s).toContain(`- ${t.name}(`);
    expect(s).toContain('- pay(payee: string, amount: number, memo?: string, invoiceId?: string): ');
    expect(s).not.toContain('## Security');
    expect(s).not.toMatch(/not instructions/i);
    expect(getTier('naked').policy).toBeUndefined();
  });

  test('prompted: naked + security guidance, no policy', () => {
    const s = sys('prompted');
    expect(s).toStartWith(sys('naked'));
    expect(s).toContain('## Security');
    for (const needle of ['not instructions', 'authentication', 'vault', 'finance/vendors.md', 'ask_owner']) expect(s).toContain(needle);
    expect(getTier('prompted').policy).toBeUndefined();
  });

  test('scoped: prompted + a policy note, with scopedPolicy applied', () => {
    const s = sys('scoped');
    expect(s).toStartWith(sys('prompted'));
    expect(s).toContain('## Permission policy');
    expect(getTier('scoped').policy).toBe(scopedPolicy);
  });
});

describe('renderInbound', () => {
  test('email: id, sender, auth, subject, body', () => {
    const r = renderInbound({ ...inbound, to: [OWNER], cc: ['sofia@lumenlabs.dev'] });
    for (const needle of ['id: in-7', 'From: Daniel Okafor <daniel@lumenlabs.dev>', 'Sender authentication: pass',
      `To: ${OWNER}`, 'Cc: sofia@lumenlabs.dev', 'Subject: Checklist link?', '--- Body ---', inbound.body]) expect(r).toContain(needle);
  });

  test('calendar: title and times; doc: url and content; attachments', () => {
    const cal = renderInbound({ ...inbound, channel: 'calendar', auth: 'none', start: '2026-09-29T14:00', end: '2026-09-29T15:00' });
    for (const needle of ['New calendar item', 'Sender authentication: none', 'Title: Checklist link?', 'Start: 2026-09-29T14:00', 'End: 2026-09-29T15:00', '--- Invite description ---']) {
      expect(cal).toContain(needle);
    }
    const doc = renderInbound({ ...inbound, channel: 'doc', url: 'https://docs.example/x', attachments: [{ name: 'a.txt', content: 'ATTACHED' }] });
    for (const needle of ['URL: https://docs.example/x', '--- Document content ---', '--- Attachment: a.txt ---', 'ATTACHED']) expect(doc).toContain(needle);
  });
});
