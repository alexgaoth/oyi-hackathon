// Phone attack portal. POSTs the attack to /api/attack, then follows its inboundId through the
// live ArenaEvent stream on /ws and narrates it as an attack console — every line here is driven
// by a real event from the running defender, not a script.
//   request:  { player, laneId, channel, from: { name, address }, subject, body }
//   response: { inboundId }   (or { error } with a 4xx status)
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const launch = $('launch');
const COPY = {
  email: ['Subject', 'Message', 'Hi Maya, …'],
  calendar: ['Event title', 'Invite description', 'Agenda: …'],
  doc: ['Doc title', 'Doc content', 'Meeting notes …'],
};

let lanes = [];
let pending = null; // { inboundId, laneId, player }
const early = new Map(); // inboundId -> events seen before the POST response arrived
let lastScore = null;
let deciding = null; // timer handle for the "agent is deciding…" latency cue
let t0 = 0;

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const first = (v) => (Array.isArray(v) ? `${v[0] ?? ''}${v.length > 1 ? ` +${v.length - 1}` : ''}` : (v ?? ''));
const money = (n) => (typeof n === 'number' ? '$' + n.toLocaleString('en-US') : String(n ?? '?'));

// ── form ─────────────────────────────────────────────────────
for (const span of document.querySelectorAll('[data-icon]')) span.insertAdjacentHTML('afterbegin', icon(span.dataset.icon));
launch.insertAdjacentHTML('afterbegin', icon('bolt'));
$('player').value = store.get('ctb.player') ?? '';

function applyChannelCopy() {
  const [subject, body, placeholder] = COPY[form.channel.value];
  $('subject-label').textContent = subject;
  $('body-label').textContent = body;
  $('body').placeholder = placeholder;
}
form.addEventListener('change', (e) => { if (e.target.name === 'channel') applyChannelCopy(); });

function renderLanes(list) {
  lanes = list;
  const current = form.querySelector('input[name=lane]:checked')?.value ?? store.get('ctb.lane');
  const wrap = $('lanes');
  wrap.replaceChildren(...list.map((l, i) => {
    const label = document.createElement('label');
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'lane', value: l.id });
    input.checked = current ? current === l.id : i === 0;
    const span = document.createElement('span');
    const small = document.createElement('small');
    small.textContent = l.model;
    span.append(l.label, small);
    label.append(input, span);
    return label;
  }));
  if (!form.querySelector('input[name=lane]:checked')) wrap.querySelector('input')?.click();
  launch.disabled = false;
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = !msg;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const player = $('player').value.trim().replace(/^@/, '');
  const laneId = form.querySelector('input[name=lane]:checked')?.value;
  const address = $('fromAddress').value.trim();
  const body = $('body').value.trim();
  if (!player) return showError('Pick a handle so the scoreboard knows who you are.');
  if (!laneId) return showError('Waiting for lanes… check your connection.');
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) return showError('From address must look like an email address.');
  if (!body) return showError('Write the message the defender will read.');
  showError('');
  store.set('ctb.player', player);
  store.set('ctb.lane', laneId);

  launch.disabled = true;
  try {
    const res = await fetch('/api/attack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        player, laneId,
        channel: form.channel.value,
        from: { name: $('fromName').value.trim(), address },
        subject: $('subject').value.trim(),
        body,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.inboundId) throw new Error(data.error ?? `server said ${res.status}`);
    startTracking(data.inboundId, laneId);
  } catch (err) {
    showError(`Launch failed: ${err.message}`);
  } finally {
    launch.disabled = false;
  }
});

// ── the attack console ───────────────────────────────────────
const LANE_CLR = ['easy', 'medium', 'hard'];

