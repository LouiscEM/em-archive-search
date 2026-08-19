/**
 * Ask: semantic question answering over the archive, without Vectorize.
 *
 * Vectorize is a paid-plan product, so retrieval is done in two cheap stages instead:
 *   1. the existing full-text index narrows 162k lines to a few hundred candidates
 *   2. those candidates are ranked by MEANING using 8-bit embeddings stored in D1
 * That is ~0.4M multiply-adds per question, which a Worker does without noticing,
 * and it keeps the whole feature on the free tier.
 *
 * The model then has to justify every moment it picks. Anything it cannot justify is
 * dropped, and quotes are read back from the transcript rather than taken from the
 * model, so it cannot invent or reword what was said.
 */
import { page, html, esc, hhmm, num, ftsQuery, GREY, NAVY, CORAL, OFFWHITE }
  from './_shared.js';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
// Judging a shortlist is a classification task, not a 70B reasoning task. The fast
// 8B model is materially cheaper on the daily free allowance; the 70B model remains
// a fallback if structured output is unavailable on the fast endpoint.
const JUDGE_MODELS = ['@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
const SCALE = 127.0 / 0.36;     // must match export_vectors_d1.py
const CANDIDATES = 400;         // keyword shortlist before semantic ranking
const SHOWN = 24;               // candidates handed to the model
const GREEN = '#1B7F4B';

const EXAMPLES = ['the dumbest things Bryce and Ren have said',
  'boldest predictions that turned out wrong',
  'what did Bryce get wrong about property in 2021',
  'best advice ever given to a beginner',
  'times Alec changed his mind'];

const ALIASES = { ren: 'Alec Renehan', alec: 'Alec Renehan', bryce: 'Bryce Leske',
  sascha: 'Sascha Kelly', adam: 'Adam Keily', darcy: 'Darcy Cordell',
  maddy: 'Maddy Guest', sophie: 'Sophie Dicker' };

const SYSTEM = `You review podcast transcript excerpts from the Australian investing
show Equity Mates. You are given a user's question and numbered candidate excerpts.

Judge each candidate ONLY on whether it genuinely answers the question. Be decisive
and opinionated, but every pick must be justified from the excerpt itself.

Rules:
- Never invent or reword a quote. Refer to candidates by their number.
- If a candidate does not really fit, leave it out. A short honest list beats a padded one.
- If nothing fits, return an empty picks array and say so in the summary.
- "reason" must say concretely what in the excerpt makes it qualify, in one sentence.
- confidence: high only when the excerpt plainly answers the question on its own.

Return STRICT JSON only, no prose outside it:
{"summary":"<two sentences on what you found and how confident you are>",
 "picks":[{"n":<number>,"reason":"<why this qualifies>","confidence":"high|medium|low"}]}`;

/** Enforced shape for the judgement. Without this the models answer with Python
 *  dict literals and nothing parses. */
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          reason: { type: 'string' },
          confidence: { type: 'string' },
        },
        required: ['n', 'reason', 'confidence'],
      },
    },
  },
  required: ['summary', 'picks'],
};

/** Turn a parsed judgement into cards, dropping anything that does not point at a
 *  real candidate. The quote shown always comes from the transcript, never the model. */
function normaliseJudgement(d, cands) {
  const picks = [];
  for (const p of (d && d.picks) || []) {
    const n = parseInt(p && p.n, 10);
    if (!Number.isFinite(n) || n < 1 || n > cands.length) continue;
    // models sometimes answer confidence in prose ("Very confident")
    const raw = String((p && p.confidence) || '').toLowerCase();
    const confidence = raw.includes('high') || raw.includes('very') ? 'high'
      : raw.includes('low') || raw.includes('not') ? 'low' : 'medium';
    picks.push({ ...cands[n - 1], reason: String((p && p.reason) || '').slice(0, 400),
      confidence });
  }
  return { summary: String((d && d.summary) || '').slice(0, 600), picks };
}

/** Structured filters from plain English. Rules, not a model call: deterministic. */
function readFilters(q, speakers) {
  const low = q.toLowerCase(), named = [];
  for (const [alias, canon] of Object.entries(ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(low) && speakers.includes(canon)
        && !named.includes(canon)) named.push(canon);
  }
  for (const s of speakers) {
    // word boundaries, or a guest named "Ed" matches the "ed" in "predictions"
    const esc2 = s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!named.includes(s) && new RegExp(`\\b${esc2}\\b`).test(low)) named.push(s);
  }
  const years = (q.match(/\b20[0-2]\d\b/g) || []);
  return {
    speaker: named.length === 1 ? named[0] : null,
    year: years.length === 1 ? years[0] : null,
    named, years,
  };
}

function decode(b64) {
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    const c = bin.charCodeAt(i);
    out[i] = c > 127 ? c - 256 : c;
  }
  return out;
}

function quantise(vals) {
  const out = new Int8Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    out[i] = Math.max(-127, Math.min(127, Math.round(vals[i] * SCALE)));
  }
  return out;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Keywords that survive as an FTS shortlist. Stop-words would match everything. */
