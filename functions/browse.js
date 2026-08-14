/** Browse: every episode as a filterable table, straight through to the transcript. */
import { page, html, esc, hhmm, num, pct, GREY } from './_shared.js';

const GREEN = '#1B7F4B', RED = '#B4553F';
const BANDS = { top: ['Top 10%', GREEN], above: ['Above slot', '#2E7D32'],
  typical: ['Typical', GREY], below: ['Below slot', RED] };
const SORTS = { new: ['Newest first', 'e.post_date DESC'],
  old: ['Oldest first', 'e.post_date ASC'],
  perf: ['Best vs slot', 'p.vs_slot IS NULL, p.vs_slot DESC'],
  views: ['Most views', 'p.views IS NULL, p.views DESC'] };
const PER = 50;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const g = k => url.searchParams.get(k) || '';
  const show = g('show'), year = g('year'), band = g('band');
  const sort = SORTS[g('sort')] ? g('sort') : 'new';
  const pg = Math.max(0, parseInt(g('p') || '0', 10) || 0);
  const DB = env.DB;

  const where = [], binds = [];
  if (show) { where.push('e.show = ?'); binds.push(show); }
  if (year) { where.push("substr(e.post_date,1,4) = ?"); binds.push(year); }
  if (band === 'none') where.push('p.band IS NULL');
  else if (band) { where.push('p.band = ?'); binds.push(band); }
  const w = where.length ? where.join(' AND ') : '1=1';

  const rows = (await DB.prepare(
    `SELECT e.post_id, e.title, e.post_date, e.show, e.duration_secs, e.n_utterances,
            p.vs_slot, p.band, p.views
     FROM episodes e LEFT JOIN episode_perf p ON p.post_id=e.post_id
     WHERE ${w} ORDER BY ${SORTS[sort][1]} LIMIT ? OFFSET ?`)
    .bind(...binds, PER, pg * PER).all()).results;
  const cnt = (await DB.prepare(
    `SELECT COUNT(*) c FROM episodes e LEFT JOIN episode_perf p ON p.post_id=e.post_id
     WHERE ${w}`).bind(...binds).first()).c;

  const shows = (await DB.prepare(
    `SELECT show FROM episodes WHERE show IS NOT NULL GROUP BY show
     ORDER BY COUNT(*) DESC`).all()).results.map(r => r.show);
  const years = (await DB.prepare(
    `SELECT DISTINCT substr(post_date,1,4) y FROM episodes ORDER BY y DESC`)
    .all()).results.map(r => r.y);

  const sel = (v, cur) => v === cur ? ' selected' : '';
  const ctrl = `<form class="search" method="get" action="/browse">
    <div class="controls" style="margin-top:0">
      <select name="show" onchange="this.form.submit()">
        <option value="">All shows</option>
        ${shows.map(s => `<option${sel(s, show)}>${esc(s)}</option>`).join('')}</select>
      <select name="year" onchange="this.form.submit()">
        <option value="">All years</option>
        ${years.map(y => `<option${sel(y, year)}>${y}</option>`).join('')}</select>
      <select name="band" onchange="this.form.submit()">
        <option value="">Any performance</option>
        ${Object.entries(BANDS).map(([k, v]) =>
          `<option value="${k}"${sel(k, band)}>${v[0]}</option>`).join('')}
        <option value="none"${sel('none', band)}>Not measured</option></select>
      <select name="sort" onchange="this.form.submit()">
        ${Object.entries(SORTS).map(([k, v]) =>
          `<option value="${k}"${sel(k, sort)}>${v[0]}</option>`).join('')}</select>
    </div></form>`;

  const body = rows.map(r => {
    const b = BANDS[r.band];
    const perf = (r.vs_slot !== null && b)
      ? `<span style="color:${b[1]};font-weight:bold">${pct(r.vs_slot)}</span>` : '-';
    const tr = r.n_utterances > 0 ? 'yes' : `<span style="color:${RED}">no</span>`;
    return `<tr><td class="num">${r.post_date.slice(0, 10)}</td>
      <td><a href="/ep/${r.post_id}">${esc((r.title || '').slice(0, 78))}</a></td>
      <td>${esc((r.show || '').slice(0, 24))}</td>
      <td class="num">${hhmm(r.duration_secs)}</td>
      <td class="num">${tr}</td>
      <td class="num">${r.views !== null ? num(r.views) : '-'}</td>
      <td class="num">${perf}</td></tr>`;
  }).join('');

  const base = `/browse?show=${encodeURIComponent(show)}&year=${year}&band=${band}&sort=${sort}`;
  let pager = '<div class="pager">';
  if (pg) pager += `<a href="${base}&p=${pg - 1}">&larr; Previous</a>`;
  if ((pg + 1) * PER < cnt) pager += `<a href="${base}&p=${pg + 1}">Next &rarr;</a>`;
  pager += `<span>page ${pg + 1} of ${num(Math.max(1, Math.ceil(cnt / PER)))}</span></div>`;

  return html(page('Browse episodes', `
    <h1>Browse every episode</h1>
    <p class="lede">All ${num(cnt)} matching episodes. Click any title for the full
       transcript.</p>
    ${ctrl}
    <table><tr><th>Date</th><th>Episode</th><th>Show</th><th>Length</th>
      <th>Transcript</th><th>Views</th><th>vs slot</th></tr>${body}</table>
    ${pager}`, 'browse'));
}