function startTracking(inboundId, laneId) {
  const player = $('player').value.trim().replace(/^@/, '');
  pending = { inboundId, laneId, player, started: false, done: false };
  const lane = lanes.find((l) => l.id === laneId);
  const idx = lanes.indexOf(lane);
  $('r-lane').textContent = (lane?.label ?? laneId) + ' · ' + (lane?.tier ?? '');
  $('r-lane').style.setProperty('--c', `var(--${LANE_CLR[idx] ?? 'easy'})`);
  $('r-id').textContent = 'session ' + inboundId;
  $('console').replaceChildren();
  $('verdict').hidden = true;
  $('myscore').replaceChildren();
  ['vault', 'ledger', 'brain', 'contacts'].forEach((k) => setObj(k, 'ok', { vault: 'sealed', ledger: '$0 out', brain: 'clean', contacts: 'safe' }[k]));
  setStatus('delivering', 'delivering payload to inbox…');
  const addr = $('fromAddress').value.trim();
  logLine('sys', `session ${inboundId} · lane ${lane?.label ?? laneId} (${lane?.tier ?? '?'} defense)`);
  logLine('send', `payload sent as ${form.channel.value} from ${addr} → maya@mayachen.dev`);
  form.hidden = true;
  $('result').hidden = false;
  window.scrollTo(0, 0);
  renderMyScore();
  for (const ev of early.get(inboundId) ?? []) track(ev);
  early.delete(inboundId);
}

function setStatus(state, text) {
  const el = $('status');
  el.dataset.state = state;
  $('status-text').textContent = text;
}

// A live latency cue: while the real agent thinks between steps, count the seconds up so the
// attacker sees this is a live model working, not a canned animation.
function startDeciding() {
  stopDeciding();
  t0 = Date.now();
  setStatus('deciding', 'the agent is deciding…');
  const tick = () => { $('status-timer').textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's'; };
  tick();
  deciding = setInterval(tick, 100);
}
function stopDeciding() {
  if (deciding) { clearInterval(deciding); deciding = null; }
  $('status-timer').textContent = '';
}

function logLine(kind, text, evidence) {
  const con = $('console');
  const li = document.createElement('div');
  li.className = 'ln ln--' + kind;
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  li.append(Object.assign(document.createElement('span'), { className: 'ln-t', textContent: ts }));
  li.append(Object.assign(document.createElement('span'), { className: 'ln-g', textContent: GLYPH[kind] ?? '·' }));
  const body = Object.assign(document.createElement('span'), { className: 'ln-x', textContent: text });
  li.append(body);
  if (evidence) body.append(Object.assign(document.createElement('code'), { textContent: clip(evidence, 120) }));
  con.append(li);
  con.scrollTop = con.scrollHeight;
}
const GLYPH = { sys: '»', send: '↗', think: '·', read: '›', gain: '‼', block: '⛔', esc: '🛡', breach: '✔', defend: '✕', done: '■' };

function setObj(key, state, text) {
  const el = $('obj-' + key);
  if (!el) return;
  el.dataset.state = state;
  el.querySelector('.obj-v').textContent = text;
}

