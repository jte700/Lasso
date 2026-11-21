// POST /api/waitlist: saves a waitlist signup to Upstash Redis (connected through Vercel's Storage tab).
// Uses Upstash's REST API directly, so the site needs no package.json or install step.
//
// Keys:
//   waitlist:emails     set of every email, so a repeat signup is not counted twice
//   waitlist:joined     sorted set, email scored by signup time (ms)
//   waitlist:<email>    hash: email, platform, use, source, os, page, country, joinedAt
//   waitlist:platforms  hash: mac / windows / both counters
//   waitlist:rl:<ip>    signups from one address this hour (rate limit)

const PLATFORMS = new Set(['mac', 'windows', 'both']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PER_HOUR = 10;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// the Vercel Upstash integration names these KV_REST_API_*; a database made in Upstash's own console uses UPSTASH_REDIS_REST_*
function redis(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return async (commands) => {
    const res = await fetch(`${url.replace(/\/$/, '')}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(commands) });
    if (!res.ok) throw new Error(`redis ${res.status}`);
    const out = await res.json();
    const bad = out.find((r) => r.error);
    if (bad) throw new Error(`redis ${bad.error}`);
    return out.map((r) => r.result);
  };
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  if (!body || typeof body !== 'object') return json(400, { error: 'bad_json' });
  if (body.company) return json(200, { ok: true }); // honeypot: bots get a quiet success

  const email = clip(body.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return json(400, { error: 'bad_email' });
  const platform = PLATFORMS.has(body.platform) ? body.platform : 'mac';

  const run = redis();
  if (!run) return json(503, { error: 'not_configured' });

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  try {
    const [hits] = await run([['INCR', `waitlist:rl:${ip}`], ['EXPIRE', `waitlist:rl:${ip}`, 3600, 'NX']]);
    if (hits > PER_HOUR) return json(429, { error: 'rate_limited' });

    const [added] = await run([['SADD', 'waitlist:emails', email]]);
    if (added === 1) {
      const now = Date.now();
      await run([
        ['HSET', `waitlist:${email}`, 'email', email, 'platform', platform, 'use', clip(body.use, 200), 'source', clip(body.source, 40),
          'os', clip(body.os, 20), 'page', clip(body.page, 100), 'country', clip(request.headers.get('x-vercel-ip-country'), 8), 'joinedAt', new Date(now).toISOString()],
        ['ZADD', 'waitlist:joined', now, email],
        ['HINCRBY', 'waitlist:platforms', platform, 1],
      ]);
    }
    return json(200, { ok: true, already: added !== 1 });
  } catch (err) {
    console.error('waitlist', err);
    return json(502, { error: 'store_failed' });
  }
}

export function GET() {
  return json(405, { error: 'method_not_allowed' });
}