const STOP = new Set(['what', 'when', 'where', 'which', 'have', 'has', 'said', 'say',
  'says', 'the', 'and', 'for', 'about', 'from', 'that', 'this', 'with', 'they',
  'them', 'their', 'been', 'were', 'was', 'are', 'did', 'does', 'get', 'got',
  'things', 'thing', 'most', 'best', 'worst', 'ever', 'over', 'last', 'years',
  'year', 'made', 'make', 'ren', 'bryce', 'alec', 'wrong', 'right', 'dumb',
  'dumbest', 'boldest', 'times', 'time']);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const DB = env.DB;

  const form = `<form class="search" method="get" action="/ask">
    <div class="qrow">
      <input type="text" name="q" value="${esc(q)}" autofocus
             placeholder="Ask anything, e.g. what are the boldest calls Alec has made?">
      <button type="submit">Ask</button></div>
    <div class="examples">Try ${EXAMPLES.map(e =>
      `<a href="/ask?q=${encodeURIComponent(e)}">${esc(e)}</a>`).join(' ')}</div>
  </form>`;

  if (!q) {
    return html(page('Ask', `
      <h1>Ask the archive a question.</h1>
      <p class="lede">Not keyword search. This finds moments by meaning, then makes the
         model justify every one it picks, with a link to the exact second so you can
         check it.</p>
      ${form}
      <div class="empty">Every answer shows <b>who said it</b>, <b>when</b>, and
        <b>why it was chosen</b>.<br>
        Name a person or a year and the search narrows before it runs.</div>`, 'ask'));
  }

  const fail = msg => html(page('Ask', form
    + `<div class="empty" style="text-align:left"><b>Could not answer that.</b><br>
       ${esc(msg)}</div>`, 'ask'));

  if (!env.AI) return fail('Workers AI is not bound to this project.');

  try {
    const speakers = (await DB.prepare(
      `SELECT u.speaker FROM utterances u JOIN episodes e ON e.post_id=u.post_id
       WHERE e.status='publish' AND u.speaker IS NOT NULL GROUP BY u.speaker
       HAVING COUNT(DISTINCT u.post_id) >= 8`).all()).results.map(r => r.speaker);
    const f = readFilters(q, speakers);

    // ---- stage 1: keyword shortlist, filtered ----
    const words = (q.toLowerCase().match(/[a-z0-9']{3,}/g) || [])
      .filter(w => !STOP.has(w));
    const where = [], binds = [];
    if (f.speaker) { where.push('u.speaker = ?'); binds.push(f.speaker); }
    if (f.year) { where.push("substr(e.post_date,1,4) = ?"); binds.push(f.year); }
    const extra = where.length ? ' AND ' + where.join(' AND ') : '';

    let cands;
    if (words.length) {
      const m = words.map(w => `"${w}"`).join(' OR ');
      cands = (await DB.prepare(
        `SELECT u.post_id, u.seq, u.speaker, u.t_start, u.text, e.title, e.post_date,
                e.show, e.youtube_id
         FROM utt_fts
         JOIN utterances u ON u.post_id=utt_fts.post_id AND u.seq=utt_fts.seq
         JOIN episodes e ON e.post_id=u.post_id
         WHERE utt_fts MATCH ? AND e.status='publish'${extra}
         ORDER BY bm25(utt_fts) LIMIT ?`).bind(m, ...binds, CANDIDATES).all()).results;
    } else {
      cands = (await DB.prepare(
        `SELECT u.post_id, u.seq, u.speaker, u.t_start, u.text, e.title, e.post_date,
                e.show, e.youtube_id
         FROM utterances u JOIN episodes e ON e.post_id=u.post_id
         WHERE e.status='publish' AND LENGTH(u.text) > 200${extra} LIMIT ?`)
        .bind(...binds, CANDIDATES).all()).results;
    }
    if (!cands.length) return fail('No lines matched that, even loosely.');

    // ---- stage 2: rank the shortlist by meaning ----
    const emb = await env.AI.run(EMBED_MODEL, { text: [q] });
    const qv = quantise(emb.data[0]);
    const keys = cands.map(c => `(${c.post_id},${c.seq})`).join(',');
    const vecs = (await DB.prepare(
      `SELECT post_id, seq, v FROM vec WHERE (post_id, seq) IN (${keys})`).all()).results;
    const byId = new Map(vecs.map(v => [`${v.post_id}-${v.seq}`, decode(v.v)]));

    let ranked = cands.map(c => {
      const dv = byId.get(`${c.post_id}-${c.seq}`);
      return { ...c, score: dv ? dot(qv, dv) : -1, embedded: !!dv };
    }).sort((a, b) => b.score - a.score);
    const withVec = ranked.filter(r => r.embedded).length;
    ranked = ranked.slice(0, SHOWN);

    // ---- stage 3: the model must justify each pick ----
    const listing = ranked.map((c, i) =>
      `[${i + 1}] ${c.speaker} on ${c.post_date.slice(0, 10)} (${c.show}):\n"${
        (c.text || '').slice(0, 600)}"`).join('\n\n');
    let out = null, usedModel = null, lastErr = null;
    for (const model of JUDGE_MODELS) {
      try {
        // response_format forces valid JSON. Asking for JSON in the prompt is not
        // enough: these models reliably answer with PYTHON dict literals
        // ({'picks': [...]}), which JSON.parse rejects, so every answer came back
        // as "the model did not return usable JSON".
        const r = await env.AI.run(model, {
          messages: [{ role: 'system', content: SYSTEM },
            { role: 'user', content: `QUESTION: ${q}\n\nCANDIDATES:\n${listing}` }],
          max_tokens: 1600, temperature: 0.2,
          response_format: { type: 'json_schema', json_schema: JUDGE_SCHEMA },
        });
        // With a schema the response arrives already parsed; keep the string path
        // for older models and as a fallback if the schema is ever ignored.
        out = (r.response && typeof r.response === 'object')
          ? normaliseJudgement(r.response, ranked)
          : parseJudgement(String(r.response || ''), ranked);
        if (out && out.picks.length === 0 && !out.summary) throw new Error('empty');
        usedModel = model;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!out) {
      const msg = String(lastErr && lastErr.message || lastErr);
      return fail(msg.includes('neuron')
        ? 'Cloudflare Workers AI daily free allowance is used up. It resets at midnight UTC.'
        : msg.slice(0, 200));
    }

    const conf = { high: GREEN, medium: '#B8860B', low: GREY };
    const cards = out.picks.map(p => {
      const yt = (p.youtube_id && p.t_start !== null)
        ? `<a class="play" href="https://youtu.be/${esc(p.youtube_id)}?t=${p.t_start}"
             target="_blank" rel="noopener">Watch this moment</a>` : '';
      const c = conf[p.confidence] || GREY;
      return `<div class="card">
        <div class="meta">${p.post_date.slice(0, 10)} &middot; ${esc(p.show || '')}
          <span class="perf" style="color:${c};border-color:${c}">
            ${esc(String(p.confidence || '').toUpperCase())} CONFIDENCE</span></div>
        <div class="snip"><span class="who">${esc(p.speaker || '?')}</span>
          <span class="time">${hhmm(p.t_start)}</span>
          &ldquo;${esc((p.text || '').slice(0, 600))}&rdquo;</div>
        <div style="margin-top:12px;padding:10px 13px;background:${OFFWHITE};
                    border-left:3px solid ${CORAL};font-size:14px">
          <b style="color:${NAVY}">Why this one:</b> ${esc(p.reason)}</div>
        <div class="links"><a href="/ep/${p.post_id}?q=${encodeURIComponent(q)}">
          ${esc((p.title || '').slice(0, 74))}</a>${yt}</div></div>`;
    }).join('');

    const applied = [f.speaker && `speaker=${f.speaker}`, f.year && `year=${f.year}`]
      .filter(Boolean).join(', ');
    const empty = `<div class="empty" style="text-align:left"><b>Nothing in the archive
      convincingly answers that.</b><br>The model reviewed the closest matches and
      rejected them all rather than pad the answer. Try rephrasing, or widen it by
      dropping a name or a year.</div>`;

    return html(page(`${q} - Ask`, `
      <h1>${esc(q)}</h1>${form}
      <div class="verdict">${esc(out.summary)}</div>
      <div class="count"><b>${out.picks.length}</b> moments stood up &middot;
        reviewed ${ranked.length} of ${num(cands.length)} closest matches
        ${applied ? '&middot; narrowed to ' + esc(applied) : ''}
        <span class="right">${esc(usedModel || '')}</span></div>
      ${out.picks.length ? cards : empty}
      <div class="perfnote" style="margin-top:20px">Quotes are read back from the
        transcript, never written by the model. ${num(withVec)} of the shortlist had
        embeddings; the archive is still being embedded, so coverage grows daily.</div>`,
    'ask'));
  } catch (e) {
    const msg = String(e && e.message || e);
    return fail(msg.includes('neuron')
      ? 'Cloudflare Workers AI daily free allowance is used up. It resets at midnight UTC.'
      : msg.slice(0, 300));
  }
}

/** Models wrap JSON in prose or fences often enough to plan for it. */
function parseJudgement(raw, cands) {
  const txt = raw.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { summary: 'The model did not return usable JSON.', picks: [] };
  let d;
  try { d = JSON.parse(m[0]); }
  catch { return { summary: 'The model returned malformed JSON.', picks: [] }; }
  const picks = [];
  for (const p of (d.picks || [])) {
    const n = parseInt(p.n, 10);
    if (n >= 1 && n <= cands.length) {
      picks.push({ ...cands[n - 1],
        reason: String(p.reason || '').slice(0, 400),
        confidence: String(p.confidence || 'low').toLowerCase() });
    }
  }
  return { summary: String(d.summary || '').slice(0, 600), picks };
}
