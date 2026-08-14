/**
 * Shared rendering and query helpers for the Equity Mates Archive Search.
 *
 * Ported from serve.py. The HTML is produced on the server exactly as it was in
 * the Python version, so there is no client-side framework and nothing to hydrate.
 */
import { LOGO_B64, LOGO_W, LOGO_H } from './_logo.js';

export const NAVY = '#18263B', CORAL = '#F15959', OFFWHITE = '#F5F6F8';
export const BODY = '#3A4A5C', RULE = '#D0D5DD', GREY = '#8A97A8';

export const EXAMPLES = ['rare earths', 'lithium', 'buy now pay later',
  'dollar cost averaging', 'Novo Nordisk', 'franking credits', 'first home buyer',
  'AI bubble'];

export const SORT_LABELS = [['new', 'Newest first'], ['old', 'Oldest first'],
  ['rel', 'Best match'], ['perf', 'Best performing']];

export const ORDERS = {
  new: 'e.post_date DESC, u.seq', old: 'e.post_date ASC, u.seq',
  rel: 'score', perf: 'p.vs_slot IS NULL, p.vs_slot DESC',
};
export const EP_ORDERS = {
  new: 'e.post_date DESC', old: 'e.post_date ASC',
  rel: 'score', perf: 'p.vs_slot IS NULL, p.vs_slot DESC',
};

const BANDS = {
  top: ['Top 10%', '#1B7F4B'], above: ['Above slot', '#2E7D32'],
  typical: ['Typical', GREY], below: ['Below slot', '#B4553F'],
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** FTS5 snippets are requested with char(2)/char(3) sentinels so the text can be
 *  HTML-escaped first and only then turned into <mark> tags. */
export function mark(snip) {
  return esc(snip).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');
}

export function hhmm(s) {
  if (s === null || s === undefined) return '';
  const n = Math.floor(s);
  const pad = v => String(v).padStart(2, '0');
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${pad(Math.floor((n % 3600) / 60))}:${pad(n % 60)}`
    : `${Math.floor(n / 60)}:${pad(n % 60)}`;
}

export function pct(v, digits = 0) {
  const s = (v * 100).toFixed(digits);
  return (v > 0 ? '+' : '') + s + '%';
}

export function num(v) {
  return Number(v ?? 0).toLocaleString('en-AU');
}

/**
 * Turn free text into a safe FTS5 expression.
 * User input never reaches MATCH unquoted: a stray '*' or '"' is a syntax error
 * and OR/NEAR are reserved words. Every token is quoted, giving an implicit AND
 * of literal terms, with "..." preserved as a phrase.
 */
export function ftsQuery(q) {
  q = (q || '').trim();
  if (!q) return null;
  const phrases = [...q.matchAll(/"([^"]+)"/g)].map(m => m[1].trim()).filter(Boolean);
  const rest = q.replace(/"[^"]+"/g, ' ');
  const terms = (rest.match(/[\w&.'-]+/g) || []).filter(t => t.length > 1);
  const parts = [...phrases, ...terms].map(t => `"${t.replace(/"/g, '')}"`);
  return parts.length ? parts.join(' AND ') : null;
}

export function perfBadge(band, vsSlot, views, bench, n) {
  if (!band || vsSlot === null || vsSlot === undefined) return '';
  const [label, colour] = BANDS[band] || ['', GREY];
  const tip = `${num(views)} views in its first 28 days vs ${num(Math.round(bench))} `
    + `for the ${n} episodes either side of it`;
  return `<span class="perf" style="color:${colour};border-color:${colour}" `
    + `title="${esc(tip)}">${label} &middot; ${pct(vsSlot)} vs slot</span>`;
}

export const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:${OFFWHITE};color:${BODY};
 font-family:'Franklin Gothic Book','Franklin Gothic',Arial,Helvetica,sans-serif;
 font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:${NAVY};text-decoration:none}
