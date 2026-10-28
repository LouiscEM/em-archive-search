/**
 * Ask Equity Mates: the public answer endpoint behind the search box on
 * equitymates.com/ask/.
 *
 * This is the only public route in this project. Everything else stays behind the
 * Basic auth gate in _middleware.js; the exemption there is for this path alone.
 *
 * TWO STEPS, NOT ONE. The first version handed the question to the model with the
 * file_search tool: 25 to 45 seconds an answer, and minimal reasoning effort is not
 * allowed with that tool. Now we search the vector store ourselves (about 2 seconds)
 * and the model writes from those excerpts with no tools at minimal effort (about 6),
 * measured at 7.5 to 9.5 seconds in total against the same questions.
 *
 * EVERY ANSWER IS CHECKED BEFORE IT IS SEEN. Streaming raw text meant the advice audit
 * ran after the reader had read it, and the audit only caught phrases like "you
 * should", so "keep your global core... set a target mix and stick to it" reached a
 * reader who had said they had 100k invested. Now: personal questions are answered as
 * their general version, every answer is audited for advice phrases AND commands, a
 * failure is rewritten once under a stricter brief, and if that also fails the reader
 * gets a safe fallback instead. At 8 seconds the safety is affordable.
 *
 * REPEATS ARE CACHED. Thousands of questions a day are mostly the same few hundred, so
 * a normalised question is answered from D1 for a week. Personal questions are never
 * cached, so nothing a reader says about themselves is stored.
 *
 * LINKS come from our own data, never the model. COST is capped by question length and
 * a per-IP hourly limit.
 */

// Stamped at commit time so the config check says WHICH revision is live.
// Without it, 'is the fix deployed yet' is unanswerable and every timing
// measurement is ambiguous.
const BUILD = 'two-step-4';
const MODEL = 'gpt-5';
const EFFORT = 'minimal';
const SEARCH_RESULTS = 8;
// Bump when the prompt changes. Index growth is handled by the episode count in the key.
const CACHE_VERSION = 'v3';
const CACHE_DAYS = 7;
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

/** Mirrors ask_guard.IMPERATIVE: advice phrased as a command, sentence by sentence. */
const IMPERATIVE = new RegExp(
  '(?:^|[.!?]\\s+|\\n\\s*)' +
  '(build|add|keep|set|buy|sell|put|invest|allocate|rebalance|start|move|switch|hold|' +
  'diversify|consider|choose|pick|use|aim|target|stick|avoid|salary sacrifice|' +
  'top up|pay down|redraw|borrow|split|tilt|increase|reduce|cut|trim|dca|automate)\\b' +
  '(?! in mind)(?![- ]and[- ]forget)(?! to that)(?! on\\b)(?! up to\\b)' +
  '(?! simply)(?! another way)(?! differently)(?! it )(?! track)(?! records)', 'gi');

