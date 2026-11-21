// POST   /api/waitlist   saves a signup (name, email, platform) and, when an email sender is configured, emails a 6-digit code.
// DELETE /api/waitlist   removes a signup; allowed only with the Idempotency-Key that created it (the site's Undo).
// Requests carry an Idempotency-Key header, so a retry or double click is answered once. Storage: see _waitlist-store.mjs.

import { CODE_ATTEMPTS, CODE_TTL_SECONDS, EMAIL, IDEMPOTENCY_KEY, PLATFORMS, clip, hashCode, idempotent, json, newCode, readBody, redis, sendCode, withinRateLimit } from './_waitlist-store.mjs';

async function issueCode(run, email, name) {
  const code = newCode();
  const sent = await sendCode(email, name, code);
  if (!sent) return false;
  await run([
    ['HSET', `waitlist:code:${email}`, 'hash', hashCode(email, code), 'left', CODE_ATTEMPTS],
    ['EXPIRE', `waitlist:code:${email}`, CODE_TTL_SECONDS],
  ]);
  return true;
}

async function join(run, request, body, key) {
  const email = clip(body.email, 254).toLowerCase();
  const name = clip(body.name, 80);
  const platform = PLATFORMS.has(body.platform) ? body.platform : 'mac-arm';
  const [added] = await run([['SADD', 'waitlist:emails', email]]);
  if (added === 1) {
    const now = Date.now();
    await run([
      ['HSET', `waitlist:${email}`, 'name', name, 'email', email, 'platform', platform, 'source', clip(body.source, 40), 'page', clip(body.page, 100),
        'country', clip(request.headers.get('x-vercel-ip-country'), 8), 'joinedAt', new Date(now).toISOString(), 'verified', '0', 'key', key || ''],
      ['ZADD', 'waitlist:joined', now, email],
      ['HINCRBY', 'waitlist:platforms', platform, 1],
    ]);
  }
  const verify = await issueCode(run, email, name);
  return { status: 200, body: { ok: true, already: added !== 1, verify } };
}

export async function POST(request) {
  const body = await readBody(request);
  if (!body) return json(400, { error: 'bad_json' });
  if (body.company) return json(200, { ok: true, verify: false }); // honeypot: bots get a quiet success
  if (!EMAIL.test(clip(body.email, 254))) return json(400, { error: 'bad_email' });

  const run = redis();
  if (!run) return json(503, { error: 'not_configured' });
  try {
    if (!(await withinRateLimit(run, request))) return json(429, { error: 'rate_limited' });
    return await idempotent(run, request, (key) => join(run, request, body, key));
  } catch (err) {
    console.error('waitlist', err);
    return json(502, { error: 'store_failed' });
  }
}

export async function DELETE(request) {
  const body = await readBody(request);
  const key = request.headers.get('idempotency-key') || '';
  if (!body || !EMAIL.test(clip(body.email, 254)) || !IDEMPOTENCY_KEY.test(key)) return json(400, { error: 'bad_request' });
  const email = clip(body.email, 254).toLowerCase();

  const run = redis();
  if (!run) return json(503, { error: 'not_configured' });
  try {
    if (!(await withinRateLimit(run, request))) return json(429, { error: 'rate_limited' });
    const [owner, platform] = await run([['HGET', `waitlist:${email}`, 'key'], ['HGET', `waitlist:${email}`, 'platform']]);
    if (!owner || owner !== key) return json(403, { error: 'not_yours' });
    await run([
      ['SREM', 'waitlist:emails', email], ['ZREM', 'waitlist:joined', email], ['DEL', `waitlist:${email}`, `waitlist:code:${email}`, `waitlist:idem:${key}`],
      ['HINCRBY', 'waitlist:platforms', platform || 'mac-arm', -1],
    ]);
    return json(200, { ok: true });
  } catch (err) {
    console.error('waitlist delete', err);
    return json(502, { error: 'store_failed' });
  }
}

export function GET() {
  return json(405, { error: 'method_not_allowed' });
}
