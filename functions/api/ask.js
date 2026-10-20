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

const MODEL = 'gpt-5';
const MAX_RESULTS = 10;
const MAX_QUESTION = 300;      // characters; longer is abuse, not curiosity
const RATE_LIMIT = 12;         // questions per IP per hour
const ALLOWED = ['https://equitymates.com', 'https://www.equitymates.com'];

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

Describe what the hosts and guests have said. Attribute views to them rather than
adopting them as instructions to the reader.`;

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
async function overLimit(env, ip) {
  if (!env.DB) return false;                       // never fail closed on a public page
  const hour = Math.floor(Date.now() / 3600000);
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ask_rate (ip TEXT, hour INTEGER, n INTEGER, ' +
      'PRIMARY KEY (ip, hour))').run();
    const row = await env.DB.prepare(
      'SELECT n FROM ask_rate WHERE ip = ? AND hour = ?').bind(ip, hour).first();
    const n = (row && row.n) || 0;
    if (n >= RATE_LIMIT) return true;
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

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';

  if (!ALLOWED.includes(origin)) return fail(403, 'Not allowed from this origin', origin);
  if (!env.OPENAI_API_KEY) return fail(503, 'Not configured yet', origin);
  if (!env.ASK_VECTOR_STORE_ID) return fail(503, 'No index configured', origin);

  let question = '';
  try {
    question = String(((await request.json()) || {}).q || '').trim();
  } catch (e) {
    return fail(400, 'Bad request', origin);
  }
  if (question.length < 3) return fail(400, 'Ask a longer question', origin);
  if (question.length > MAX_QUESTION) return fail(400, 'That question is too long', origin);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overLimit(env, ip)) {
    return fail(429, 'You have asked a lot of questions this hour. Try again shortly.',
      origin);
  }

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
        vector_store_ids: [env.ASK_VECTOR_STORE_ID],
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

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const reader = upstream.body.getReader();
      let buffer = '';
      let full = '';
      let annotations = [];

      send({ type: 'start', personal });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let ev;
            try { ev = JSON.parse(payload); } catch (e) { continue; }

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

        send({ type: 'done', episodes: eps, flagged: flags > 0 });
      } catch (e) {
        send({ type: 'error', message: 'The answer was cut short. Please try again.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...cors(origin),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
