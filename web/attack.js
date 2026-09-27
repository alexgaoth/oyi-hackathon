// Phone attack portal. POSTs the attack to /api/attack, then follows its inboundId through the
// ArenaEvent stream on /ws: queued → processing (steps) → verdict (BREACHED / DEFENDED).
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
let pending = null; // { inboundId, laneId }
const early = new Map(); // inboundId -> events seen before the POST response arrived
let lastScore = null;

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

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

// ── result tracking ──────────────────────────────────────────
function startTracking(inboundId, laneId) {
  pending = { inboundId, laneId, player: $('player').value.trim().replace(/^@/, '') };
  const lane = lanes.find((l) => l.id === laneId);
  const idx = lanes.indexOf(lane);
  $('r-lane').textContent = lane?.label ?? laneId;
  $('r-lane').style.setProperty('--c', `var(--${['easy', 'medium', 'hard'][idx] ?? 'easy'})`);
  $('r-id').textContent = inboundId;
  $('r-steps').replaceChildren();
  $('verdict').hidden = true;
  setStage('queued');
  form.hidden = true;
  $('result').hidden = false;
  renderMyScore();
  window.scrollTo(0, 0);
  for (const ev of early.get(inboundId) ?? []) track(ev);
  early.delete(inboundId);
}

function setStage(stage) {
  const order = ['queued', 'processing', 'verdict'];
  const at = order.indexOf(stage);
  for (const li of $('stages').children) {
    const i = order.indexOf(li.dataset.stage);
    li.className = i < at || (stage === 'verdict' && i === at) ? 'done' : i === at ? 'now' : '';
  }
}

function track(ev) {
  if (ev.type === 'queued') return setStage('queued');
  if (ev.type === 'step') {
    setStage('processing');
    const { call, blocked } = ev.step;
    const thought = ev.step.thought ?? (call?.tool === 'done' ? call.args?.summary : '');
    const li = document.createElement('li');
    if (thought) li.append(Object.assign(document.createElement('div'), { className: 't', textContent: thought }));
    if (call) {
      const c = Object.assign(document.createElement('div'), { className: blocked ? 'c blocked' : 'c' });
      c.append(Object.assign(document.createElement('b'), { textContent: call.tool }));
      li.append(c);
    }
    if (blocked) li.append(Object.assign(document.createElement('div'), { className: 'why', textContent: `BLOCKED · ${blocked}` }));
    const list = $('r-steps');
    list.prepend(li);
    while (list.children.length > 4) list.lastElementChild.remove();
    return;
  }
  if (ev.type === 'verdict') {
    setStage('verdict');
    const breaches = ev.verdict?.breaches ?? [];
    const v = $('verdict');
    v.replaceChildren();
    const h2 = document.createElement('h2');
    const p = document.createElement('p');
    if (breaches.length) {
      v.className = 'verdict verdict--breached';
      h2.textContent = 'BREACHED';
      p.textContent = 'You broke Maya\'s agent. Check the big screen!';
      const types = document.createElement('div');
      types.className = 'types';
      for (const b of breaches) types.append(Object.assign(document.createElement('b'), { textContent: b.type.toUpperCase() }));
      const code = Object.assign(document.createElement('code'), { textContent: breaches[0].evidence ?? '' });
      v.append(h2, types, p, code);
    } else {
      v.className = 'verdict verdict--defended';
      h2.textContent = 'DEFENDED';
      p.textContent = 'The defender held. Try another angle, or an easier lane.';
      v.append(h2, p);
    }
    v.hidden = false;
  }
}

function renderMyScore() {
  const me = pending && lastScore?.leaderboard.find((r) => r.player === pending.player);
  $('myscore').replaceChildren();
  if (!me) return;
  const b = (t) => Object.assign(document.createElement('b'), { textContent: t });
  $('myscore').append('@' + me.player + ' · ', b(String(me.breaches)), me.breaches === 1 ? ' breach · ' : ' breaches · ', b(me.points.toLocaleString('en-US')), ' pts');
}

$('again').addEventListener('click', () => {
  pending = null;
  $('result').hidden = true;
  form.hidden = false;
});

// ── transport ────────────────────────────────────────────────
function onEvent(ev) {
  if (ev.type === 'lanes') return renderLanes(ev.lanes);
  if (ev.type === 'score') { lastScore = ev; return renderMyScore(); }
  const id = ev.type === 'queued' ? ev.item?.id : ev.inboundId;
  if (!id) return;
  if (pending?.inboundId === id) return track(ev);
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

applyChannelCopy();
connect();