function audit(text) {
  const lower = (text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const out = BANNED.filter((re) => re.test(lower)).map((re) => re.source.slice(0, 30));
  const verbs = [...(text || '').matchAll(IMPERATIVE)].map((m) => m[1].toLowerCase());
  if (verbs.length) out.push('instructs the reader (' + [...new Set(verbs)].join(', ') + ')');
  return out;
}

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

const INSTRUCTIONS = `You answer questions using ONLY the numbered Equity Mates podcast
transcript excerpts provided with the question. Equity Mates is an Australian investing
podcast network.

Write the way you would explain it to a mate over lunch: warm and clear, never
stiff. Explain and describe; never instruct. Do not write sentences that tell the reader to do
something with their money ("set a target mix", "keep your core", "pick a cadence",
"automate the transfer"). Describe what investors commonly do instead ("many investors
set a target mix"). This matters more than sounding conversational. Lead with what this actually means for a person before you
touch the mechanics. If a 22-year-old with no finance background would not understand a
word, use a different word. Short sentences beat long ones.

Shape:
- Open with 2 to 3 sentences that answer the question directly.
- Then 3 to 4 paragraphs: how it works, the part people get wrong, and the main catch.
- Between 220 and 300 words. No bullet lists, no headings.

Scope, checked first:
- This tool exists to lift financial literacy. It answers questions about money:
  investing, shares, ETFs, super, property, tax, debt, budgeting, the economy, markets,
  companies and what Equity Mates has said about any of these.
- If the question is about anything else (jokes, funny or memorable moments, trivia,
  sport, food, entertainment, celebrities, the hosts' personal lives, or general
  knowledge unrelated to money), reply with exactly OUT_OF_SCOPE and nothing else.
- A money question asked casually is still in scope ("what's the deal with Nvidia",
  "favourite stocks Equity Mates has talked about").

Rules:
- Use ONLY what the transcripts say. If they do not cover it, say so plainly.
- Do not invent statistics, dates or quotes, and do not repeat figures from a worked
  example as if they were general.
- Do not write URLs and do not name episodes. Links are added from our own database.
- Australian English and Australian context.
- NEVER use em dashes or en dashes. Use a comma, a full stop or brackets.
${GUARDRAIL}`;

const PERSONAL_BRIEF = `
THIS QUESTION DESCRIBES THE READER'S OWN SITUATION. Ignore every personal detail in it:
amounts, age, income, what they hold. Answer only the GENERAL version of the question,
how investors generally think about it, in the third person ("many investors", "some
people", "Equity Mates has discussed"). Give no plan, no steps, no allocation and no
"strategy" for the reader. Say once that whether any approach suits them depends on
their circumstances and is a question for a licensed adviser.`;

const STRICT = `
YOUR PREVIOUS ATTEMPT BROKE THE LICENSING RULE. Rewrite it with no sentence that tells
the reader to do anything with their money. No commands ("keep", "set", "add", "build",
"pick"), no "you should", no "you must", no "in your situation". Describe how the thing
works and what investors commonly do, in the third person.`;

const FALLBACK = `This one is better answered by a person. Equity Mates gives general
information only, and we could not answer this question without it reading like
personal advice. The episodes below cover the topic, and the Equity Mates Advice Network
can connect you with a licensed adviser who can look at your situation.`.replace(/\n/g, ' ');

// Shown instead of an answer when a question is not about money. A fixed message, not a
// model-written one: a 27 Oct sweep asked for the best pizza in Sydney and got "not
// covered" followed by 273 words anyway, and "funniest thing said on Equity Mates" got a
// confident answer with five episodes. The page renders this as its own card.
const SCOPE_TITLE = "That one's a bit outside our lane";
const SCOPE = `Ask Equity Mates is here to help lift Australia's financial literacy, so
we've kept it focused on money: investing, super, property, tax and the markets, all
answered from what's been said on the show. Ask us anything along those lines and we'll
dig through the archive for you.`.replace(/\n/g, ' ');

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

/** Port of ask_guard.topic_key, so phrasings of one question share a cache entry. */
const LEAD = [/^(can you |could you |please )?(tell me|teach me|explain|describe|define)( me)?( all)?( about| what| how| the)?\b/,
  /^what (is|are|does|do)( a| an| the)?\b/, /^how (does|do)( a| an| the)?\b/, /^whats\b/, /^what's\b/,
  /^(i want to know|i'd like to know|help me understand)\b/, /^(a |an |the )/];
function topicKey(t) {
  let q = (t || '').normalize('NFKD').toLowerCase().replace(/[\u2019\u2018]/g, "'")
    .replace(/[^\w\s'$]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let ch = true; ch;) {
    ch = false;
    for (const re of LEAD) { const n = q.replace(re, ' ').trim(); if (n !== q) { q = n; ch = true; } }
  }
  q = q.replace(/\b(mean|means|work|works|about|exactly|explained|in australia|for beginners)\b/g, ' ')
    .replace(/\b(a|an|the|of|to|for|is|are|do|does|my|your)\b/g, ' ');
  return [...new Set(q.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean))].sort().join(' ');
}

async function cacheGet(env, key) {
  if (!env.DB) return null;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS ask_cache (k TEXT PRIMARY KEY, ' +
      'payload TEXT, created INTEGER, hits INTEGER DEFAULT 0)').run();
    const row = await env.DB.prepare('SELECT payload, created FROM ask_cache WHERE k = ?')
      .bind(key).first();
    if (!row || Date.now() - row.created > CACHE_DAYS * 864e5) return null;
    // Hit counts are the demand signal: the most asked live questions are the next
    // pages worth writing, and nothing personal is ever cached, so this stays clean.
    await env.DB.prepare('UPDATE ask_cache SET hits = hits + 1 WHERE k = ?').bind(key).run();
    return JSON.parse(row.payload);
  } catch (e) { return null; }
}

async function cachePut(env, key, payload) {
  if (!env.DB) return;
  try {
    await env.DB.prepare('INSERT INTO ask_cache (k, payload, created, hits) VALUES (?, ?, ?, 0) ' +
      'ON CONFLICT(k) DO UPDATE SET payload = excluded.payload, created = excluded.created')
      .bind(key, JSON.stringify(payload), Date.now()).run();
  } catch (e) { /* a cache write failing must never fail the answer */ }
}

async function openai(env, path, body) {
  const r = await fetch('https://api.openai.com/v1' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

async function search(env, storeId, question) {
  const d = await openai(env, `/vector_stores/${storeId}/search`,
    { query: question, max_num_results: SEARCH_RESULTS });
  return (d.data || []).map((x) => ({
    file: x.filename || '', score: x.score || 0,
    text: (x.content || []).map((c) => c.text || '').join(' '),
  }));
}

async function write(env, question, chunks, extra) {
  const excerpts = chunks.map((c, i) => `[${i + 1}] ${c.text.slice(0, 1800)}`).join('\n\n');
  const d = await openai(env, '/responses', {
    model: MODEL, reasoning: { effort: EFFORT }, instructions: INSTRUCTIONS + (extra || ''),
    input: `Question: ${question}\n\nExcerpts:\n${excerpts}`,
  });
  const text = (d.output || []).flatMap((o) => o.content || []).map((c) => c.text || '').join('');
  // House style bans dashes; strip the space citation markers leave before punctuation.
  return text.replace(/\u2014|\u2013/g, ', ').replace(/[ \t]+([.,;:!?)])/g, '$1').trim();
}

/** Episodes behind the excerpts, best first, each with the moment the excerpt starts. */
function episodesFrom(chunks, lookup) {
  const out = [];
  for (const c of chunks) {
    const m = /^ep(\d+)_/.exec(c.file);
    const e = m && lookup[m[1]];
    if (!e || out.some((x) => x.id === m[1])) continue;
    // Transcript excerpts carry speaker stamps: [12:34](https://youtube...&t=754s)
    const ts = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]\((https:\/\/www\.youtube\.com\/watch\?v=[\w-]+&t=\d+s)\)/.exec(c.text);
    out.push({ id: m[1], title: e.t, show: e.s, date: e.d, url: e.u, mins: e.m,
      youtube: e.y ? `https://www.youtube.com/watch?v=${e.y}` : null,
      thumb: e.y ? `https://i.ytimg.com/vi/${e.y}/mqdefault.jpg` : null,
      moment: ts ? { label: ts[1], url: ts[2] } : null });
    if (out.length === 5) break;
  }
  return out;
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

  const personal = PERSONAL.some((re) => re.test(question.toLowerCase().replace(/\u2019/g, "'")));
  // The episode count is part of the key, so when the nightly job adds episodes and
  // redeploys the lookup, every saved answer from the smaller index is ignored. Without
  // this a week-old answer could keep missing the newest episode on its topic.
  const lookup = await episodes(request);
  const key = `${CACHE_VERSION}|n${Object.keys(lookup).length}|${topicKey(question)}`;
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (obj) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const pump = (async () => {
    const t0 = Date.now();
    const timing = {};
    try {
      await send({ type: 'start', personal });

      if (!personal) {
        const hit = await cacheGet(env, key);
        if (hit) {
          await send({ type: 'delta', text: hit.text });
          await send({ type: 'done', ...hit.meta, cached: true, ms: Date.now() - t0 });
          return;
        }
      }

      const storeId = await resolveStore(env);
      if (!storeId) throw new Error('index unavailable');

      await send({ type: 'stage', stage: 'searching' });
      const chunks = await search(env, storeId, question);
      timing.search = Date.now() - t0;

      await send({ type: 'stage', stage: 'writing' });
      const brief = personal ? PERSONAL_BRIEF : '';
      let text = await write(env, question, chunks, brief);
      if (/^\W*OUT_OF_SCOPE\b/.test(text)) {
        const meta = { episodes: [], offTopic: true, title: SCOPE_TITLE, fallback: false,
          retried: false, personal };
        if (!personal) await cachePut(env, key, { text: SCOPE, meta });
        await send({ type: 'delta', text: SCOPE });
        await send({ type: 'done', ...meta, cached: false, ms: Date.now() - t0 });
        return;
      }
      let flags = audit(text);
      let retried = false;
      if (flags.length) {
        await send({ type: 'stage', stage: 'checking' });
        const again = await write(env, question, chunks, brief + STRICT);
        const againFlags = audit(again);
        retried = true;
        if (againFlags.length < flags.length) { text = again; flags = againFlags; }
      }
      const fallback = flags.length > 0;
      if (fallback) text = FALLBACK;
      timing.total = Date.now() - t0;

      const meta = { episodes: episodesFrom(chunks, lookup), flagged: false, fallback,
        retried, personal, auditOnFirstDraft: retried ? 'failed' : 'passed' };
      // Only clean, general answers are cached: never a personal question, never a
      // fallback, so a bad answer cannot be served a thousand times.
      if (!personal && !fallback) await cachePut(env, key, { text, meta });

      await send({ type: 'delta', text });
      await send({ type: 'done', ...meta, cached: false, ms: timing.total, timing });
    } catch (e) {
      await send({ type: 'error', message: 'Something went wrong answering that. Please try again.',
        detail: String(e).slice(0, 180) });
    } finally {
      await writer.close();
    }
  })();

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
