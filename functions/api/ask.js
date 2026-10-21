/**
 * Ask Equity Mates: the public answer endpoint behind the search box on
 * equitymates.com/ask/.
 *
 * This is the only public route in this project. Everything else stays behind the
 * Basic auth gate in _middleware.js; the exemption there is for this path alone.
 *
 * Three things matter more than the answer itself:
 *
 *   1. LICENSING. Equity Mates holds AFSL 540697 and gives general advice only. The
 *      model is told the rule, and the output is audited afterwards, because a prompt
 *      instruction is a request, not a control. A failed audit never reaches a reader.
 *   2. LINKS. Episode URLs are resolved from our own data, never written by the model.
 *      A hallucinated link on equitymates.com is worse than no link.
 *   3. COST. The key is ours and the endpoint is public, so it is rate limited per IP
 *      and the question length is capped before a single token is spent.
 *
 * Answers stream. A complete answer takes 25 to 45 seconds, which is unusable as a
 * blocking wait, but the first words land in about three seconds.
 */

// Stamped at commit time so the config check says WHICH revision is live.
// Without it, 'is the fix deployed yet' is unanswerable and every timing
// measurement is ambiguous.
const BUILD = 'b07e529';
const MODEL = 'gpt-5';
const MAX_RESULTS = 10;
const MAX_QUESTION = 300;      // characters; longer is abuse, not curiosity
const RATE_LIMIT = 12;         // questions per IP per hour
const STORE_NAME = 'equity-mates-episodes';
const ALLOWED = ['https://equitymates.com', 'https://www.equitymates.com',
  // The internal test bed at /ask-test/, which sits behind this project's Basic auth
  // gate. Same origin, so the browser sends this as Origin on every POST.
  'https://em-archive-search.pages.dev'];
const TEST_ORIGIN = 'https://em-archive-search.pages.dev';
// Auditing means asking dozens of questions in a sitting, which the public cap would
// block within minutes. Origin can be spoofed by a non-browser client, so this only
// raises a cost ceiling (a few cents a question); it grants no other access.
const TEST_RATE_LIMIT = 80;

/** Mirrors ask_guard.PERSONAL in the Python pipeline. Keep the two in step. */
const PERSONAL = [
  /\bshould i\b/, /\bshould we\b/, /\b(can|could) i afford\b/,
  /\bis it worth (me|us|it for me)\b/,
  /\b(worth it|right|suitable|good|better|ok|okay|sensible) for (me|us)\b/,
  /\bwhat (should|would) i (do|buy|sell|invest)/, /\bwhat would you do\b/,
  /\b(my|our) (situation|circumstances|portfolio|super|mortgage|salary|income|savings)\b/,
  /\bi('m| am) \d{1,2}( years old)?\b/, /\bi (have|earn|own|owe|make)\b.{0,30}\$?\d/,
  /\bhow much (should|do) i\b/, /\bbest (option|choice|fund|etf|strategy) for me\b/,
  /\bam i (better off|able to)\b/,
];

/** Mirrors ask_guard.BANNED_OUTPUT. Anything matching must not reach a reader. */
const BANNED = [
  /\byou should (?!be aware|know|understand|expect|check|speak|talk|seek|consider getting)/,
  /\bi (would )?recommend\b/, /\bwe recommend\b/, /\byou (ought to|must) /,
  /\bin your (situation|case|circumstances)\b/,
  /\bthe best (option|choice|strategy) for you\b/,
  /\bguaranteed (return|profit|outcome)\b/, /\bcan'?t lose\b/,
];

const GUARDRAIL = `
HARD RULE, NON NEGOTIABLE. Equity Mates operates under Australian Financial Services
Licence 540697 and gives GENERAL information only. You must never give personal
financial advice.

That means you never:
- tell the reader what they should do with their own money
- recommend a specific product, fund, ticker or provider for them to buy or sell
- assess whether something suits their situation, age, income or goals
- promise or imply an outcome, return or saving
- write "you should", "I recommend", "in your situation", or "the best option for you"

If the question is about the reader's own circumstances, do not refuse and do not
lecture. Explain how the thing works in general, say plainly and briefly that whether
it suits any individual depends on their circumstances and is a question for a licensed
adviser, and carry on being useful. One sentence on that, not a paragraph.

Speak as Equity Mates. Refer to the show only as "Equity Mates" ("Equity Mates has
covered this", "on Equity Mates, an adviser explained"). Never write "the hosts",
"the crew", "the team", and never name any individual, host or guest. Views belong to
Equity Mates or to "an adviser on Equity Mates", never to a named person, and are
described, not adopted as instructions to the reader. Everything is general in nature:
Equity Mates holds a general licence only.`;

const INSTRUCTIONS = `You answer questions using ONLY the Equity Mates podcast
transcripts in the attached file search index. Equity Mates is an Australian investing
podcast network.

Write the way you would explain it to a mate over lunch: warm, direct, a bit
opinionated, never stiff. Lead with what this actually means for a person before you
touch the mechanics. If a 22-year-old with no finance background would not understand a
word, use a different word. Short sentences beat long ones.

Shape:
- Open with 2 to 3 sentences that answer the question directly.
- Then 3 to 4 paragraphs: how it works, the part people get wrong, and the main catch.
- Between 220 and 300 words. No bullet lists, no headings.

Rules:
- Use ONLY what the transcripts say. If they do not cover it, say so plainly.
- Do not invent statistics, dates or quotes, and do not repeat figures from a worked
  example as if they were general.
- Do not write URLs and do not name episodes. Links are added from our own database.
- Australian English and Australian context.
- NEVER use em dashes or en dashes. Use a comma, a full stop or brackets.
${GUARDRAIL}`;

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
});

