/**
 * "Was this helpful?" votes from under each Ask Equity Mates answer (28 Oct 2026).
 *
 * One row per answer: the page sends a random id with the vote, and a comment sent after
 * "No" updates that row rather than adding a second one. Stores the question, the vote,
 * the optional comment and how the answer was produced (guide, live, saved, reused), so
 * weak answers can be found and fixed. No IP address or anything identifying is stored.
 * Read the results with `python ask_feedback.py` in C:\B8S-APPS\em-corpus.
 *
 * Public by exact path in _middleware.js, like /api/ask, so it must defend itself: allowed
 * origins only, size limits, and an hourly cap per IP (counted, never stored).
 */
const ALLOWED = ['https://equitymates.com', 'https://www.equitymates.com',
  'https://em-archive-search.pages.dev'];
const LIMIT = 200;           // per IP per hour; the Betashares office shares one IP
const MAX_Q = 300;
const MAX_COMMENT = 500;

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
});

const reply = (status, body, origin) => new Response(JSON.stringify(body),
  { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });

async function overLimit(env, ip) {
  const hour = Math.floor(Date.now() / 3600000);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS ask_fb_rate (ip TEXT, hour INTEGER, n INTEGER, ' +
    'PRIMARY KEY (ip, hour))').run();
  const row = await env.DB.prepare('SELECT n FROM ask_fb_rate WHERE ip = ? AND hour = ?').bind(ip, hour).first();
  if (row && row.n >= LIMIT) return true;
  await env.DB.prepare('INSERT INTO ask_fb_rate (ip, hour, n) VALUES (?, ?, 1) ' +
    'ON CONFLICT(ip, hour) DO UPDATE SET n = n + 1').bind(ip, hour).run();
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM ask_fb_rate WHERE hour < ?').bind(hour - 24).run();
  return false;
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: cors(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED.includes(origin)) return reply(403, { error: 'Not allowed from this origin' }, origin);
  if (!env.DB) return reply(503, { error: 'Not configured' }, origin);

  let b;
  try { b = (await request.json()) || {}; } catch (e) { return reply(400, { error: 'Bad request' }, origin); }

  // EM Daily sign-ups (29 Oct 2026). Stored with the exact consent wording the person saw,
  // so the list can go into Beehiiv later with proof of consent. Nothing is emailed yet.
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
  const saveLead = async (email, source, question, consent) => {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS ask_leads (email TEXT, ts INTEGER, source TEXT, ' +
      'question TEXT, consent TEXT, PRIMARY KEY (email, source))').run();
    await env.DB.prepare('INSERT OR IGNORE INTO ask_leads (email, ts, source, question, consent) VALUES (?, ?, ?, ?, ?)')
      .bind(email.toLowerCase(), Date.now(), source, String(question || '').slice(0, MAX_Q),
        String(consent || '').slice(0, 400)).run();
  };
  if (b.type === 'lead') {
    const email = String(b.email || '').trim();
    const source = ['landing', 'answer', 'show'].includes(b.source) ? b.source : 'landing';
    if (!EMAIL_RE.test(email) || !b.consent) return reply(400, { error: 'Bad request' }, origin);
    try {
      if (await overLimit(env, request.headers.get('CF-Connecting-IP') || 'unknown')) return reply(429, { error: 'Too many' }, origin);
      await saveLead(email, source, b.q, b.consent);
    } catch (e) { return reply(500, { error: 'Could not save' }, origin); }
    return reply(200, { ok: true }, origin);
  }
  // Tester feedback on the tool as a whole (internal test bed only).
  if (b.type === 'tester') {
    const msg = String(b.text || '').trim().slice(0, 1500);
    const who = String(b.name || '').trim().replace(/[^\p{L} '\-]/gu, '').slice(0, 40);
    if (msg.length < 3) return reply(400, { error: 'Bad request' }, origin);
    try {
      if (await overLimit(env, request.headers.get('CF-Connecting-IP') || 'unknown')) return reply(429, { error: 'Too many' }, origin);
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS ask_tester (ts INTEGER, name TEXT, text TEXT, page TEXT)').run();
      await env.DB.prepare('INSERT INTO ask_tester (ts, name, text, page) VALUES (?, ?, ?, ?)')
        .bind(Date.now(), who, msg, String(b.page || '').slice(0, 300)).run();
    } catch (e) { return reply(500, { error: 'Could not save' }, origin); }
    return reply(200, { ok: true }, origin);
  }

  // "Send it to the show" (29 Oct 2026): a question for the team, with an optional first
  // name to read out. Nothing else is kept. Listed daily by ask_health.py for the inbox.
  if (b.type === 'show') {
    const sid = String(b.id || '').slice(0, 40);
    const sq = String(b.q || '').trim().slice(0, MAX_Q);
    const name = String(b.name || '').trim().replace(/[^\p{L} '\-]/gu, '').slice(0, 40);
    if (!/^[a-z0-9]{6,40}$/.test(sid) || sq.length < 5) return reply(400, { error: 'Bad request' }, origin);
    try {
      if (await overLimit(env, request.headers.get('CF-Connecting-IP') || 'unknown')) {
        return reply(429, { error: 'Too many' }, origin);
      }
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS ask_show (id TEXT PRIMARY KEY, ts INTEGER, q TEXT, ' +
        'name TEXT, sent INTEGER DEFAULT 0)').run();
      await env.DB.prepare('INSERT OR IGNORE INTO ask_show (id, ts, q, name) VALUES (?, ?, ?, ?)')
        .bind(sid, Date.now(), sq, name).run();
      // An optional email on the show form joins EM Daily, under the same consent line.
      const em = String(b.email || '').trim();
      if (em && EMAIL_RE.test(em) && b.consent) await saveLead(em, 'show', sq, b.consent);
    } catch (e) {
      return reply(500, { error: 'Could not save' }, origin);
    }
    return reply(200, { ok: true }, origin);
  }
  const id = String(b.id || '').slice(0, 40);
  const q = String(b.q || '').trim().slice(0, MAX_Q);
  if (!/^[a-z0-9]{6,40}$/.test(id) || !q || typeof b.helpful !== 'boolean') {
    return reply(400, { error: 'Bad request' }, origin);
  }
  const comment = String(b.comment || '').trim().slice(0, MAX_COMMENT);
  const kind = ['guide', 'live'].includes(b.kind) ? b.kind : 'live';
  const how = b.offTopic ? 'off-topic' : b.reused ? 'reused' : b.cached ? 'saved' : 'fresh';

  try {
    if (await overLimit(env, request.headers.get('CF-Connecting-IP') || 'unknown')) {
      return reply(429, { error: 'Too many' }, origin);
    }
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS ask_feedback (id TEXT PRIMARY KEY, ts INTEGER, ' +
      'q TEXT, helpful INTEGER, comment TEXT, kind TEXT, how TEXT)').run();
    await env.DB.prepare('INSERT INTO ask_feedback (id, ts, q, helpful, comment, kind, how) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET helpful = excluded.helpful, ' +
      "comment = CASE WHEN excluded.comment <> '' THEN excluded.comment ELSE ask_feedback.comment END, ts = excluded.ts")
      .bind(id, Date.now(), q, b.helpful ? 1 : 0, comment, kind, how).run();
  } catch (e) {
    return reply(500, { error: 'Could not save' }, origin);
  }
  return reply(200, { ok: true }, origin);
}
