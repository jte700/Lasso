import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../website/api/waitlist.mjs';

// a tiny in-memory stand-in for Upstash's /pipeline endpoint
function fakeUpstash() {
  const sets = new Map(), hashes = new Map(), zsets = new Map(), counters = new Map();
  const hash = (k) => hashes.get(k) ?? hashes.set(k, new Map()).get(k);
  const ops = {
    INCR: (k) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; },
    EXPIRE: () => 1,
    SADD: (k, v) => { const s = sets.get(k) ?? sets.set(k, new Set()).get(k); if (s.has(v)) return 0; s.add(v); return 1; },
    HSET: (k, ...kv) => { for (let i = 0; i < kv.length; i += 2) hash(k).set(kv[i], String(kv[i + 1])); return kv.length / 2; },
    ZADD: (k, score, v) => { (zsets.get(k) ?? zsets.set(k, new Map()).get(k)).set(v, score); return 1; },
    HINCRBY: (k, f, by) => { const n = Number(hash(k).get(f) ?? 0) + by; hash(k).set(f, String(n)); return n; },
  };
  const fetch = async (url, init) => {
    assert.equal(url, 'https://redis.test/pipeline');
    assert.equal(init.headers.authorization, 'Bearer tok');
    return Response.json(JSON.parse(init.body).map(([cmd, ...args]) => ({ result: ops[cmd](...args) })));
  };
  return { fetch, sets, hashes, zsets, counters };
}

const post = (body, headers = {}) => POST(new Request('https://www.mylasso.ca/api/waitlist', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));

test('waitlist API stores a signup once, counts platforms, and rate limits', async (t) => {
  const db = fakeUpstash(), realFetch = globalThis.fetch;
  globalThis.fetch = db.fetch;
  process.env.KV_REST_API_URL = 'https://redis.test/'; process.env.KV_REST_API_TOKEN = 'tok';
  t.after(() => { globalThis.fetch = realFetch; delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; });

  let res = await post({ email: ' Sam@Example.com ', platform: 'windows', use: 'legal research', source: 'top', os: 'windows', page: '/' }, { 'x-vercel-ip-country': 'CA' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, already: false });
  const row = db.hashes.get('waitlist:sam@example.com');
  assert.equal(row.get('platform'), 'windows');
  assert.equal(row.get('use'), 'legal research');
  assert.equal(row.get('country'), 'CA');
  assert.ok(db.zsets.get('waitlist:joined').has('sam@example.com'));

  res = await post({ email: 'sam@example.com', platform: 'mac' });
  assert.deepEqual(await res.json(), { ok: true, already: true });
  assert.equal(db.hashes.get('waitlist:platforms').get('windows'), '1');
  assert.equal(db.hashes.get('waitlist:platforms').get('mac'), undefined, 'a repeat signup is not counted again');

  assert.equal((await post({ email: 'nope' })).status, 400);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({ email: 'bot@example.com', company: 'spam' })).status, 200);
  assert.ok(!db.sets.get('waitlist:emails').has('bot@example.com'), 'honeypot signups are dropped');

  res = await post({ email: 'x@example.com', platform: 'linux' });
  assert.equal(db.hashes.get('waitlist:x@example.com').get('platform'), 'mac', 'unknown platforms fall back to mac');

  for (let i = 0; i < 10; i++) await post({ email: `n${i}@example.com` });
  assert.equal((await post({ email: 'late@example.com' })).status, 429);
});

test('waitlist API reports when storage is not connected', async () => {
  delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
  const res = await post({ email: 'sam@example.com' });
  assert.equal(res.status, 503);
});
