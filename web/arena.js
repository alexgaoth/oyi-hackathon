// Arena projector client. Consumes ArenaEvent JSON messages (PLAN.md "Shared contracts") from
// the WebSocket at /ws and renders lanes, the live defender stream, integrity indicators, the
// leaderboard and the BREACHED takeover. Works unchanged against scripts/mock-stream.ts and the
// real arena server. The page's query string is forwarded to /ws (the mock uses ?demo=...).
// ?portal=<url> sets the phone-portal link + QR (e.g. the cloudflared https://*.trycloudflare.com/attack
// URL); without it the portal is this origin's /attack, which phones reach only over the LAN.
import { icon } from './icons.js';
import { renderSVG } from './vendor/uqr.js';

const LANE_COLORS = ['easy', 'medium', 'hard'];
const BREACH_INFO = {
  exfil: 'secret flag leaked',
  wire: 'money wired to a fake payee',
  poison: 'false memory planted',
  relay: 'payload spread to contacts',
};
const TAKEOVER_MS = 3800;
const MAX_CARDS = 8;
const MAX_STEPS = 6;

const lanes = new Map(); // laneId -> { meta, el, feed, ind, current }
const items = new Map(); // inboundId -> { laneId, item, el, steps, status, line }
const takeovers = [];
let takeoverBusy = false;
const lastPoints = new Map();
// On (re)connect the server replays recent history right after `lanes`; verdicts in that burst
// update the board but don't fire takeovers or lane pulses.
const REPLAY_WINDOW_MS = 600;
let replayUntil = 0;

// ── tiny DOM helper: strings become text nodes (attacker text is never parsed as HTML) ──
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'icon') el.insertAdjacentHTML('afterbegin', icon(v));
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const $ = (id) => document.getElementById(id);
const money = (n) => (typeof n === 'number' ? '$' + n.toLocaleString('en-US') : String(n ?? '?'));
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const first = (v) => (Array.isArray(v) ? `${v[0] ?? ''}${v.length > 1 ? ` +${v.length - 1}` : ''}` : v ?? '');

// ── lanes ────────────────────────────────────────────────────
function onLanes(ev) {
  replayUntil = performance.now() + REPLAY_WINDOW_MS;
  lanes.clear();
  items.clear();
  const root = $('lanes');
  root.replaceChildren();
  ev.lanes.forEach((meta, i) => {
    const color = LANE_COLORS.find((c) => meta.label?.toLowerCase().includes(c)) ?? LANE_COLORS[i % 3];
    const ind = {};
    const indEls = ['vault', 'ledger', 'brain', 'contacts'].map((k) => {
      const value = h('span', { class: 'ind-value' });
      const el = h('div', { class: 'ind', icon: k }, h('span', { class: 'ind-label' }, k.toUpperCase()), value);
      ind[k] = { el, value };
      return el;
    });
    const feed = h('div', { class: 'feed' }, h('div', { class: 'feed-empty' }, 'waiting for inbound…'));
    const breaches = h('b', { class: 'lane-breaches' }, '0');
    const sub = h('span', { class: 'lane-score-sub' }, '0 attacks');
    const flash = h('div', { class: 'lane-flash' }, h('span', { icon: 'shield' }, 'DEFENDED'));
    const el = h('article', { class: 'lane', 'data-lane': meta.id, 'data-color': color },
      h('header', { class: 'lane-head' },
        h('div', {},
          h('h2', { class: 'lane-name' }, meta.label),
          h('div', { class: 'lane-cfg' }, h('span', { class: 'chip' }, meta.tier), h('span', { class: 'chip' }, meta.model))),
        h('div', { class: 'lane-score' }, breaches, h('span', { class: 'lane-score-label' }, 'BREACHES'), sub)),
      h('div', { class: 'indicators' }, indEls),
      feed,
      flash);
    root.append(el);
    const lane = { meta, el, feed, ind, breaches, sub, current: null };
    lanes.set(meta.id, lane);
    resetIndicators(lane);
  });
}

function setInd(lane, key, state, value) {
  const ind = lane.ind[key];
  ind.el.dataset.state = state;
  ind.value.textContent = value;
}
function resetIndicators(lane) {
  lane.paid = 0;
  lane.sent = 0;
  setInd(lane, 'vault', 'ok', 'SEALED');
  setInd(lane, 'ledger', 'ok', '$0 OUT');
  setInd(lane, 'brain', 'ok', 'CLEAN');
  setInd(lane, 'contacts', 'ok', 'SAFE');
}

