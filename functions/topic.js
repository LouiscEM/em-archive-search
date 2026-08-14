/**
 * Topics: one subject, answered rather than listed.
 *
 * Phrase-matched on purpose. "value investing" as two ANDed words matches any episode
 * containing both anywhere, which returned 721 episodes and told you nothing; as a
 * phrase it returns 82 and means the subject.
 */
import { page, html, esc, hhmm, num, pct, GREY, NAVY, CORAL, RULE, OFFWHITE }
  from './_shared.js';

const GREEN = '#1B7F4B', RED = '#B4553F';
const EXAMPLES = ['value investing', 'rare earths', 'dollar cost averaging', 'AI bubble',
  'franking credits', 'first home buyer', 'Novo Nordisk', 'crypto'];

function phraseQuery(q) {
  q = (q || '').trim();
  if (!q) return null;
  const phrases = [...q.matchAll(/"([^"]+)"/g)].map(m => m[1].trim()).filter(Boolean);
  const rest = q.replace(/"[^"]+"/g, ' ');
  const terms = (rest.match(/[\w&.'-]+/g) || []).filter(t => t.length > 1);
  if (!phrases.length && terms.length > 1) return `"${terms.join(' ')}"`;
  const parts = [...phrases, ...terms].map(t => `"${t.replace(/"/g, '')}"`);
  return parts.length ? parts.join(' AND ') : null;
}

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const DB = env.DB;
  const eq = encodeURIComponent(q);

  const form = `<form class="search" method="get" action="/topic">
    <div class="qrow">
      <input type="text" name="q" value="${esc(q)}" autofocus
             placeholder="Search a theme, e.g. value investing">
      <button type="submit">Search</button></div>
    <div class="examples">Try ${EXAMPLES.map(e =>
      `<a href="/topic?q=${encodeURIComponent(e)}">${esc(e)}</a>`).join(' ')}</div>
  </form>`;

  if (!q) {
    return html(page('Topics', `
      <h1>How has a theme actually performed?</h1>
      <p class="lede">Search any subject and get an answer rather than a list: how often
         it has come up, whether those episodes beat their slot, who talks about it
         most, and how coverage has changed.</p>
      ${form}
      <div class="empty">Try <b>value investing</b>, <b>property</b> or <b>crypto</b>.
      </div>`, 'topic'));
  }

  const m = phraseQuery(q);
  if (!m) return html(page('Topics', form
    + '<div class="empty">Try a longer word.</div>', 'topic'));

  const eps = (await DB.prepare(
    `SELECT e.post_id, e.title, e.post_date, e.show, p.vs_slot, p.band, p.views,
            COUNT(*) AS hits
     FROM utt_fts
     JOIN utterances u ON u.post_id=utt_fts.post_id AND u.seq=utt_fts.seq
     JOIN episodes e ON e.post_id=u.post_id
     LEFT JOIN episode_perf p ON p.post_id=e.post_id
     WHERE utt_fts MATCH ? GROUP BY e.post_id`).bind(m).all()).results;

  if (!eps.length) {
    return html(page(q, form
      + `<div class="empty">Nothing found for <b>${esc(q)}</b>.</div>`, 'topic'));
  }

  // A video with zero views in its first 28 days is a publishing artefact, not a
  // verdict on the content, so it is left out of the performance read.
  const scored = eps.filter(e => e.vs_slot !== null && (e.views || 0) > 0);
  const med = median(scored.map(e => e.vs_slot));
  const base = median((await DB.prepare(
    'SELECT vs_slot FROM episode_perf WHERE views > 0').all()).results.map(r => r.vs_slot));

  const speakers = (await DB.prepare(
    `SELECT u.speaker, COUNT(*) n, COUNT(DISTINCT u.post_id) eps
     FROM utt_fts JOIN utterances u ON u.post_id=utt_fts.post_id AND u.seq=utt_fts.seq
     WHERE utt_fts MATCH ? AND u.speaker IS NOT NULL
     GROUP BY u.speaker ORDER BY n DESC LIMIT 8`).bind(m).all()).results;
  const companies = (await DB.prepare(
    `SELECT t.name, COUNT(DISTINCT t.post_id) n FROM taxonomy t
     WHERE t.domain='company' AND t.post_id IN
       (SELECT DISTINCT post_id FROM utt_fts WHERE utt_fts MATCH ?)
     GROUP BY t.name ORDER BY n DESC LIMIT 10`).bind(m).all()).results;

  const byYear = {}, byShow = {};
  let hits = 0;
  for (const e of eps) {
    const y = e.post_date.slice(0, 4);
    byYear[y] = (byYear[y] || 0) + 1;
    const s = e.show || '(none)';
    byShow[s] = (byShow[s] || 0) + 1;
    hits += e.hits;
  }

  let verdict;
  if (scored.length && med !== null && base !== null) {
    const diff = med - base;
    verdict = Math.abs(diff) < 0.05
      ? `Episodes covering <b>${esc(q)}</b> perform about the same as everything else.`
      : `Episodes covering <b>${esc(q)}</b> land at <b>${pct(med)}</b> against their
         slot, versus <b>${pct(base)}</b> for the archive as a whole. This subject pulls
         <b>${pct(diff)}</b> ${diff > 0 ? 'better' : 'worse'} than typical.`;
    verdict += ` Based on ${scored.length} of ${eps.length} episodes with performance data.`;
  } else {
    verdict = `<b>${esc(q)}</b> comes up in ${eps.length} episodes, but none have
      performance data yet, so there is no read on how it does.`;
  }

  const ymax = Math.max(...Object.values(byYear));
  const yearRows = Object.keys(byYear).sort().map(y =>
    `<div class="r"><span style="width:44px">${y}</span>
     <span class="bar" style="flex:1"><i style="width:${100 * byYear[y] / ymax}%"></i></span>
     <span class="g">${byYear[y]}</span></div>`).join('');
  const spkRows = speakers.map(s =>
    `<div class="r"><span class="who">${esc(s.speaker)}</span>
     <span class="g">${num(s.n)} mentions across ${s.eps} episodes</span></div>`).join('');
  const showRows = Object.entries(byShow).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([s, n]) => `<div class="r"><span>${esc(s)}</span>
      <span class="g">${n} episodes</span></div>`).join('');

  const hdr = `<tr><th>Date</th><th>Episode</th><th>vs slot</th><th>Views</th>
    <th>Mentions</th></tr>`;
  const eprow = e => `<tr><td class="num">${e.post_date.slice(0, 10)}</td>
    <td><a href="/ep/${e.post_id}?q=${eq}">${esc((e.title || '').slice(0, 70))}</a></td>
    <td class="num" style="color:${e.vs_slot > 0 ? GREEN : RED}">${pct(e.vs_slot)}</td>
    <td class="num">${num(e.views)}</td><td class="num">${e.hits}</td></tr>`;
  const best = [...scored].sort((a, b) => b.vs_slot - a.vs_slot).slice(0, 6);
  const worst = [...scored].sort((a, b) => a.vs_slot - b.vs_slot).slice(0, 4);

  const allRows = [...eps].sort((a, b) => b.post_date.localeCompare(a.post_date))
    .slice(0, 120).map(e => `<tr><td class="num">${e.post_date.slice(0, 10)}</td>
      <td><a href="/ep/${e.post_id}?q=${eq}">${esc((e.title || '').slice(0, 70))}</a></td>
      <td>${esc((e.show || '').slice(0, 24))}</td>
      <td class="num">${e.vs_slot !== null ? pct(e.vs_slot) : '-'}</td>
      <td class="num">${e.hits}</td></tr>`).join('');

  return html(page(`${q} - topic`, `
    <h1>${esc(q)}</h1>
    <p class="lede">Every episode where this came up, and how they did.</p>
    ${form}
    <div class="stats">
      <div class="stat"><b>${num(eps.length)}</b><span>EPISODES</span></div>
      <div class="stat"><b>${num(hits)}</b><span>TIMES MENTIONED</span></div>
      <div class="stat"><b>${scored.length}</b><span>WITH PERFORMANCE</span></div>
      <div class="stat lite"><b style="color:${(med || 0) >= (base || 0) ? GREEN : RED}">
        ${med !== null ? pct(med) : 'n/a'}</b><span>VS SLOT
        <small>archive ${base !== null ? pct(base) : 'n/a'}</small></span></div>
    </div>
    <div class="verdict">${verdict}</div>
    <h2>Best performing episodes on this subject</h2>
    <table>${hdr}${best.map(eprow).join('')}</table>
    ${worst.length ? `<h2>Weakest on this subject</h2><table>${hdr}
      ${worst.map(eprow).join('')}</table>` : ''}
    <div class="grid2">
      <div><h2>Coverage over time</h2><div class="rowlist">${yearRows}</div></div>
      <div><h2>Who talks about it</h2><div class="rowlist">
        ${spkRows || '<div class="r">No speaker data</div>'}</div></div>
    </div>
    <div class="grid2">
      <div><h2>Which shows</h2><div class="rowlist">${showRows}</div></div>
      <div><h2>Companies discussed alongside</h2><div class="tags">
        ${companies.map(c => `<i>${esc(c.name)} (${c.n})</i>`).join(' ')
          || '<span class="g">None tagged</span>'}</div></div>
    </div>
    <h2>All ${eps.length} episodes</h2>
    <div class="count"><a href="/?q=${eq}&mode=moments&sort=new">
      Read the actual quotes &rarr;</a></div>
    <table><tr><th>Date</th><th>Episode</th><th>Show</th><th>vs slot</th>
      <th>Mentions</th></tr>${allRows}</table>`, 'topic'));
}