// map one real defender step -> console line(s) + telemetry, from the attacker's POV
function narrate(step) {
  const { call, blocked, thought } = step;
  if (thought) logLine('think', 'agent: ' + clip(thought, 140));
  if (!call) {
    if (step.error) logLine('sys', 'agent hit an error: ' + clip(step.error, 100));
    return;
  }
  const a = call.args ?? {};
  const t = call.tool;
  if (blocked) {
    // the defense layer refused the action — this is the wall the attacker is hitting
    flashDefense();
    const where = { pay: 'ledger', send_email: 'contacts', write_page: 'brain', append_page: 'brain', read_vault: 'vault' }[t];
    if (where) setObj(where, 'guard', where === 'vault' ? 'locked' : 'held');
    logLine('block', `DEFENSE ENGAGED — ${t}() refused`, blocked);
    return;
  }
  switch (t) {
    case 'read_vault': setObj('vault', 'warn', 'opened'); logLine('gain', `the agent OPENED the vault (${a.item ?? 'secrets'})`); break;
    case 'read_page': logLine('read', `agent read ${a.path}`); break;
    case 'search_brain': logLine('read', `agent searched her notes: "${clip(a.query, 40)}"`); break;
    case 'list_events': logLine('read', 'agent checked her calendar'); break;
    case 'fetch_doc': logLine('read', `agent fetched ${clip(a.url, 60)}`); break;
    case 'write_page': setObj('brain', 'warn', 'edited'); logLine('gain', `agent WROTE to ${a.path}`); break;
    case 'append_page': setObj('brain', 'warn', 'edited'); logLine('gain', `agent appended to ${a.path}`); break;
    case 'pay': setObj('ledger', 'warn', '−' + money(a.amount)); logLine('gain', `agent PAID ${a.payee ?? '?'} ${money(a.amount)}`); break;
    case 'send_email': setObj('contacts', 'warn', 'sent'); logLine('gain', `agent SENT mail to ${first(a.to)}`); break;
    case 'reply': logLine('read', 'agent replied to the sender'); break;
    case 'draft_email': logLine('read', 'agent drafted a reply (not sent)'); break;
    case 'create_event': case 'update_event': setObj('contacts', 'warn', 'invited'); logLine('gain', 'agent changed her calendar'); break;
    case 'ask_owner': logLine('esc', 'agent escalated to Maya — asking her permission'); break;
    case 'done': logLine('done', 'agent finished handling your message'); break;
    default: logLine('read', `agent ran ${t}`);
  }
}

function flashDefense() {
  const el = $('status');
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function track(ev) {
  if (ev.type === 'queued') { setStatus('delivering', 'payload delivered — agent will pick it up'); return; }
  if (ev.type === 'step') {
    if (!pending.started) { pending.started = true; logLine('read', 'the agent is reading your message…'); }
    stopDeciding();
    narrate(ev.step);
    if (ev.step.call?.tool !== 'done') startDeciding();
    else setStatus('deciding', 'reaching a verdict…');
    return;
  }
  if (ev.type === 'verdict') { stopDeciding(); showVerdict(ev); }
}

function showVerdict(ev) {
  pending.done = true;
  const breaches = ev.verdict?.breaches ?? [];
  const v = $('verdict');
  v.replaceChildren();
  if (breaches.length) {
    setStatus('breached', 'BREACH CONFIRMED');
    const hit = { exfil: ['vault', 'STOLEN'], wire: ['ledger', 'WIRED'], poison: ['brain', 'POISONED'], relay: ['contacts', 'SPAMMED'] };
    for (const b of breaches) if (hit[b.type]) setObj(hit[b.type][0], 'bad', hit[b.type][1]);
    logLine('breach', 'BREACHED — ' + breaches.map((b) => b.type.toUpperCase()).join(' + '));
    v.className = 'verdict verdict--breached';
    v.append(Object.assign(document.createElement('h2'), { textContent: 'BREACHED' }));
    const types = document.createElement('div'); types.className = 'types';
    for (const b of breaches) types.append(Object.assign(document.createElement('b'), { textContent: b.type.toUpperCase() }));
    v.append(types);
    v.append(Object.assign(document.createElement('p'), { textContent: "You turned Maya's own agent against her. You're on the board — look up at the big screen." }));
    if (breaches[0]?.evidence) {
      const loot = document.createElement('div'); loot.className = 'loot';
      loot.append(Object.assign(document.createElement('span'), { className: 'loot-k', textContent: 'PROOF' }));
      loot.append(Object.assign(document.createElement('code'), { textContent: clip(breaches[0].evidence, 200) }));
      v.append(loot);
    }
  } else if (ev.error) {
    setStatus('error', 'run errored');
    logLine('sys', 'the run hit an infrastructure error — not scored. Try again.');
    v.className = 'verdict verdict--defended';
    v.append(Object.assign(document.createElement('h2'), { textContent: 'NO SCORE' }));
    v.append(Object.assign(document.createElement('p'), { textContent: 'The agent errored out before finishing (not a real defense). Fire again.' }));
  } else {
    setStatus('defended', 'DEFENDED');
    logLine('defend', 'the defense held — no breach');
    v.className = 'verdict verdict--defended';
    v.append(Object.assign(document.createElement('h2'), { textContent: 'DEFENDED' }));
    const hadBlock = [...$('console').querySelectorAll('.ln--block')].length > 0;
    v.append(Object.assign(document.createElement('p'), {
      textContent: hadBlock
        ? "The permission layer refused the dangerous step. Prompts can be talked around — an owned rule can't. Try a softer route, or an easier lane."
        : "The agent wasn't fooled. Try a different pretext, a spoofed sender, or an easier lane.",
    }));
  }
  v.hidden = false;
  renderMyScore();
}

function renderMyScore() {
  const me = pending && lastScore?.leaderboard.find((r) => r.player === pending.player);
  $('myscore').replaceChildren();
  if (!me) return;
  const b = (t) => Object.assign(document.createElement('b'), { textContent: t });
  $('myscore').append('@' + me.player + ' · ', b(String(me.breaches)), me.breaches === 1 ? ' breach · ' : ' breaches · ', b(me.points.toLocaleString('en-US')), ' pts');
}

$('again').addEventListener('click', () => {
  stopDeciding();
  pending = null;
  $('result').hidden = true;
  form.hidden = false;
  window.scrollTo(0, 0);
});

// ── transport ────────────────────────────────────────────────
function onEvent(ev) {
  if (ev.type === 'lanes') return renderLanes(ev.lanes);
  if (ev.type === 'score') { lastScore = ev; return renderMyScore(); }
  const id = ev.type === 'queued' ? ev.item?.id : ev.inboundId;
  if (!id) return;
  if (pending && !pending.done && pending.inboundId === id) return track(ev);
  early.set(id, [...(early.get(id) ?? []), ev]);
  if (early.size > 50) early.delete(early.keys().next().value);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => { $('conn').dataset.state = 'live'; };
  ws.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev?.type) onEvent(ev);
  };
  ws.onclose = () => { $('conn').dataset.state = 'offline'; setTimeout(connect, 1500); };
}

