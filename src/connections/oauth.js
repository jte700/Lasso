// Sign-in for apps that use OAuth 2.0. Lasso is a native app, so it follows
// RFC 8252: the user signs in on the provider's own page in their browser,
// with PKCE, and the provider redirects back to this computer's loopback
// address, where the local server finishes the exchange. A sign-in asks for
// the app's own scopes and those of the one provider it connects.
import crypto from 'node:crypto';
import { HttpError } from '../history/errors.js';

export const OAUTH_APPS = Object.freeze({
  microsoft: {
    id: 'microsoft', name: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // Outlook adds mail and calendars, OneDrive files (`scopes` in providers.js).
    scopes: ['offline_access', 'User.Read'],
    // Microsoft accepts any port on http://localhost for desktop apps.
    redirectHost: 'localhost',
    needsSecret: false,
    // Microsoft is told the scopes again when the code and refresh tokens are redeemed.
    tokenScope: true,
    extra: { response_mode: 'query', prompt: 'select_account' },
    setup: 'Register an app in Microsoft Entra (portal.azure.com › App registrations), choose “Accounts in any '
      + 'organizational directory and personal Microsoft accounts”, add the platform “Mobile and desktop applications” '
      + 'with the redirect URI below, and switch on “Allow public client flows”.',
    // What to register: Microsoft matches the path and ignores the port.
    registeredRedirect: 'http://localhost/connect/callback',
  },
  google: {
    id: 'google', name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // Each Google provider adds the one API it reads (`scopes` in providers.js).
    scopes: ['openid', 'email'],
    redirectHost: '127.0.0.1',
    // Google's desktop clients send their client secret, which for an
    // installed app is not confidential.
    needsSecret: true,
    extra: { access_type: 'offline', prompt: 'consent' },
    setup: 'Create an OAuth client of type “Desktop app” in Google Cloud Console (APIs & Services › Credentials), '
      + 'with the Google Calendar API or the Google Drive API, whichever you connect, enabled for the project. '
      + 'Desktop clients accept this computer’s address without registering it.',
    registeredRedirect: null,
  },
  dropbox: {
    id: 'dropbox', name: 'Dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: ['account_info.read', 'files.metadata.read', 'files.content.read'],
    redirectHost: 'localhost',
    // PKCE stands in for a secret, so the app's secret is never needed here.
    needsSecret: false,
    extra: { token_access_type: 'offline' },
    setup: 'Create an app in the Dropbox App Console (dropbox.com/developers/apps) with Scoped access and Full Dropbox, '
      + 'tick account_info.read, files.metadata.read and files.content.read under Permissions, and add the redirect URI below.',
    // Dropbox matches the redirect exactly, port included.
    registeredRedirect: 'http://localhost:4319/connect/callback',
  },
});

/**
 * What a sign-in for one provider asks for: the app's scopes, the provider's
 * own, and those of the parts chosen in `settings` that need more.
 */
export function scopesFor(app, entry, settings = {}) {
  const chosen = new Set(Array.isArray(settings.parts) ? settings.parts : []);
  const parts = (entry?.parts ?? []).filter((part) => chosen.has(part.id)).flatMap((part) => part.scopes ?? []);
  return [...new Set([...app.scopes, ...(entry?.scopes ?? []), ...parts])];
}

// A sign-in left open in the browser expires after this long.
export const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
export const CALLBACK_PATH = '/connect/callback';

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function redirectUri(app, port) {
  return `http://${app.redirectHost}:${port}${CALLBACK_PATH}`;
}

/** `scopes` are what this sign-in asks for, the app's own when left out. */
export function authorizationUrl(app, { clientId, redirect, state, challenge, loginHint = null, scopes = app.scopes }) {
  const url = new URL(app.authorizeUrl);
  const parameters = {
    client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: scopes.join(' '), state,
    code_challenge: challenge, code_challenge_method: 'S256', ...app.extra,
    ...(loginHint ? { login_hint: loginHint } : {}),
  };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

async function tokenRequest(app, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(app.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new HttpError(502, `${app.name} could not be reached: ${error.message}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new HttpError(response.status === 400 || response.status === 401 ? 401 : 502,
      `${app.name} did not accept the sign-in: ${String(reason).split(/\r?\n/)[0]}`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? body.refresh_token ?? null,
    idToken: payload.id_token ?? null,
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000,
  };
}

/** What every token request adds: the secret, or the scopes, for the apps that want them. */
const credentialsFor = (app, { clientSecret, scopes }) => ({
  ...(app.needsSecret ? { client_secret: clientSecret } : {}),
  ...(app.tokenScope ? { scope: (scopes ?? app.scopes).join(' ') } : {}),
});

export function exchangeCode(app, { clientId, clientSecret, code, verifier, redirect, scopes }, fetchImpl = fetch) {
  return tokenRequest(app, {
    client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirect,
    code_verifier: verifier, ...credentialsFor(app, { clientSecret, scopes }),
  }, fetchImpl);
}

export function refreshTokens(app, { clientId, clientSecret, refreshToken, scopes }, fetchImpl = fetch) {
  return tokenRequest(app, {
    client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken,
    ...credentialsFor(app, { clientSecret, scopes }),
  }, fetchImpl);
}

/** The claims of an ID token received straight from the token endpoint over TLS. */
export function idTokenClaims(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}
