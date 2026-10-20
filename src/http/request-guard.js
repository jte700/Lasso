// The server listens on loopback only, but any web page the user visits can
// still send it requests. Two checks keep other sites out:
//  - Host: a page whose own hostname is rebound to 127.0.0.1 ("DNS
//    rebinding") sends its own name here. Only loopback names are accepted,
//    except on public share pages, which may sit behind SHARE_BASE_URL.
//  - Origin: a cross-site form or text/plain fetch can POST without a CORS
//    preflight. Writes must come from this server's own pages or from a
//    client that sends no Origin, such as the desktop app.

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseHost(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(`http://${value}`);
  } catch {
    return null;
  }
}

function isPublicSharePath(pathname) {
  return pathname.startsWith('/d/');
}

function isOwnOrigin(origin, localPort) {
  if (typeof origin !== 'string' || origin === 'null') return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname) && port === localPort;
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {string} pathname
 * @returns {string | null} why the request is refused, or null to serve it
 */
export function refusalReason(request, pathname) {
  const headers = request.headers ?? {};
  const host = parseHost(headers.host);
  if (!isPublicSharePath(pathname) && !LOOPBACK_HOSTNAMES.has(host?.hostname)) {
    return 'Lasso only answers requests addressed to this computer.';
  }
  if (SAFE_METHODS.has(request.method)) return null;
  const origin = headers.origin;
  const crossSite = headers['sec-fetch-site'] === 'cross-site';
  if ((origin !== undefined && !isOwnOrigin(origin, request.socket?.localPort)) || crossSite) {
    return 'Requests from other websites are not allowed.';
  }
  return null;
}

/** Headers that stop other sites from framing or sniffing the workspace. */
export const WORKSPACE_PAGE_HEADERS = Object.freeze({
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
});