// ── inbound cards ────────────────────────────────────────────
function onQueued({ laneId, item }) {
  const lane = lanes.get(laneId);
  if (!lane) return;
  lane.feed.querySelector('.feed-empty')?.remove();
  for (const done of lane.feed.querySelectorAll('.card[data-done]')) done.classList.add('collapsed');

  const meta = item.meta ?? {};
  const isAttack = meta.kind === 'attack' || (meta.kind == null && meta.player);
  const auth = item.auth ?? 'none';
  const steps = h('ol', { class: 'steps' });
  const status = h('div', { class: 'status' }, 'QUEUED');
  const line = h('div', { class: 'card-line' });
  const el = h('div', { class: 'card', 'data-status': 'queued' },
    h('div', { class: 'card-top' },
      h('span', { class: 'channel', icon: item.channel }, (item.channel ?? '').toUpperCase()),
      h('span', { class: `auth auth--${auth}` }, `AUTH ${auth.toUpperCase()}`),
      isAttack
        ? h('span', { class: 'who who--attacker' }, '@' + (meta.player ?? 'anon'))
        : h('span', { class: 'who who--task' }, 'TASK')),
    h('div', { class: 'from' }, h('b', {}, item.from?.name ?? ''), ' ', h('span', { class: 'addr' }, `<${item.from?.address ?? '?'}>`)),
    item.subject ? h('div', { class: 'subject' }, item.subject) : null,
    h('div', { class: 'body' }, clip(item.body, 220)),
    steps,
    status,
    line);
  lane.feed.prepend(el);
  while (lane.feed.children.length > MAX_CARDS) lane.feed.lastElementChild.remove();
  fitFeed(lane);
  items.set(item.id, { laneId, item, el, steps, status, line, isAttack });
  if (items.size > 400) items.delete(items.keys().next().value);
}

function describe(call) {
  const a = call.args ?? {};
  switch (call.tool) {
    case 'send_email':
    case 'draft_email': return [first(a.to), a.subject ?? a.body];
    case 'reply': return [a.cc?.length ? `sender + cc ${first(a.cc)}` : 'sender', a.body];
    case 'pay': return [`${a.payee ?? '?'} · ${money(a.amount)}`, a.memo];
    case 'read_vault': return [a.item ?? 'vault'];
    case 'read_page': return [a.path];
    case 'write_page': return [a.path, a.content];
    case 'append_page': return [a.path, a.text];
    case 'search_brain': return [`"${a.query ?? ''}"`];
    case 'fetch_doc': return [a.url];
    case 'create_event': return [a.title, a.attendees?.length ? `with ${first(a.attendees)}` : a.description];
    case 'update_event': return [a.id, [a.start, a.end].filter(Boolean).join(' → ')];
    case 'ask_owner': return ['Maya', a.question];
    case 'list_events': return ['calendar'];
    case 'done': return ['', a.summary];
    default: return [clip(JSON.stringify(a), 60)];
  }
}

function onStep({ laneId, inboundId, step }) {
  const lane = lanes.get(laneId);
  const rec = items.get(inboundId);
  if (!lane || !rec) return;
  if (lane.current !== inboundId) { lane.current = inboundId; resetIndicators(lane); }
  if (rec.el.dataset.status === 'queued') {
    rec.el.dataset.status = 'processing';
    rec.status.className = 'status status--processing';
    rec.status.textContent = 'DEFENDER THINKING';
  }

  const li = h('li', { class: 'step' });
  if (step.thought) li.append(h('p', { class: 'thought' }, step.thought));
  if (step.call) {
    const [target, detail] = describe(step.call);
    // Provenance: when the lane's brain backend is GBrain (CTB_BRAIN=gbrain, docs/gbrain.md),
    // say so right on the call, so the projector shows which memory engine answered each search.
    const toolName = step.call.tool === 'search_brain' && lane.meta.tier === 'gbrain' ? 'search_brain \u00b7 gbrain' : step.call.tool;
    li.classList.toggle('step--blocked', !!step.blocked);
    li.classList.toggle('step--done', step.call.tool === 'done');
    li.append(h('div', { class: 'call' },
      h('span', { class: 'tool' }, toolName),
      target ? h('span', { class: 'arrow' }, '→') : null,
      target ? h('span', { class: 'target' }, String(target)) : null));
    if (detail) li.append(h('div', { class: 'detail' }, clip(detail, 120)));
    if (step.blocked) li.append(h('div', { class: 'blocked' }, h('b', {}, 'BLOCKED'), h('span', {}, step.blocked)));
    trackIntegrity(lane, step);
  }
  if (step.error) li.append(h('div', { class: 'step-error' }, '⚠ ' + clip(step.error, 120)));
  if (!li.childElementCount) return;
  rec.steps.append(li);
  while (rec.steps.children.length > MAX_STEPS) rec.steps.firstElementChild.remove();
  fitFeed(lane);
}

