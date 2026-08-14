/** Search page. Cloudflare Pages Function bound to D1 as `DB`. */
import {
  page, html, esc, mark, hhmm, num, pct, ftsQuery, perfBadge,
  EXAMPLES, SORT_LABELS, ORDERS, EP_ORDERS, GREY,
} from './_shared.js';

const PER = 25;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const g = (k, d = '') => url.searchParams.get(k) ?? d;
  const q = g('q');
  const mode = g('mode') === 'episodes' ? 'episodes' : 'moments';
  const show = g('show');
  const frm = g('from');
  const to = g('to');
  let sort = g('sort', 'new');
  if (!(sort in ORDERS)) sort = 'new';
  const pg = Math.max(0, parseInt(g('p', '0'), 10) || 0);
  const DB = env.DB;

  const shows = (await DB.prepare(
    `SELECT show FROM episodes WHERE show IS NOT NULL
     GROUP BY show ORDER BY COUNT(*) DESC`).all()).results.map(r => r.show);

  const eq = encodeURIComponent(q);
  const keep = `&show=${encodeURIComponent(show)}&from=${frm}&to=${to}`;
  const opts = ['<option value="">All shows</option>',
    ...shows.map(s => `<option${s === show ? ' selected' : ''}>${esc(s)}</option>`)].join('');
  const sortOpts = SORT_LABELS.map(([v, l]) =>
    `<option value="${v}"${v === sort ? ' selected' : ''}>${l}</option>`).join('');

  const bar = `
  <form class="search" method="get" action="/">
    <div class="qrow">
      <input type="text" name="q" value="${esc(q)}" autofocus
             placeholder="Search everything ever said on the show">
      <button type="submit">Search</button>
    </div>
    <div class="controls">
      <span class="seg">
        <a class="${mode === 'moments' ? 'on' : ''}"
           href="/?q=${eq}&mode=moments&sort=${sort}${keep}">Moments</a>
        <a class="${mode === 'episodes' ? 'on' : ''}"
           href="/?q=${eq}&mode=episodes&sort=${sort}${keep}">Episodes</a>
      </span>
      <select name="sort" onchange="this.form.submit()">${sortOpts}</select>
      <select name="show" onchange="this.form.submit()">${opts}</select>
      <input type="date" name="from" value="${esc(frm)}" title="From date">
      <input type="date" name="to" value="${esc(to)}" title="To date">
      <input type="hidden" name="mode" value="${esc(mode)}">
    </div>
    <div class="examples">Try
      ${EXAMPLES.map(e => `<a href="/?q=${encodeURIComponent(e)}&mode=${mode}`
        + `&sort=${sort}">${esc(e)}</a>`).join(' ')}
    </div>
  </form>`;

  if (!q.trim()) {
    const s = await DB.prepare(
      `SELECT COUNT(*) eps, SUM(n_utterances) u FROM episodes`).first();
    const co = await DB.prepare(
      `SELECT COUNT(DISTINCT name) c FROM taxonomy WHERE domain='company'`).first();
    const w = await DB.prepare(
      `SELECT SUM(LENGTH(text)) t FROM utterances`).first();
    const hero = `<div class="hero">
      <h1>Ten years of Equity Mates, searchable.</h1>
      <p>Find the exact moment something was said, who said it, and jump straight
         to it on YouTube.</p></div>`;
    const stats = `<div class="stats">
      <div class="stat"><b>${num(s.eps)}</b><span>EPISODES</span></div>
      <div class="stat"><b>${(Number(w.t || 0) / 6 / 1e6).toFixed(1)}M</b>
        <span>WORDS SPOKEN</span></div>
      <div class="stat"><b>${num(s.u)}</b><span>SEARCHABLE MOMENTS</span></div>
      <div class="stat"><b>${num(co.c)}</b><span>COMPANIES</span></div>
      <div class="stat"><b>${shows.length}</b><span>SHOWS</span></div>
    </div>`;
    return html(page('Equity Mates Archive Search', hero + bar + stats + `
      <div class="empty">
      <b>Moments</b> finds the exact thing someone said, with the speaker and
      timecode.<br>
      <b>Episodes</b> finds whole episodes about a topic.<br>
      Put "quotes around a phrase" to match it exactly.</div>`));
  }

  const m = ftsQuery(q);
  if (!m) return html(page('Search', bar + '<div class="empty">Try a longer word.</div>'));

  const filters = [];
  const params = [];
  if (show) { filters.push('e.show = ?'); params.push(show); }
  if (frm) { filters.push('e.post_date >= ?'); params.push(frm); }
  if (to) { filters.push('e.post_date <= ?'); params.push(to + '~'); }
  const extra = filters.length ? ' AND ' + filters.join(' AND ') : '';

  const orderTxt = SORT_LABELS.find(([v]) => v === sort)[1].toLowerCase();
  const perfNote = sort === 'perf' ? `<div class="perfnote">Performance compares an
    episode against the average of the episodes either side of it, so older episodes
    are not punished for a smaller audience. Known for 641 episodes (YouTube only,
    2021 onwards); everything else is unmeasured and sorts last.</div>` : '';

  let cards = [], cnt = 0, head = '';

  if (mode === 'episodes') {
    // An episode matches if the words appear in its title/description OR anywhere
    // in what was said. The local build indexed whole transcripts a second time to
    // do this; here the utterance index is reused instead, so Episodes and Moments
    // agree with each other and the database stays half the size.
    const HITS = `
      WITH um AS (
        SELECT post_id AS pid, bm25(utt_fts) AS score,
               snippet(utt_fts, 0, char(2), char(3), ' … ', 30) AS snip
        FROM utt_fts WHERE utt_fts MATCH ?1),
      em AS (
        SELECT post_id AS pid, bm25(ep_fts) AS score,
               snippet(ep_fts, 1, char(2), char(3), ' … ', 30) AS snip
        FROM ep_fts WHERE ep_fts MATCH ?1),
      ranked AS (
        SELECT pid, MIN(score) AS score FROM (
          SELECT pid, score FROM um
          UNION ALL
          SELECT pid, score - 5 FROM em)   -- a title hit outranks a passing mention
        GROUP BY pid)`;
    const rows = (await DB.prepare(
      `${HITS}
       SELECT e.post_id, e.title, e.post_date, e.show, e.series, e.url, e.youtube_id,
              e.duration_secs, p.vs_slot, p.band, p.views, p.benchmark, p.n_neighbours,
              r.score,
              COALESCE((SELECT snip FROM em WHERE em.pid = e.post_id LIMIT 1),
                       (SELECT snip FROM um WHERE um.pid = e.post_id
                        ORDER BY score LIMIT 1)) AS snip
       FROM ranked r
       JOIN episodes e ON e.post_id = r.pid
       LEFT JOIN episode_perf p ON p.post_id = e.post_id
       WHERE 1=1${extra}
       ORDER BY ${EP_ORDERS[sort]} LIMIT ? OFFSET ?`)
      .bind(m, ...params, PER, pg * PER).all()).results;
    cnt = (await DB.prepare(
      `${HITS}
       SELECT COUNT(*) c FROM ranked r JOIN episodes e ON e.post_id = r.pid
       WHERE 1=1${extra}`).bind(m, ...params).first()).c;
    cards = rows.map(r => {
      const dur = r.duration_secs ? ` &middot; ${hhmm(r.duration_secs)}` : '';
      const badge = perfBadge(r.band, r.vs_slot, r.views, r.benchmark, r.n_neighbours);
      return `<div class="card">
        <div class="meta">${r.post_date.slice(0, 10)} &middot; ${esc(r.show || '')}
          ${r.series ? ' &middot; ' + esc(r.series) : ''}${dur} ${badge}</div>
        <div class="ttl"><a href="/ep/${r.post_id}?q=${eq}">${esc(r.title)}</a></div>
        <div class="snip">${mark(r.snip)}</div>
        <div class="links">
          <a href="/ep/${r.post_id}?q=${eq}">Open transcript</a>
          <a href="${esc(r.url || '#')}" target="_blank" rel="noopener">equitymates.com</a>
          ${r.youtube_id ? `<a href="https://youtu.be/${esc(r.youtube_id)}"
            target="_blank" rel="noopener">YouTube</a>` : ''}
        </div></div>`;
    });
    head = `<div class="count"><b>${num(cnt)}</b> episodes mention that &middot; ${orderTxt}</div>`;
  } else {
    const rows = (await DB.prepare(
      `SELECT u.post_id, u.seq, u.speaker, u.t_start, e.title, e.post_date, e.show,
              e.youtube_id, p.vs_slot, p.band, p.views, p.benchmark, p.n_neighbours,
              snippet(utt_fts, 0, char(2), char(3), ' … ', 24) AS snip,
              bm25(utt_fts) AS score
       FROM utt_fts
       JOIN utterances u ON u.post_id = utt_fts.post_id AND u.seq = utt_fts.seq
       JOIN episodes e ON e.post_id = u.post_id
       LEFT JOIN episode_perf p ON p.post_id = e.post_id
       WHERE utt_fts MATCH ?${extra}
       ORDER BY ${ORDERS[sort]} LIMIT ? OFFSET ?`)
      .bind(m, ...params, PER, pg * PER).all()).results;
    cnt = (await DB.prepare(
      `SELECT COUNT(*) c FROM utt_fts
       JOIN utterances u ON u.post_id = utt_fts.post_id AND u.seq = utt_fts.seq
       JOIN episodes e ON e.post_id = u.post_id
       WHERE utt_fts MATCH ?${extra}`).bind(m, ...params).first()).c;
    cards = rows.map(r => {
      const badge = perfBadge(r.band, r.vs_slot, r.views, r.benchmark, r.n_neighbours);
      const yt = (r.youtube_id && r.t_start !== null)
        ? `<a class="play" href="https://youtu.be/${esc(r.youtube_id)}?t=${r.t_start}"
             target="_blank" rel="noopener">Watch this moment</a>` : '';
      return `<div class="card">
        <div class="meta">${r.post_date.slice(0, 10)} &middot; ${esc(r.show || '')} ${badge}</div>
        <div class="snip">
          <span class="who">${esc(r.speaker || 'UNKNOWN')}</span>
          <span class="time">${hhmm(r.t_start)}</span>${mark(r.snip)}</div>
        <div class="links">
          <a href="/ep/${r.post_id}?q=${eq}">${esc((r.title || '').slice(0, 78))}</a>${yt}
        </div></div>`;
    });
    head = `<div class="count"><b>${num(cnt)}</b> moments where that was said &middot; ${orderTxt}</div>`;
  }

  if (!cards.length) {
    return html(page(`${q} - EM Archive`, bar
      + `<div class="empty">Nothing found for <b>${esc(q)}</b>.<br>
         Try fewer words, or check the show and date filters.</div>`));
  }

  const base = `/?q=${eq}&mode=${mode}&sort=${sort}${keep}`;
  let pager = '<div class="pager">';
  if (pg) pager += `<a href="${base}&p=${pg - 1}">&larr; Previous</a>`;
  if ((pg + 1) * PER < cnt) pager += `<a href="${base}&p=${pg + 1}">Next &rarr;</a>`;
  pager += `<span>page ${pg + 1} of ${num(Math.max(1, Math.ceil(cnt / PER)))}</span></div>`;

  return html(page(`${q} - EM Archive`, bar + head + perfNote + cards.join('') + pager));
}