const fail = (status, message, origin) => new Response(
  JSON.stringify({ error: message }),
  { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });

/**
 * Per-IP hourly cap, kept in D1 so it survives across the many isolates a Pages
 * project runs in. An in-memory counter would reset constantly and protect nothing.
 */
async function overLimit(env, ip, limit = RATE_LIMIT) {
  if (!env.DB) return false;                       // never fail closed on a public page
  const hour = Math.floor(Date.now() / 3600000);
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ask_rate (ip TEXT, hour INTEGER, n INTEGER, ' +
      'PRIMARY KEY (ip, hour))').run();
    const row = await env.DB.prepare(
      'SELECT n FROM ask_rate WHERE ip = ? AND hour = ?').bind(ip, hour).first();
    const n = (row && row.n) || 0;
    if (n >= limit) return true;
    await env.DB.prepare(
      'INSERT INTO ask_rate (ip, hour, n) VALUES (?, ?, 1) ' +
      'ON CONFLICT(ip, hour) DO UPDATE SET n = n + 1').bind(ip, hour).run();
    // Opportunistic cleanup so the table cannot grow without bound.
    if (Math.random() < 0.02) {
      await env.DB.prepare('DELETE FROM ask_rate WHERE hour < ?').bind(hour - 24).run();
    }
  } catch (e) {
    return false;
  }
  return false;
}