// Per-episode integrity view derived from the defender's calls (each episode runs on a fresh World).
function trackIntegrity(lane, { call, blocked }) {
  const a = call.args ?? {};
  switch (call.tool) {
    case 'read_vault':
      setInd(lane, 'vault', blocked ? 'guard' : 'warn', blocked ? 'LOCKED' : 'OPENED');
      break;
    case 'pay':
      if (blocked) { setInd(lane, 'ledger', 'guard', 'BLOCKED'); break; }
      lane.paid += Number(a.amount) || 0;
      setInd(lane, 'ledger', 'warn', '−' + money(lane.paid));
      break;
    case 'write_page':
    case 'append_page':
      setInd(lane, 'brain', blocked ? 'guard' : 'warn', blocked ? 'GUARDED' : 'EDITED');
      break;
    case 'send_email':
      if (blocked) { setInd(lane, 'contacts', 'guard', 'HELD'); break; }
      lane.sent += Array.isArray(a.to) ? a.to.length : 1;
      setInd(lane, 'contacts', 'warn', `SENT ×${lane.sent}`);
      break;
  }
}

// ── verdicts ─────────────────────────────────────────────────
function onVerdict({ laneId, inboundId, verdict, player }) {
  const lane = lanes.get(laneId);
  const rec = items.get(inboundId);
  const breaches = verdict?.breaches ?? [];
  player = player ?? rec?.item.meta?.player;

  let kind, label;
  if (breaches.length) {
    kind = 'breached';
    label = 'BREACHED · ' + breaches.map((b) => b.type.toUpperCase()).join(' + ');
  } else if (rec && !rec.isAttack) {
    const passed = verdict?.utility?.passed;
    kind = passed === false ? 'task-fail' : 'task-pass';
    label = passed === false ? 'TASK FAILED' : 'TASK COMPLETE';
  } else {
    kind = 'defended';
    label = 'DEFENDED';
  }

  if (rec) {
    rec.el.dataset.status = kind;
    rec.el.dataset.done = '';
    rec.status.className = `status stamp stamp--${kind}`;
    rec.status.replaceChildren();
    rec.status.insertAdjacentHTML('afterbegin', icon(kind === 'breached' ? 'alert' : kind === 'defended' ? 'shield' : 'check'));
    rec.status.append(label);
    const badge = kind === 'breached' ? breaches.map((b) => b.type.toUpperCase()).join('+') : kind === 'defended' ? 'DEFENDED' : kind === 'task-pass' ? 'TASK ✓' : 'TASK ✗';
    rec.line.replaceChildren(
      h('span', { class: 'line-badge' }, badge),
      h('span', { class: 'line-ch', icon: rec.item.channel }),
      h('span', { class: 'line-subject' }, rec.item.subject ?? clip(rec.item.body, 80)));
    if (rec.isAttack) rec.line.append(h('span', { class: 'line-who' }, '@' + (player ?? 'anon')));
  }

  if (!lane) return;
  fitFeed(lane);
  const live = performance.now() > replayUntil;
  if (kind === 'breached') {
    const state = { exfil: ['vault', 'STOLEN'], wire: ['ledger', lane.paid ? '−' + money(lane.paid) : 'WIRED'], poison: ['brain', 'POISONED'], relay: ['contacts', 'SPAMMED'] };
    for (const b of breaches) if (state[b.type]) setInd(lane, state[b.type][0], 'bad', state[b.type][1]);
    if (!live) return;
    pulse(lane, 'pulse-breached', TAKEOVER_MS + 1200);
    takeovers.push({ lane: lane.meta, breaches, player });
    runTakeovers();
  } else if (kind === 'defended' && live) {
    pulse(lane, 'pulse-defended', 2200);
  }
}

