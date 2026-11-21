// Shared by /api/waitlist and /api/waitlist-verify. Vercel does not route files that start with "_".
// Storage is Upstash Redis over its REST API, so the site needs no package.json or install step.
//
// Keys:
//   waitlist:emails          set of every email, so a repeat signup is not counted twice
//   waitlist:joined          sorted set, email scored by signup time (ms)
//   waitlist:<email>         hash: name, email, platform, source, page, country, joinedAt, verified
//   waitlist:platforms       hash: mac-arm / mac-intel / windows counters
//   waitlist:idem:<key>      the JSON answer already given for an Idempotency-Key (24 hours)
//   waitlist:code:<email>    hash: sha256 of the emailed code, attempts left (10 minutes)
//   waitlist:rl:<ip>         requests from one address this hour (rate limit)

import { createHash, randomInt } from 'node:crypto';

export const PLATFORMS = new Set(['mac-arm', 'mac-intel', 'windows']);
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,80}$/;
export const CODE_TTL_SECONDS = 600;
export const CODE_ATTEMPTS = 5;
const IDEMPOTENCY_TTL_SECONDS = 86400;
const REQUESTS_PER_HOUR = 20;

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
export const hashCode = (email, code) => createHash('sha256').update(`${email}:${code}`).digest('hex');
export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

// The Vercel Upstash integration names these KV_REST_API_*; a database made in Upstash's own console uses UPSTASH_REDIS_REST_*.
export function redis(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return async (commands) => {
    const response = await fetch(`${url.replace(/\/$/, '')}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(commands) });
    if (!response.ok) throw new Error(`redis ${response.status}`);
    const results = await response.json();
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(`redis ${failed.error}`);
    return results.map((r) => r.result);
  };
}

export async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch (err) {
    return null;
  }
}

export async function withinRateLimit(run, request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const [hits] = await run([['INCR', `waitlist:rl:${ip}`], ['EXPIRE', `waitlist:rl:${ip}`, 3600, 'NX']]);
  return hits <= REQUESTS_PER_HOUR;
}

/* Idempotency: the first request with a key does the work and stores its answer;
   any repeat of that key gets the stored answer and does nothing. */
export async function idempotent(run, request, work) {
  const key = request.headers.get('idempotency-key') || '';
  if (!IDEMPOTENCY_KEY.test(key)) { const { status, body } = await work(''); return json(status, body); }
  const slot = `waitlist:idem:${key}`;
  const [claimed] = await run([['SET', slot, 'pending', 'NX', 'EX', IDEMPOTENCY_TTL_SECONDS]]);
  if (claimed !== 'OK') {
    const [stored] = await run([['GET', slot]]);
    if (stored && stored !== 'pending') { const { status, body } = JSON.parse(stored); return json(status, body); }
    return json(409, { error: 'in_progress' });
  }
  try {
    const { status, body, remember = true } = await work(key);
    if (remember) await run([['SET', slot, JSON.stringify({ status, body }), 'EX', IDEMPOTENCY_TTL_SECONDS]]);
    else await run([['DEL', slot]]);
    return json(status, body);
  } catch (err) {
    await run([['DEL', slot]]); // a failed attempt must stay retryable under the same key
    throw err;
  }
}

/* Sends the confirmation code with Resend when RESEND_API_KEY is set. Returns false when no sender is configured. */
export async function sendCode(email, name, code, env = process.env) {
  if (!env.RESEND_API_KEY) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.WAITLIST_FROM || 'Lasso <support@mylasso.ca>',
      to: [email],
      subject: `${code} is your Lasso waitlist code`,
      text: `Hi ${name || 'there'},\n\nYour Lasso waitlist code is ${code}. It works for 10 minutes.\n\nIf you did not ask to join the waitlist, ignore this email.\n\nLasso\nsupport@mylasso.ca`,
    }),
  });
  if (!response.ok) throw new Error(`resend ${response.status}`);
  return true;
}
