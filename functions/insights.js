/**
 * Insights: what the team searched for, and what the archive could not answer.
 *
 * The "asked but not answered" table is the reason this page exists. Everything else
 * is supporting context.
 */
import { page, html, esc, num, GREY } from './_shared.js';

const q = (DB, sql, ...a) => DB.prepare(sql).bind(...a).all()
  .then(r => r.results).catch(() => []);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '90', 10) || 90));
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const DB = env.DB;

  const [totals, top, gaps, thin, unclicked, episodes, daily] = await Promise.all([
    q(DB, `SELECT view, COUNT(*) n, COUNT(DISTINCT session) people FROM usage_log
           WHERE ts>=? GROUP BY view ORDER BY n DESC`, since),
    q(DB, `SELECT norm, COUNT(*) n, MAX(query) example, AVG(results) avg_results,
                  COUNT(DISTINCT session) people FROM usage_log
           WHERE ts>=? AND query<>'' AND norm<>'' GROUP BY norm
           ORDER BY n DESC LIMIT 25`, since),
    q(DB, `SELECT norm, COUNT(*) n, MAX(query) example, COUNT(DISTINCT session) people
           FROM usage_log WHERE ts>=? AND query<>'' AND norm<>'' GROUP BY norm
           HAVING AVG(results) < 1 ORDER BY n DESC LIMIT 25`, since),
    q(DB, `SELECT norm, COUNT(*) n, MAX(query) example, AVG(results) avg_results
           FROM usage_log WHERE ts>=? AND query<>'' AND norm<>'' GROUP BY norm
           HAVING AVG(results) BETWEEN 1 AND 4 ORDER BY n DESC LIMIT 15`, since),
    q(DB, `SELECT l.norm, COUNT(*) n, MAX(l.query) example FROM usage_log l
           LEFT JOIN usage_click c ON c.norm=l.norm
           WHERE l.ts>=? AND l.query<>'' AND l.results>0 AND c.id IS NULL
           GROUP BY l.norm ORDER BY n DESC LIMIT 15`, since),
    q(DB, `SELECT c.post_id, e.title, e.post_date, COUNT(*) n FROM usage_click c
           JOIN episodes e ON e.post_id=c.post_id WHERE c.ts>=?
           GROUP BY c.post_id ORDER BY n DESC LIMIT 20`, since),
    q(DB, `SELECT day, COUNT(*) n, COUNT(DISTINCT session) people FROM usage_log
           WHERE ts>=? GROUP BY day ORDER BY day DESC LIMIT 14`, since),
  ]);

  const table = (items, cols, empty) => items.length
    ? `<table><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>${
      items.map(it => `<tr>${cols.map(c =>
        `<td class="${c[2] || ''}">${c[1](it)}</td>`).join('')}</tr>`).join('')}</table>`
    : `<div class="empty" style="padding:26px">${empty}</div>`;

  const total = totals.reduce((s, t) => s + t.n, 0);
  const people = totals.reduce((m, t) => Math.max(m, t.people), 0);
  const dmax = Math.max(1, ...daily.map(d => d.n));

  return html(page('What people are asking', `
    <h1>What people are asking</h1>
    <p class="lede">Every search is a signal about what the team needs. The most useful
       rows are the ones that came back empty: subjects the archive cannot answer,
       which makes them candidates for what to make next.</p>

    <div class="stats">
      <div class="stat"><b>${num(total)}</b><span>SEARCHES<small>last ${days} days</small></span></div>
      <div class="stat"><b>${num(people)}</b><span>PEOPLE<small>distinct browsers</small></span></div>
      <div class="stat"><b>${num(gaps.length)}</b><span>UNANSWERED<small>asked, nothing found</small></span></div>
      <div class="stat lite"><b>${num(episodes.length)}</b><span>EPISODES OPENED</span></div>
    </div>

    <h2>Asked but not answered</h2>
    <p class="lede" style="margin-bottom:12px">Searches that consistently return
       nothing. Read this as a commissioning list.</p>
    ${table(gaps, [['Question', r => esc(r.example)],
      ['Times asked', r => num(r.n), 'num'], ['People', r => num(r.people), 'num']],
      'Nothing yet. Once the team starts searching, unanswered questions collect here.')}

    <h2>Thin coverage</h2>
    <p class="lede" style="margin-bottom:12px">Answered, but barely. Under five results
       usually means a passing mention rather than real coverage.</p>
    ${table(thin, [['Question', r => esc(r.example)],
      ['Times asked', r => num(r.n), 'num'],
      ['Avg results', r => (r.avg_results || 0).toFixed(1), 'num']], 'Nothing yet.')}

    <h2>Most asked</h2>
    ${table(top, [['Question', r => esc(r.example)], ['Times', r => num(r.n), 'num'],
      ['People', r => num(r.people), 'num'],
      ['Avg results', r => num(Math.round(r.avg_results || 0)), 'num']], 'Nothing yet.')}

    <h2>Found results, but nobody clicked</h2>
    <p class="lede" style="margin-bottom:12px">The archive answered and the answer was
       ignored, which usually means the results looked irrelevant.</p>
    ${table(unclicked, [['Question', r => esc(r.example)],
      ['Times', r => num(r.n), 'num']], 'Nothing yet.')}

    <div class="grid2">
      <div><h2>Where people search</h2><div class="rowlist">
        ${totals.map(t => `<div class="r"><span>${esc(t.view)}</span>
          <span class="g">${num(t.n)} searches &middot; ${t.people}
          ${t.people === 1 ? 'person' : 'people'}</span></div>`).join('')
          || '<div class="r">No activity yet</div>'}</div></div>
      <div><h2>Searches per day</h2><div class="rowlist">
        ${daily.slice().reverse().map(d => `<div class="r">
          <span style="width:86px">${d.day}</span>
          <span class="bar" style="flex:1"><i style="width:${100 * d.n / dmax}%"></i></span>
          <span class="g">${d.n}</span></div>`).join('')
          || '<div class="r">No activity yet</div>'}</div></div>
    </div>

    <h2>Most opened episodes</h2>
    ${table(episodes, [
      ['Episode', r => `<a href="/ep/${r.post_id}">${esc((r.title || '').slice(0, 72))}</a>`],
      ['Date', r => (r.post_date || '').slice(0, 10), 'num'],
      ['Opens', r => num(r.n), 'num']], 'Nothing yet.')}

    <p class="lede" style="margin-top:34px;font-size:13px">No names, accounts or IP
       addresses are recorded. A random id in a cookie links a search to the click that
       followed it, and nothing else.</p>`, 'insights'));
}
