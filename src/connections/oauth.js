// Sign-in for apps that use OAuth 2.0. Lasso is a native app, so it follows
// RFC 8252: the user signs in on the provider's own page in their browser,
// with PKCE, and the provider redirects back to this computer's loopback
// address, where the local server finishes the exchange.
import crypto from 'node:crypto';
import { HttpError } from '../history/errors.js';

export const OAUTH_APPS = Object.freeze({
  microsoft: {
    id: 'microsoft', name: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'],
    // Microsoft accepts any port on http://localhost for desktop apps.
    redirectHost: 'localhost',
    needsSecret: false,
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
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly'],
    redirectHost: '127.0.0.1',
    // Google's desktop clients send their client secret, which for an
    // installed app is not confidential.
    needsSecret: true,
    extra: { access_type: 'offline', prompt: 'consent' },
    setup: 'Create an OAuth client of type “Desktop app” in Google Cloud Console (APIs & Services › Credentials), '
      + 'with the Google Calendar API enabled for the project. Desktop clients accept this computer’s address without registering it.',
    registeredRedirect: null,
  },
});

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

export function authorizationUrl(app, { clientId, redirect, state, challenge, loginHint = null }) {
  const url = new URL(app.authorizeUrl);
  const parameters = {
    client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: app.scopes.join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256', ...app.extra,
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

export function exchangeCode(app, { clientId, clientSecret, code, verifier, redirect }, fetchImpl = fetch) {
  return tokenRequest(app, {
    client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier,
    ...(app.needsSecret ? { client_secret: clientSecret } : { scope: app.scopes.join(' ') }),
  }, fetchImpl);
}

export function refreshTokens(app, { clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  return tokenRequest(app, {
    client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken,
    ...(app.needsSecret ? { client_secret: clientSecret } : { scope: app.scopes.join(' ') }),
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
