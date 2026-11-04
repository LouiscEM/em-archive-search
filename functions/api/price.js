/**
 * Share price for the stock check page (/ask-next/, 5 Nov 2026): today's price plus the
 * month-end close for the last ten years, AS TRADED AT THE TIME (Yahoo's history is
 * split-adjusted; priceFor undoes that) and the splits in between.
 *
 * GET /api/price?s=CSL.AX
 *
 * Not a public path: it sits behind the test bed's password like the page that calls it.
 * Yahoo's chart endpoint is unofficial; a licensed feed is needed before anything public.
 */
import { priceFor } from './ask.js';

const json = (body, status, cache) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache || 'no-store' } });

export async function onRequestGet({ request }) {
  const s = new URL(request.url).searchParams.get('s') || '';
  // Yahoo symbols only: letters, digits, dots and dashes (CSL.AX, BRK-B, 9988.HK).
  if (!/^[A-Za-z0-9.\-]{1,15}$/.test(s)) return json({ error: 'Unknown symbol' }, 400);
  const p = await priceFor([s, s]);
  if (!p) return json({ error: 'No price available' }, 404);
  return json({ symbol: p.symbol, currency: p.currency, price: p.price, asAt: p.asAt,
    months: p.closes, splits: p.splits }, 200, 'private, max-age=900');
}
