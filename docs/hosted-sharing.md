# Hosted source links on mylasso.ca

Lasso's source share buttons now publish to `https://www.mylasso.ca` before returning a link. The desktop keeps indexing on loopback. Vercel stores an immutable recipient snapshot in private Upstash Redis, so recipients can open it after the sender closes Lasso.

## Deploy the website

1. In the existing Vercel project for `mylasso.ca`, use **Root Directory: `website`**, **Framework Preset: Other**. The existing static website and `api/waitlist.mjs` remain in that directory; no new package or build step is required. Deploy the new `api/shares.mjs`, `api/shared.mjs`, `lib/shares.mjs` and `vercel.json` with the site.
2. Connect an Upstash Redis database in Vercel Storage/Marketplace, or reuse the database already used by the waitlist. Configure either `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, in the project's Production environment. The token needs write access. Never put these credentials in the desktop app. Sharing uses the separate `lasso:share:` key prefix.
3. Redeploy with those environment variables. The current apex domain redirects to `www.mylasso.ca`, so the app uses that canonical host directly. Uploads intentionally refuse redirects; set `SHARE_BASE_URL` to the direct HTTPS origin if this setup changes. Public recipient routes must be reachable without Vercel deployment protection.
4. Build Lasso with `npm run desktop`, then relaunch the built app. New versions use `https://www.mylasso.ca` automatically. Database migration 031 records hosted origins and private management keys locally.
5. Create a link from a small, non-sensitive source. Open it in a private browser on another device, close Lasso and confirm the link still works, then reopen Lasso and choose **Stop Sharing**. Both the page and every download must become unavailable. Do not use real private files for deployment smoke tests.

`website/vercel.json` rewrites `/d/<token>` and `/d/<token>/<asset>` to the recipient function. The sharing code imports no local index, SQLite database, or native rendering dependencies into Vercel. Native PDF/Office rendering happens on the sender's computer before upload.

## Security and behavior

- A link contains 24 cryptographically random bytes (192 bits), encoded as 32 URL-safe characters. It contains no file path, source ID, timestamp or sequential number. The server reserves tokens with Redis `SET NX`; a collision never overwrites an existing share.
- Each share has an independent 32-byte management secret. Only its SHA-256 hash is stored on the host; the secret stays in the sender's local database. Knowing the viewing URL cannot revoke or replace a share. Keep the local Lasso data directory private, like the original indexed files it already contains.
- An upload is produced from the same public recipient routes used by the existing scope and redaction tests. Original bytes are included only for **Entire document**. Other scopes include only their rendered view and permitted excerpts. Private object metadata and filesystem paths are not serialized. Optional conversions that fail locally are omitted from the page.
- The host validates routes, expiry, MIME types, encodings and body size. Pages disable scripts, forms and external resources using CSP and sandboxing; downloads are forced attachments. Responses disable browser/CDN caching and indexing and send no referrer. These controls cannot recall files a recipient has already saved.
- Links expire after at most 48 hours, enforced both on reads and by Redis TTL. Revocation atomically removes the content and keeps a small tombstone until expiry, preventing delayed uploads from restoring it. Revocation failures are reported rather than marking a remote share stopped locally.
- The upload API is intentionally available without an account, matching Lasso's current product. A per-share management key authorizes mutations; it is not an account identity. Uploads require JSON and reject browser `Origin` headers. Limits allow 30 creation attempts per IP per hour and 1,000 globally per hour. Vercel's trusted forwarded IP is hashed for the expiring counters. The global cap bounds storage abuse; it can also temporarily stop legitimate uploads under sustained abuse.
- A failed upload never returns a new hosted link. If an upload's acknowledgement is lost, Lasso attempts revocation using the saved management key. If cleanup also fails, the local share record remains available to retry **Stop Sharing**; any remote copy expires within 48 hours. Existing local grants are not silently uploaded or relabelled as hosted shares.

## Current size limit

The complete snapshot must fit within 4,000,000 bytes of JSON, including base64-encoded previews and downloads (about 3 MB of binary content, often less when a PDF appears in multiple permitted downloads). Larger snapshots are rejected before any upload. This stays below Vercel's [function payload limit](https://vercel.com/docs/functions/limitations) and needs no additional storage product. Large files and videos need a future private object-storage upload/streaming path; they do not fall back to localhost links.

## Development and validation

`SHARE_BASE_URL=http://localhost:4317 npm start` retains local-only sharing. A custom hosted service must use HTTPS and implement the same API. A saved share always revokes against its original host even if configuration later changes.

Run `node --test test/hosted-sharing.test.js` for the hosted protocol and desktop-to-host integration using an in-memory store. Run `npm test` for existing source formats and redaction regressions. The hosted tests do not contact production or require credentials. Live Vercel/Upstash validation is a separate deployment check.
