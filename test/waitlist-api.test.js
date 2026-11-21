import test from 'node:test';
import assert from 'node:assert/strict';
import { POST, DELETE } from '../website/api/waitlist.mjs';
import { POST as VERIFY } from '../website/api/waitlist-verify.mjs';

// a tiny in-memory stand-in for Upstash's /pipeline endpoint, and for Resend when a sender is configured
function fakeServices() {
  const sets = new Map(), hashes = new Map(), zsets = new Map(), strings = new Map(), emails = [];
  const hash = (k) => hashes.get(k) ?? hashes.set(k, new Map()).get(k);
  const ops = {
    INCR: (k) => { const n = Number(strings.get(k) ?? 0) + 1; strings.set(k, String(n)); return n; },
    EXPIRE: () => 1,
    SET: (k, v, ...flags) => { if (flags.includes('NX') && strings.has(k)) return null; strings.set(k, v); return 'OK'; },
    GET: (k) => strings.get(k) ?? null,
    DEL: (...keys) => keys.reduce((n, k) => n + Number(strings.delete(k) || hashes.delete(k)), 0),
    SADD: (k, v) => { const s = sets.get(k) ?? sets.set(k, new Set()).get(k); if (s.has(v)) return 0; s.add(v); return 1; },
    SREM: (k, v) => Number(sets.get(k)?.delete(v) ?? 0),
    HSET: (k, ...kv) => { for (let i = 0; i < kv.length; i += 2) hash(k).set(kv[i], String(kv[i + 1])); return kv.length / 2; },
    HGET: (k, f) => hashes.get(k)?.get(f) ?? null,
    HINCRBY: (k, f, by) => { const n = Number(hash(k).get(f) ?? 0) + by; hash(k).set(f, String(n)); return n; },
    ZADD: (k, score, v) => { (zsets.get(k) ?? zsets.set(k, new Map()).get(k)).set(v, score); return 1; },
    ZREM: (k, v) => Number(zsets.get(k)?.delete(v) ?? 0),
  };
  const fetch = async (url, init) => {
    if (url === 'https://api.resend.com/emails') { emails.push(JSON.parse(init.body)); return Response.json({ id: 'sent' }); }
    assert.equal(url, 'https://redis.test/pipeline');
    assert.equal(init.headers.authorization, 'Bearer tok');
    return Response.json(JSON.parse(init.body).map(([cmd, ...args]) => ({ result: ops[cmd](...args) })));
  };
  return { fetch, sets, hashes, zsets, emails };
}

const request = (method, url, body, headers = {}) => new Request(url, {
  method, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const join = (body, headers) => POST(request('POST', 'https://www.mylasso.ca/api/waitlist', body, headers));
const leave = (body, key) => DELETE(request('DELETE', 'https://www.mylasso.ca/api/waitlist', body, key ? { 'idempotency-key': key } : {}));
const verify = (body) => VERIFY(request('POST', 'https://www.mylasso.ca/api/waitlist-verify', body));

function connect(t, env = {}) {
  const services = fakeServices(), realFetch = globalThis.fetch;
  globalThis.fetch = services.fetch;
  Object.assign(process.env, { KV_REST_API_URL: 'https://redis.test/', KV_REST_API_TOKEN: 'tok' }, env);
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', ...Object.keys(env)]) delete process.env[name];
  });
  return services;
}

test('A signup is stored once and counted once, without a code when no email sender is set', async (t) => {
  const db = connect(t);

  let res = await join({ email: ' Sam@Example.com ', name: 'Sam', platform: 'windows', source: 'top', page: '/' }, { 'x-vercel-ip-country': 'CA', 'idempotency-key': 'key-sam-0001' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, already: false, verify: false });
  const row = db.hashes.get('waitlist:sam@example.com');
  assert.equal(row.get('name'), 'Sam');
  assert.equal(row.get('platform'), 'windows');
  assert.equal(row.get('country'), 'CA');
  assert.equal(row.get('verified'), '0');
  assert.ok(db.zsets.get('waitlist:joined').has('sam@example.com'));

  res = await join({ email: 'sam@example.com', platform: 'mac-arm' });
  assert.deepEqual(await res.json(), { ok: true, already: true, verify: false });
  assert.equal(db.hashes.get('waitlist:platforms').get('windows'), '1');
  assert.equal(db.hashes.get('waitlist:platforms').get('mac-arm'), undefined, 'a repeat signup is not counted again');

  res = await join({ email: 'x@example.com', platform: 'linux' });
  assert.equal(db.hashes.get('waitlist:x@example.com').get('platform'), 'mac-arm', 'unknown platforms fall back to Apple silicon');
});

test('A retried request with the same key is answered once', async (t) => {
  const db = connect(t);
  const first = await join({ email: 'ada@example.com', platform: 'mac-intel' }, { 'idempotency-key': 'key-ada-0001' });
  const again = await join({ email: 'ada@example.com', platform: 'mac-intel' }, { 'idempotency-key': 'key-ada-0001' });
  assert.deepEqual(await again.json(), await first.json());
  assert.equal(db.hashes.get('waitlist:platforms').get('mac-intel'), '1');
});

test('Undo removes a signup only with the key that made it', async (t) => {
  const db = connect(t);
  await join({ email: 'lee@example.com', platform: 'windows' }, { 'idempotency-key': 'key-lee-0001' });

  assert.equal((await leave({ email: 'lee@example.com' }, 'key-someone-else')).status, 403);
  assert.ok(db.sets.get('waitlist:emails').has('lee@example.com'));

  const res = await leave({ email: 'lee@example.com' }, 'key-lee-0001');
  assert.equal(res.status, 200);
  assert.ok(!db.sets.get('waitlist:emails').has('lee@example.com'));
  assert.equal(db.hashes.get('waitlist:lee@example.com'), undefined);
  assert.equal(db.hashes.get('waitlist:platforms').get('windows'), '0');
});

test('With an email sender set, a code is sent and checking it marks the signup verified', async (t) => {
  const db = connect(t, { RESEND_API_KEY: 'resend-test' });
  const res = await join({ email: 'kim@example.com', name: 'Kim' });
  assert.deepEqual(await res.json(), { ok: true, already: false, verify: true });
  assert.equal(db.emails.length, 1);
  assert.deepEqual(db.emails[0].to, ['kim@example.com']);
  const code = db.emails[0].subject.match(/^(\d{6}) /)[1];

  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await verify({ email: 'kim@example.com', code: wrong })).status, 400);
  assert.equal(db.hashes.get('waitlist:kim@example.com').get('verified'), '0');

  assert.equal((await verify({ email: 'kim@example.com', code })).status, 200);
  assert.equal(db.hashes.get('waitlist:kim@example.com').get('verified'), '1');
  assert.equal((await verify({ email: 'kim@example.com', code })).status, 410, 'a code works once');
});

test('Bad requests, bots and floods are turned away', async (t) => {
  const db = connect(t);
  assert.equal((await join({ email: 'nope' })).status, 400);
  assert.equal((await join('{not json')).status, 400);
  assert.equal((await join({ email: 'bot@example.com', company: 'spam' })).status, 200);
  assert.ok(!db.sets.get('waitlist:emails')?.has('bot@example.com'), 'honeypot signups are dropped');

  for (let i = 0; i < 20; i++) await join({ email: `n${i}@example.com` });
  assert.equal((await join({ email: 'late@example.com' })).status, 429);
});

test('The waitlist reports when storage is not connected', async () => {
  delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
  assert.equal((await join({ email: 'sam@example.com' })).status, 503);
  assert.equal((await verify({ email: 'sam@example.com', code: '123456' })).status, 503);
});
