// POST /api/waitlist-verify   checks the 6-digit code emailed by /api/waitlist and marks the signup verified.
// A code works for 10 minutes and allows 5 tries. Storage: see _waitlist-store.mjs.

import { timingSafeEqual } from 'node:crypto';
import { EMAIL, clip, hashCode, json, readBody, redis, withinRateLimit } from './_waitlist-store.mjs';

const CODE = /^[0-9]{6}$/;
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function POST(request) {
  const body = await readBody(request);
  if (!body) return json(400, { error: 'bad_json' });
  const email = clip(body.email, 254).toLowerCase();
  const code = clip(body.code, 6);
  if (!EMAIL.test(email) || !CODE.test(code)) return json(400, { error: 'bad_code' });

  const run = redis();
  if (!run) return json(503, { error: 'not_configured' });
  try {
    if (!(await withinRateLimit(run, request))) return json(429, { error: 'rate_limited' });
    const slot = `waitlist:code:${email}`;
    const [stored] = await run([['HGET', slot, 'hash']]);
    if (!stored) return json(410, { error: 'expired' });
    const [left] = await run([['HINCRBY', slot, 'left', -1]]);
    if (left < 0) { await run([['DEL', slot]]); return json(410, { error: 'expired' }); }
    if (!sameHash(stored, hashCode(email, code))) return json(400, { error: 'bad_code' });
    await run([['DEL', slot], ['HSET', `waitlist:${email}`, 'verified', '1', 'verifiedAt', new Date().toISOString()]]);
    return json(200, { ok: true });
  } catch (err) {
    console.error('waitlist verify', err);
    return json(502, { error: 'store_failed' });
  }
}

export function GET() {
  return json(405, { error: 'method_not_allowed' });
}