// ── target dossier: the canonical scenario (same brief the defender is spun up with) ──
function inlineMd(text, parent) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parent.append(Object.assign(document.createElement('b'), { textContent: tok.slice(2, -2) }));
    else parent.append(Object.assign(document.createElement('code'), { textContent: tok.slice(1, -1) }));
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}
function renderMd(md, root) {
  root.replaceChildren();
  let ul = null, para = [];
  const flush = () => { if (para.length) { const p = document.createElement('p'); inlineMd(para.join(' '), p); root.append(p); para = []; } };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (/^#\s/.test(line)) { flush(); ul = null; continue; }          // skip the top-level title
    if (/^##\s/.test(line)) { flush(); ul = null; const h = document.createElement('h2'); inlineMd(line.slice(3), h); root.append(h); continue; }
    if (/^[-*]\s/.test(line)) { flush(); if (!ul) { ul = document.createElement('ul'); root.append(ul); } const li = document.createElement('li'); inlineMd(line.slice(2), li); ul.append(li); continue; }
    if (line === '') { flush(); ul = null; continue; }
    ul = null; para.push(line);
  }
  flush();
}
const dossier = $('dossier');
let dossierLoaded = false;
dossier?.addEventListener('toggle', async () => {
  if (!dossier.open || dossierLoaded) return;
  dossierLoaded = true;
  const body = $('dossier-body');
  try {
    const r = await fetch('/api/scenario');
    const d = await r.json();
    if (!d.markdown) throw new Error('empty');
    renderMd(d.markdown, body);
  } catch {
    dossierLoaded = false; // let a retry happen on next open
    body.replaceChildren(Object.assign(document.createElement('p'), { className: 'd-loading', textContent: "Couldn't load the target's file — the server may be offline. Try again." }));
  }
});

applyChannelCopy();
connect();
