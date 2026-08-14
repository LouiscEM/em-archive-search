/**
 * Password gate for the whole archive search.
 *
 * Same pattern as the analytics dashboard: Cloudflare Pages runs this before any
 * route, so it protects the search results and transcripts, not just a landing page.
 *
 * The password lives in the ARCHIVE_PASSWORD environment variable, set as a Secret
 * in the Pages project settings. It is never sent to the browser.
 *
 * If ARCHIVE_PASSWORD is missing this denies every request rather than falling
 * through. A misconfigured gate should break the site, not quietly publish ten
 * years of unreleased-adjacent transcripts.
 */

const REALM = 'Equity Mates Archive';

function challenge(message) {
  return new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/** Constant-time compare, so response timing cannot be used to guess the password. */
function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const expected = env.ARCHIVE_PASSWORD;

  if (!expected) {
    return new Response(
      'ARCHIVE_PASSWORD is not configured. Set it as a Secret in the Pages project.',
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return challenge('Password required.');

  let supplied = '';
  try {
    const decoded = atob(header.slice(6));
    supplied = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return challenge('Malformed credentials.');
  }

  if (!equal(await sha256(supplied), await sha256(expected))) {
    return challenge('Incorrect password.');
  }
  return next();
}
