/**
 * Usage capture on the hosted app.
 *
 * Same purpose as usage.py locally: record what people search for, what came back,
 * and what they clicked. The rows that matter are the ones with zero results, since
 * those are subjects the archive cannot answer.
 *
 * Writes are fire-and-forget via waitUntil so logging can never slow down or break
 * a page render. If the insert fails, the user still gets their results.
 *
 * Privacy: no names, accounts or IP addresses. A random id in a cookie joins a search
 * to the click that followed it, and nothing else.
 */

const STOP = new Set(['the', 'a', 'an', 'of', 'is', 'are', 'was', 'were', 'what',
  'which', 'who', 'to', 'in', 'on', 'for', 'and', 'or', 'do', 'did', 'does', 'have',
  'has', 'about', 'that', 'this', 'it', 'they', 'we', 'you', 'i', 'me', 'my']);

/** Group "value investing" and "What is value investing?" into one key. */
export function normalise(q) {
  const words = (q || '').toLowerCase().match(/[a-z0-9']+/g) || [];
  const keep = [];
  for (let w of words) {
    if (STOP.has(w) || w.length < 2) continue;
    if (w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
    keep.push(w);
  }
  return [...new Set(keep)].sort().join(' ').slice(0, 200);
}

export function sessionFrom(request) {
  const m = (request.headers.get('Cookie') || '').match(/ems=([a-f0-9]{16})/);
  if (m) return { id: m[1], setCookie: null };
  const b = crypto.getRandomValues(new Uint8Array(8));
  const id = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return { id, setCookie: `ems=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure` };
}

const DDL = `CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, day TEXT, session TEXT,
  view TEXT, query TEXT, norm TEXT, mode TEXT, filters TEXT, results INTEGER,
  ms INTEGER, ok INTEGER DEFAULT 1, note TEXT)`;
const DDL2 = `CREATE TABLE IF NOT EXISTS usage_click (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, day TEXT, session TEXT,
  log_id INTEGER, query TEXT, norm TEXT, post_id INTEGER, seq INTEGER,
  rank INTEGER, kind TEXT)`;

let ready = false;
async function ensure(DB) {
  if (ready) return;
  try {
    await DB.batch([DB.prepare(DDL), DB.prepare(DDL2)]);
    ready = true;
  } catch { /* a failed create must not break the page */ }
}

export async function logSearch(env, ctx, { view, query, mode, filters, results, ms,
  session, ok = true, note = null }) {
  const task = (async () => {
    try {
      await ensure(env.DB);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO usage_log(ts,day,session,view,query,norm,mode,filters,results,
         ms,ok,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(now, new Date().toISOString().slice(0, 10), session, view,
          (query || '').slice(0, 300), normalise(query), mode || null,
          JSON.stringify(filters || {}).slice(0, 400), results, ms, ok ? 1 : 0,
          note ? String(note).slice(0, 200) : null).run();
    } catch { /* logging is best-effort */ }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(task); else await task;
}

export async function logClick(env, ctx, { session, query, post_id, seq = null,
  rank = null, kind = 'episode' }) {
  const task = (async () => {
    try {
      await ensure(env.DB);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO usage_click(ts,day,session,query,norm,post_id,seq,rank,kind)
         VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(now, new Date().toISOString().slice(0, 10), session,
          (query || '').slice(0, 300), normalise(query), post_id, seq, rank, kind).run();
    } catch { /* best-effort */ }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(task); else await task;
}
