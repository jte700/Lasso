import crypto from 'node:crypto';
import { HttpError } from '../history/errors.js';

const MAX_BODY = 4_000_000;

/** Capture the existing public route, after its scope and redaction checks.
 * No workspace route, source metadata or arbitrary file can be uploaded.
 */
async function recipientAsset(handler, url) {
  let captured;
  await handler({ method: 'GET', url, headers: { host: 'localhost' } }, {
    writeHead(status, headers) { captured = { status, headers }; },
    end(content) { captured.content = Buffer.from(content); },
  });
  return captured;
}

export async function shareBundle(handler, share) {
  const base = `/d/${share.token}`;
  const page = await recipientAsset(handler, base);
  if (page.status !== 200) throw new HttpError(422, 'The shared source could not be prepared.');
  let html = page.content.toString('utf8');
  const assets = [];
  const linked = new Set([...html.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)]
    .map(match => match[1]).filter(url => url.startsWith(`${base}/`)));
  for (const url of linked) {
    const assetPath = url.slice(base.length + 1);
    if (!/^(?:source|slide|excerpt|download)(?:\?as=(?:pdf|docx|jpeg))?$/.test(assetPath)) throw new HttpError(422, 'Unsupported shared asset.');
    const asset = await recipientAsset(handler, url);
    if (asset.status !== 200) {
      // Conversion availability depends on the local platform. Do not advertise a failed conversion.
      if (assetPath.includes('?as=')) {
        const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        html = html.replace(new RegExp(`<a\\b[^>]*href="${escaped}"[^>]*>[\\s\\S]*?<\\/a>`, 'g'), '');
        continue;
      }
      throw new HttpError(422, 'The shared copy could not be prepared. No link was published.');
    }
    assets.push({ path: assetPath, contentType: asset.headers['content-type'],
      disposition: asset.headers['content-disposition'], body: asset.content.toString('base64') });
  }
  assets.unshift({ path: '', contentType: 'text/html; charset=utf-8', body: Buffer.from(html).toString('base64') });
  const body = JSON.stringify({ token: share.token, expiresAt: share.expiresAt, assets });
  if (Buffer.byteLength(body) > MAX_BODY) throw new HttpError(413, 'This share is too large to host (about 3 MB including its preview and downloads). Share a smaller excerpt.');
  return body;
}

export class HostedSharePublisher {
  constructor({ config, db, handler }) {
    this.config = config;
    this.db = db;
    this.handler = handler;
    this.fetch = config.shareFetch ?? fetch;
  }

  async request(origin, route, options) {
    let response;
    try {
      response = await this.fetch(`${origin}${route}`, { ...options, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    } catch { throw new HttpError(502, 'Cannot reach hosted sharing. Check your connection and try again.'); }
    if (!response.ok) {
      const message = response.status === 413 ? 'This share is too large to host. Share a smaller excerpt.'
        : response.status === 429 ? 'Too many shares. Try again later.'
        : response.status === 503 ? 'Hosted sharing is not configured on mylasso.ca yet.'
        : 'Hosted sharing failed. Try again.';
      // A remote 404 is a host/credential failure, not a missing local grant.
      // Native clients treat local 404s as already revoked.
      throw new HttpError([413, 429].includes(response.status) ? response.status : 502, message);
    }
    return response;
  }

  async publish(share) {
    const body = await shareBundle(this.handler, share);
    const origin = this.config.shareBaseUrl;
    const secret = crypto.randomBytes(32).toString('base64url');
    // Save before sending, so an interrupted request remains revocable after restart.
    this.db.prepare('INSERT INTO object_share_publications(share_id, origin, revoke_secret) VALUES (?, ?, ?)')
      .run(share.id, origin, secret);
    const response = await this.request(origin, '/api/shares', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body,
    });
    let result;
    try { result = await response.json(); } catch { throw new HttpError(502, 'Hosted sharing returned an invalid response.'); }
    if (result.token !== share.token) throw new HttpError(502, 'Hosted sharing returned an invalid response.');
    if (this.db.prepare('SELECT revoked_at FROM object_share_grants WHERE id = ?').get(share.id)?.revoked_at) {
      await this.revoke(share.token, { origin, revoke_secret: secret });
      throw new HttpError(409, 'This share was stopped while it was being published.');
    }
    this.db.prepare('UPDATE object_share_publications SET published_at = ? WHERE share_id = ?').run(new Date().toISOString(), share.id);
    return { ...share, url: `${origin}/d/${share.token}`, hosted: true };
  }

  async revoke(token, publication) {
    await this.request(publication.origin, `/api/shares?token=${encodeURIComponent(token)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${publication.revoke_secret}` },
    });
  }
}
