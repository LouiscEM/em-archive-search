/** Single episode: metadata, tags and the full speaker-attributed transcript. */
import { page, html, esc, hhmm, num, pct, perfBadge } from '../_shared.js';

export async function onRequestGet({ params, request, env }) {
  const id = parseInt(params.id, 10);
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  if (!Number.isFinite(id)) {
    return html(page('Not found', '<div class="empty">No such episode.</div>'), 404);
  }
  const DB = env.DB;

  const e = await DB.prepare(
    `SELECT e.*, p.vs_slot, p.band, p.views, p.benchmark, p.n_neighbours
     FROM episodes e LEFT JOIN episode_perf p ON p.post_id = e.post_id
     WHERE e.post_id = ?`).bind(id).first();
  if (!e) {
    return html(page('Not found', '<div class="empty">No such episode.</div>'), 404);
  }

  const tags = (await DB.prepare(
    'SELECT domain, name FROM taxonomy WHERE post_id = ? ORDER BY domain')
    .bind(id).all()).results;
  const turns = (await DB.prepare(
    'SELECT speaker, t_start, text FROM utterances WHERE post_id = ? ORDER BY seq')
    .bind(id).all()).results;

  // highlight the search terms that brought the user here
  const terms = (q.match(/[\w&'-]{2,}/g) || []).map(t =>
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const rx = terms.length ? new RegExp(`(${terms.join('|')})`, 'gi') : null;
  const hl = t => (rx ? esc(t).replace(rx, '<mark>$1</mark>') : esc(t));

  const badge = perfBadge(e.band, e.vs_slot, e.views, e.benchmark, e.n_neighbours);
  const body = [`<div class="card ep">
    <h1>${esc(e.title)}</h1>
    <div class="meta">${e.post_date.slice(0, 10)} &middot; ${esc(e.show || '')}
      ${e.series ? ' &middot; ' + esc(e.series) : ''}
      ${e.duration_secs ? ' &middot; ' + hhmm(e.duration_secs) : ''} ${badge}</div>
    <div class="links">
      <a href="${esc(e.url || '#')}" target="_blank" rel="noopener">equitymates.com</a>
      ${e.youtube_id ? `<a href="https://youtu.be/${esc(e.youtube_id)}"
        target="_blank" rel="noopener">YouTube</a>` : ''}
      <a href="/?q=${encodeURIComponent(q)}&mode=moments">Back to search</a></div>
    <p style="margin-top:12px">${esc(e.description || '')}</p>
    <div class="tags">${tags.slice(0, 24).map(t => `<i>${esc(t.name)}</i>`).join('')}</div>
  </div>`];

  if (turns.length) {
    body.push('<div class="card">');
    for (const t of turns) {
      body.push(`<div class="turn">
        <span class="who">${esc(t.speaker || '?')}</span>
        <span class="time">${hhmm(t.t_start)}</span>${hl(t.text)}</div>`);
    }
    body.push('</div>');
  } else {
    body.push('<div class="empty">No transcript for this episode yet.</div>');
  }
  return html(page(e.title, body.join('')));
}
