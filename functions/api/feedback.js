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
const LIMIT = 40;            // votes per IP per hour
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