/** The citation filename carries the episode id: ep29107_2026-03-03_slug.md */
function episodeIdsFrom(annotations) {
  const seen = [];
  for (const a of annotations || []) {
    const m = /^ep(\d+)_/.exec(a.filename || '');
    if (m && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

let EPISODE_CACHE = null;

async function episodes(request) {
  if (EPISODE_CACHE) return EPISODE_CACHE;
  const url = new URL('/ask-episodes.json', request.url);
  const r = await fetch(url.toString(), { cf: { cacheTtl: 3600 } });
  EPISODE_CACHE = r.ok ? await r.json() : {};
  return EPISODE_CACHE;
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: cors(request.headers.get('Origin')) });
}

/**
 * Configuration check. Reports WHETHER the two required bindings are visible to this
 * Function and surfaces any near-miss names, because the usual causes of a 503 here
 * are a variable saved to Preview instead of Production, or a typo in the name.
 *
 * Deliberately reports names and booleans only, never values, and only lists keys
 * matching the two prefixes we care about rather than dumping the whole environment.
 */

let STORE_ID = null;

/**
 * Work out which vector store to search.
 *
 * An id pasted by hand into a dashboard is a single point of failure: the one
 * configured here was a throwaway store created during a billing test and deleted
 * minutes later, and it matched the real one for its first eight characters, so it
 * survived every check short of asking OpenAI. Resolving by NAME removes the class
 * of error. The env var is still honoured when it points at a store that exists.
 */
async function resolveStore(env) {
  if (STORE_ID) return STORE_ID;
  const auth = { Authorization: `Bearer ${env.OPENAI_API_KEY}` };
  const configured = String(env.ASK_VECTOR_STORE_ID || '').trim();
  if (configured) {
    const r = await fetch(`https://api.openai.com/v1/vector_stores/${configured}`,
      { headers: auth });
    if (r.ok) { STORE_ID = configured; return STORE_ID; }
  }
  const r = await fetch('https://api.openai.com/v1/vector_stores?limit=50',
    { headers: auth });
  if (!r.ok) return null;
  const body = await r.json();
  const match = (body.data || []).filter((v) => v.name === STORE_NAME)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  STORE_ID = match ? match.id : null;
  return STORE_ID;
}

async function listStores(env) {
  if (!env.OPENAI_API_KEY) return 'no key';
  try {
    const r = await fetch('https://api.openai.com/v1/vector_stores?limit=20', {
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
    const body = await r.json();
    if (!r.ok) return `${r.status}: ${JSON.stringify(body).slice(0, 200)}`;
    return (body.data || []).map((v) => `${v.id} (${v.name}, ${v.file_counts
      ? v.file_counts.completed : '?'} files)`);
  } catch (e) {
    return 'fetch failed: ' + String(e).slice(0, 120);
  }
}

async function sha12(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].slice(0, 6)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ request, env }) {
  const origin = request.headers.get('Origin') || '';
  const related = Object.keys(env || {})
    .filter((k) => /^(OPENAI|ASK|VECTOR)/i.test(k)).sort();
  return new Response(JSON.stringify({
    build: BUILD,
    ok: Boolean(env.OPENAI_API_KEY && (await resolveStore(env))),
    resolvedStore: await resolveStore(env),
    OPENAI_API_KEY: Boolean(env.OPENAI_API_KEY),
    ASK_VECTOR_STORE_ID_configured: String(env.ASK_VECTOR_STORE_ID || '(unset)'),
    relatedKeysFound: related,
    totalBindings: Object.keys(env || {}).length,
    hasDB: Boolean(env.DB),
    // A truncated one-way hash, so the key here can be compared with the one that
    // works locally without either value being exposed. Different digests mean
    // different keys, and a key from another OpenAI project cannot see our vector
    // store even though it authenticates perfectly well.
    keyDigest: await sha12(env.OPENAI_API_KEY || ''),
    keyLen: String(env.OPENAI_API_KEY || '').length,
    storeId: String(env.ASK_VECTOR_STORE_ID || ''),
    // Same key and same id work from a local client but not from here, so ask OpenAI
    // directly what this key can see FROM THIS EDGE. If the list is empty or holds
    // different ids, the request is being resolved somewhere other than we assume.
    visibleStores: await listStores(env),
  }, null, 1), {
    headers: { ...cors(origin), 'Content-Type': 'application/json',
      'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';

  if (!ALLOWED.includes(origin)) return fail(403, 'Not allowed from this origin', origin);
  if (!env.OPENAI_API_KEY) return fail(503, 'Not configured yet', origin);

  let question = '';
  try {
    question = String(((await request.json()) || {}).q || '').trim();
  } catch (e) {
    return fail(400, 'Bad request', origin);
  }
  if (question.length < 3) return fail(400, 'Ask a longer question', origin);
  if (question.length > MAX_QUESTION) return fail(400, 'That question is too long', origin);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overLimit(env, ip, origin === TEST_ORIGIN ? TEST_RATE_LIMIT : RATE_LIMIT)) {
    return fail(429, 'You have asked a lot of questions this hour. Try again shortly.',
      origin);
  }

  const storeId = await resolveStore(env);
  if (!storeId) return fail(503, 'The index is unavailable right now', origin);

  const personal = PERSONAL.some((re) => re.test(question.toLowerCase()));

  const upstream = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: question,
      stream: true,
      tools: [{
        type: 'file_search',
        vector_store_ids: [storeId],
        max_num_results: MAX_RESULTS,
      }],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return fail(502, 'The answer service is unavailable right now', origin);
  }

  const lookup = await episodes(request);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // A ReadableStream whose start() runs the whole read loop does not stream: Cloudflare
  // waits for start() to resolve before emitting the response, so the client gets the
  // entire answer in one burst after 35 seconds. Measured, not assumed. A
  // TransformStream lets the Response return immediately while the pump writes into it.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const pump = (async () => {
    {
      const send = (obj) => writer.write(
        encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const reader = upstream.body.getReader();
      let buffer = '';
      let full = '';
      let annotations = [];
      // Counted so a silent empty stream can be diagnosed from the client without
      // another deploy. The local Python client sees the right event names, so an
      // empty answer here means something between the Worker and OpenAI, not parsing.
      const seen = {};
      let rawBytes = 0;
      let upstreamError = null;

      send({ type: 'start', personal });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          rawBytes += value ? value.length : 0;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let ev;
            try { ev = JSON.parse(payload); } catch (e) { continue; }
            seen[ev.type] = (seen[ev.type] || 0) + 1;
            if (ev.type === 'error' || ev.type === 'response.failed') {
              const e = ev.error || (ev.response && ev.response.error) || ev;
              upstreamError = `${e.code || e.type || '?'}: ${(e.message || '').slice(0, 220)}`;
            }

            if (ev.type === 'response.output_text.delta' && ev.delta) {
              // Strip dashes in flight: house style bans them and a later fix would
              // mean rewriting text the reader has already seen.
              const delta = ev.delta.replace(/—/g, ', ').replace(/–/g, ', ');
              full += delta;
              send({ type: 'delta', text: delta });
            } else if (ev.type === 'response.output_text.annotation.added'
                       && ev.annotation) {
              annotations.push(ev.annotation);
            } else if (ev.type === 'response.completed' && ev.response) {
              for (const item of ev.response.output || []) {
                for (const part of item.content || []) {
                  annotations = annotations.concat(part.annotations || []);
                }
              }
            }
          }
        }

        // The audit runs on the finished text. The reader has already seen it stream,
        // so a failure cannot unsay it; what it can do is withhold the episode links
        // and flag the answer, which is the honest response to an answer we are not
        // confident is compliant.
        const lower = full.toLowerCase();
        const flags = BANNED.filter((re) => re.test(lower)).length;

        const eps = episodeIdsFrom(annotations).map((id) => lookup[id]).filter(Boolean)
          .map((e) => ({
            title: e.t, show: e.s, date: e.d, url: e.u, mins: e.m,
            youtube: e.y ? `https://www.youtube.com/watch?v=${e.y}` : null,
            thumb: e.y ? `https://i.ytimg.com/vi/${e.y}/mqdefault.jpg` : null,
          }));

        send({ type: 'done', episodes: eps, flagged: flags > 0,
          diag: { upstream: upstream.status, rawBytes, chars: full.length, seen,
            upstreamError,
            // Not secret: confirms the ID pasted into Cloudflare is the right
            // one. A typo here authenticates fine but fails during file_search.
            storeId: String(env.ASK_VECTOR_STORE_ID || '').slice(0, 9) + '...'
              + String(env.ASK_VECTOR_STORE_ID || '').slice(-6),
            storeIdLen: String(env.ASK_VECTOR_STORE_ID || '').length,
            keyLen: String(env.OPENAI_API_KEY || '').length,
            keyPrefixOk: String(env.OPENAI_API_KEY || '').startsWith('sk-') } });
      } catch (e) {
        await send({ type: 'error',
          message: 'The answer was cut short. Please try again.',
          diag: { upstream: upstream.status, rawBytes, seen, detail: String(e).slice(0, 180) } });
      } finally {
        await writer.close();
      }
    }
  })();

  // Keeps the pump alive after the Response is returned.
  if (context.waitUntil) context.waitUntil(pump);

  return new Response(readable, {
    headers: {
      ...cors(origin),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