a:hover{text-decoration:underline}
header{background:${NAVY}}
.hbar{max-width:940px;margin:0 auto;padding:20px 24px;display:flex;align-items:center;gap:16px}
.hbar img{height:28px;display:block}
.hbar .divider{width:1px;height:22px;background:rgba(255,255,255,.22)}
.hbar .name{color:#fff;font-size:15px;letter-spacing:.3px;opacity:.92}
.wrap{max-width:940px;margin:0 auto;padding:32px 24px 72px}
.hero{margin-bottom:26px}
.hero h1{color:${NAVY};font-size:30px;line-height:1.2;margin:0 0 8px;font-weight:bold}
.hero p{margin:0;color:${GREY};font-size:15px;max-width:620px}
form.search{margin-bottom:8px}
.qrow{display:flex;gap:0;box-shadow:0 1px 3px rgba(24,38,59,.08)}
input[type=text]{flex:1;min-width:0;padding:15px 17px;font-size:16px;
 border:1px solid ${RULE};border-right:0;background:#fff;color:${NAVY};
 font-family:inherit;border-radius:0}
input[type=text]::placeholder{color:${GREY}}
input[type=text]:focus{outline:0;border-color:${NAVY}}
button{padding:15px 26px;background:${CORAL};color:#fff;border:0;font-size:15px;
 font-weight:bold;cursor:pointer;font-family:inherit;white-space:nowrap}
button:hover{background:#dc4b4b}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
select,input[type=date]{padding:8px 10px;border:1px solid ${RULE};background:#fff;
 color:${BODY};font-family:inherit;font-size:13px;border-radius:0}
.seg{display:inline-flex;border:1px solid ${RULE};background:#fff;overflow:hidden}
.seg a{padding:8px 15px;font-size:13px;color:${BODY};border-right:1px solid ${RULE}}
.seg a:last-child{border-right:0}
.seg a:hover{text-decoration:none;background:${OFFWHITE}}
.seg a.on{background:${NAVY};color:#fff;font-weight:bold}
.examples{margin-top:14px;font-size:13px;color:${GREY};line-height:2.1}
.examples a{color:${NAVY};background:#fff;border:1px solid ${RULE};
 padding:5px 11px;margin-right:6px;white-space:nowrap}
.examples a:hover{text-decoration:none;border-color:${NAVY}}
.count{font-size:13px;color:${GREY};margin:26px 0 12px;padding-bottom:10px;
 border-bottom:1px solid ${RULE}}
.count b{color:${NAVY};font-size:15px}
.card{background:#fff;border:1px solid ${RULE};padding:16px 18px;margin-bottom:10px;
 transition:border-color .12s}
.card:hover{border-color:${GREY}}
.meta{font-size:12px;color:${GREY};margin-bottom:6px;text-transform:uppercase;
 letter-spacing:.5px}
.ttl{font-weight:bold;color:${NAVY};font-size:16px;margin-bottom:8px;line-height:1.35}
.snip{font-size:14.5px;color:${BODY}}
mark{background:#FFE9A8;color:${NAVY};padding:1px 2px;font-weight:bold}
.who{display:inline-block;background:${NAVY};color:#fff;font-size:11px;padding:3px 9px;
 margin-right:9px;font-weight:bold;letter-spacing:.4px;vertical-align:1px}
.time{color:${CORAL};font-weight:bold;font-size:13px;margin-right:9px;
 font-variant-numeric:tabular-nums}
.links{margin-top:11px;font-size:12.5px;display:flex;gap:16px;flex-wrap:wrap}
.links a{color:${GREY}}
.links a:hover{color:${NAVY}}
.links a.play{color:${CORAL};font-weight:bold}
.perf{display:inline-block;border:1px solid;padding:1px 7px;font-size:10.5px;
 font-weight:bold;letter-spacing:.3px;margin-left:8px;text-transform:none;
 cursor:help;background:#fff}
.perfnote{font-size:12.5px;color:${GREY};margin:-4px 0 14px}
.pager{margin-top:26px;display:flex;gap:8px;align-items:center}
.pager a{padding:10px 18px;border:1px solid ${RULE};background:#fff;font-size:14px}
.pager a:hover{text-decoration:none;border-color:${NAVY}}
.pager span{color:${GREY};font-size:13px;margin-left:6px}
.empty{background:#fff;border:1px solid ${RULE};padding:44px 28px;text-align:center;
 color:${GREY};font-size:15px;line-height:1.9}
.empty b{color:${NAVY}}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;
 background:${RULE};border:1px solid ${RULE};margin-bottom:28px}
.stat{background:${NAVY};color:#fff;padding:16px 18px}
.stat b{display:block;font-size:26px;line-height:1.2;font-weight:bold}
.stat span{font-size:10.5px;color:${GREY};letter-spacing:.9px}
.stat small{display:block;font-size:11px;color:${GREY};margin-top:3px;
 letter-spacing:0;text-transform:none}
.ep h1{color:${NAVY};font-size:25px;margin:0 0 8px;line-height:1.25}
.ep p{font-size:14.5px}
.tags{margin-top:12px;font-size:12px;color:${GREY};line-height:2}
.tags i{background:${OFFWHITE};border:1px solid ${RULE};padding:3px 9px;
 margin-right:5px;font-style:normal}
.turn{padding:11px 0;border-bottom:1px solid ${OFFWHITE};font-size:14.5px}
.turn:last-child{border-bottom:0}
footer{color:${GREY};font-size:12.5px;margin-top:44px;border-top:1px solid ${RULE};
 padding-top:16px;line-height:1.8}
@media(max-width:620px){
  .qrow{flex-wrap:wrap} input[type=text]{border-right:1px solid ${RULE}}
  button{width:100%} .hero h1{font-size:24px}
}`;

export function page(title, body) {
  const logo = LOGO_B64
    ? `<img src="data:image/png;base64,${LOGO_B64}" width="${Math.round(LOGO_W / 2)}"
         height="${Math.round(LOGO_H / 2)}" alt="Equity Mates">`
    : `<div style="color:#fff;font-weight:bold;font-size:20px">Equity Mates</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><div class="hbar">
  <a href="/">${logo}</a><div class="divider"></div>
  <div class="name">Archive Search</div>
</div></header>
<div class="wrap">${body}
<footer>Every episode Equity Mates has published, searchable by what was actually
said. Timecodes link straight to that moment on YouTube where a video exists.<br>
798 episodes have no transcript yet and will not appear in Moments results.</footer>
</div></body></html>`;
}

export function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, max-age=60',
    },
  });
}