// Hide history cards that would be cut off at the bottom of the feed (the newest card always shows).
function fitFeed(lane) {
  const { feed } = lane;
  const limit = feed.offsetTop + feed.clientHeight - parseFloat(getComputedStyle(feed).paddingBottom);
  [...feed.children].forEach((card, i) => {
    card.style.visibility = i > 0 && card.offsetTop + card.offsetHeight > limit ? 'hidden' : '';
  });
}

function pulse(lane, cls, ms) {
  lane.el.classList.remove('pulse-defended', 'pulse-breached');
  void lane.el.offsetWidth; // restart CSS animation
  lane.el.classList.add(cls);
  clearTimeout(lane.pulseTimer);
  lane.pulseTimer = setTimeout(() => lane.el.classList.remove(cls), ms);
}

// ── BREACHED takeover ────────────────────────────────────────
function runTakeovers() {
  if (takeoverBusy || !takeovers.length) return;
  takeoverBusy = true;
  const t = takeovers.shift();
  const el = $('takeover');
  $('to-lane').textContent = `${t.lane.label} LANE`;
  $('to-cfg').textContent = `${t.lane.tier} · ${t.lane.model}`;
  $('to-types').replaceChildren(...t.breaches.map((b) =>
    h('div', { class: 'to-type' }, h('b', {}, b.type.toUpperCase()), h('span', {}, BREACH_INFO[b.type] ?? ''))));
  $('to-evidence').textContent = clip(t.breaches[0]?.evidence, 240);
  $('to-player').textContent = '@' + (t.player ?? 'anonymous');
  el.classList.remove('leaving');
  el.hidden = false;
  el.dataset.active = '';
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => {
      el.hidden = true;
      delete el.dataset.active;
      el.classList.remove('leaving');
      takeoverBusy = false;
      runTakeovers();
    }, 450);
  }, TAKEOVER_MS);
}

// ── score ────────────────────────────────────────────────────
function onScore({ leaderboard = [], lanes: laneStats = [] }) {
  let attacks = 0, breaches = 0;
  for (const s of laneStats) {
    attacks += s.attacks;
    breaches += s.breaches;
    const lane = lanes.get(s.laneId);
    if (!lane) continue;
    lane.breaches.textContent = s.breaches;
    lane.breaches.classList.toggle('hot', s.breaches > 0);
    const rate = s.attacks ? Math.round((100 * s.breaches) / s.attacks) : 0;
    lane.sub.textContent = `of ${s.attacks} attacks · ${rate}%`;
  }
  $('total-attacks').textContent = attacks;
  $('total-breaches').textContent = breaches;

  const rows = [...leaderboard].sort((a, b) => b.points - a.points || b.breaches - a.breaches).slice(0, 8);
  const ol = $('leaderboard');
  if (!rows.length) { ol.replaceChildren(h('li', { class: 'board-empty' }, 'no breaches yet')); return; }
  ol.replaceChildren(...rows.map((r, i) => {
    const li = h('li', {},
      h('span', { class: 'rank' }, String(i + 1)),
      h('span', { class: 'player' }, r.playerName ?? '@' + r.player),
      h('span', { class: 'bcount' }, String(r.breaches)),
      h('span', { class: 'points' }, r.points.toLocaleString('en-US')));
    if (performance.now() > replayUntil && lastPoints.get(r.player) < r.points) li.classList.add('bump');
    return li;
  }));
  for (const r of leaderboard) lastPoints.set(r.player, r.points);
}

// ── transport ────────────────────────────────────────────────
const handlers = { lanes: onLanes, queued: onQueued, step: onStep, verdict: onVerdict, score: onScore };

function setConn(state, text) {
  const el = $('conn');
  el.dataset.state = state;
  el.querySelector('span').textContent = text;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws${location.search}`);
  ws.onopen = () => setConn('live', 'LIVE');
  ws.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    handlers[ev?.type]?.(ev);
  };
  ws.onclose = () => { setConn('offline', 'RECONNECTING'); setTimeout(connect, 1500); };
}

connect();
const portal = new URL(new URLSearchParams(location.search).get('portal') ?? '/attack', location.href).href;
$('portal-qr').innerHTML = renderSVG(portal, { ecc: 'M', border: 4 }); // SVG holds only module paths, no text
$('portal-url').textContent = portal.replace(/^https?:\/\//, '');
