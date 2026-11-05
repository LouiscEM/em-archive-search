/**
 * Read-only figures for the internal Ask dashboard at /ask-admin/ (5 Nov 2026).
 *
 * GET /api/admin?days=30        everything the dashboard shows, for the last N days
 * GET /api/admin?answer=<key>   one saved answer in full, to read it
 *
 * Not a public path: it sits behind the test bed's password like every other page. It only
 * reads. Email addresses never leave the database: sign-ups are reported as counts.
 */
import { CACHE_VERSION } from './ask.js';

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// A table that has never been written to does not exist yet; treat it as empty.
async function rows(env, sql, ...args) {
  try { return (await env.DB.prepare(sql).bind(...args).all()).results || []; } catch (e) { return []; }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'No database' }, 503);
  const url = new URL(request.url);

  const key = url.searchParams.get('answer');
  if (key) {
    const r = await rows(env, 'SELECT c.k, c.payload, c.created, c.hits, v.q FROM ask_cache c ' +
      'LEFT JOIN ask_vec v ON v.k = c.k WHERE c.k = ?', key);
    if (!r.length) return json({ error: 'Not found' }, 404);
    let p = {}; try { p = JSON.parse(r[0].payload); } catch (e) { /* show what we can */ }
    return json({ key: r[0].k, question: r[0].q, created: r[0].created, hits: r[0].hits,
      text: p.text || '', episodes: (p.meta || {}).episodes || [], cites: (p.meta || {}).cites || [],
      offTopic: !!(p.meta || {}).offTopic });
  }

  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const since = Date.now() - days * 864e5;

  const log = await rows(env, 'SELECT ts, q, asked, personal, kind, served, company, follow, ms, topic ' +
    'FROM ask_log WHERE ts > ? ORDER BY ts DESC', since);
  const count = (f) => log.reduce((m, r) => { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, n: v }));
  const text = (r) => r.asked || r.q || '';
  const fresh = log.filter((r) => r.served === 'fresh').map((r) => r.ms).sort((a, b) => a - b);
  const byDay = count((r) => new Date(r.ts + 10 * 36e5).toISOString().slice(0, 10));   // AEST-ish

  const fb = await rows(env, 'SELECT ts, q, helpful, comment, how FROM ask_feedback WHERE ts > ? ORDER BY ts DESC', since);
  const show = await rows(env, 'SELECT ts, q, name FROM ask_show WHERE ts > ? ORDER BY ts DESC LIMIT 50', since);
  const tester = await rows(env, 'SELECT ts, name, text FROM ask_tester WHERE ts > ? ORDER BY ts DESC LIMIT 50', since);
  const leads = await rows(env, 'SELECT source, COUNT(*) AS n FROM ask_leads WHERE ts > ? GROUP BY source', since);
  const answers = await rows(env, 'SELECT c.k, c.created, c.hits, c.payload, v.q FROM ask_cache c ' +
    'LEFT JOIN ask_vec v ON v.k = c.k WHERE c.k LIKE ? ORDER BY c.hits DESC, c.created DESC LIMIT 300', `${CACHE_VERSION}|%`);

  return json({
    days, version: CACHE_VERSION, generated: Date.now(),
    totals: {
      questions: log.length,
      answered: log.filter((r) => ['fresh', 'cached', 'reused'].includes(r.served)).length,
      turnedAway: log.filter((r) => r.served === 'blocked').length,
      fallback: log.filter((r) => r.served === 'fallback').length,
      errors: log.filter((r) => r.served === 'error').length,
      followUps: log.filter((r) => r.follow).length,
      personal: log.filter((r) => r.personal).length,
      namedCompany: log.filter((r) => r.company).length,
      medianSeconds: fresh.length ? Math.round(fresh[Math.floor(fresh.length / 2)] / 100) / 10 : null,
    },
    byDay: Object.entries(byDay).sort().map(([d, n]) => ({ d, n })),
    served: count((r) => r.served), kinds: count((r) => r.kind),
    topics: top(count((r) => r.topic), 15),
    companies: top(count((r) => r.company), 15),
    top: top(count((r) => (text(r) || '').toLowerCase().replace(/[?.!\s]+$/, '').trim()), 25),
    recent: log.slice(0, 80).map((r) => ({ ts: r.ts, q: text(r), kind: r.kind, served: r.served,
      company: r.company, follow: !!r.follow, personal: !!r.personal })),
    gaps: log.filter((r) => r.kind !== 'IN' || ['fallback', 'error'].includes(r.served)).slice(0, 60)
      .map((r) => ({ ts: r.ts, q: text(r), kind: r.kind, served: r.served })),
    feedback: { yes: fb.filter((r) => r.helpful).length, no: fb.filter((r) => !r.helpful).length,
      rows: fb.slice(0, 60) },
    show, tester,
    signups: { total: leads.reduce((s, r) => s + r.n, 0), bySource: leads },
    answers: answers.map((r) => {
      let p = {}; try { p = JSON.parse(r.payload); } catch (e) { /* skip detail */ }
      const m = p.meta || {};
      return { key: r.k, q: r.q || r.k.split('|')[1], created: r.created, hits: r.hits || 0,
        words: (p.text || '').split(/\s+/).filter(Boolean).length, offTopic: !!m.offTopic,
        episodes: (m.episodes || []).length, moments: (m.cites || []).reduce((s, c) => s + (c || []).length, 0) };
    }),
  });
}
