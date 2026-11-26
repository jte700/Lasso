// What every cloud drive connector shares: which files are brought in, the
// folders a file sits in, downloading one file, and the item the mirror writes.
// Each service's own file (google-drive.js, onedrive.js, dropbox.js, box.js)
// lists its files and says how each is downloaded.
import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { detectFileType } from '../history/file-types.js';
import { readerFor } from '../dependencies/readers.js';

// A file larger than this is left in the cloud.
export const CLOUD_FILE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// An uploaded file whose name does not say what it is is known by its type.
const EXTENSIONS = Object.freeze({
  'application/pdf': '.pdf', [DOCX]: '.docx', [XLSX]: '.xlsx', [PPTX]: '.pptx', 'application/vnd.ms-excel': '.xls',
  'text/csv': '.csv', 'text/tab-separated-values': '.tsv', 'text/plain': '.txt', 'text/markdown': '.md',
});

// The readers whose files are brought in. Pictures, videos, code and the like
// stay in the cloud: a drive holds many and they rarely hold what is typed.
const BROUGHT_READERS = new Set(['legacy-workbook', 'table', 'pdf', 'landxml', 'design', 'document', 'presentation', 'text']);

const brought = (name) => BROUGHT_READERS.has(readerFor({ path: name, fileType: detectFileType(name) }).id);

/** The extension a file is written with, or null when Lasso does not bring it in. */
export function broughtExtension(name, mimeType = null) {
  const own = path.extname(name ?? '').toLowerCase();
  if (own && brought(name)) return own;
  const typed = EXTENSIONS[mimeType];
  return typed && brought(`file${typed}`) ? typed : null;
}

/**
 * A file's folders, from the drive's own top folder down, for folders known
 * by id with the id of their parent. `roots` are further top folders, as
 * `[id, name]`, such as Google's shared drives. A folder whose parent is not
 * the user's to see was shared with them, and sits under `sharedName`.
 */
export function folderPaths(folders, { rootId, rootName, roots = [], sharedName = 'Shared with me' }) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map([...roots.map(([id, name]) => [id, [name]]), [rootId, [rootName]]]);
  const resolve = (id) => {
    if (paths.has(id)) return paths.get(id);
    const folder = byId.get(id);
    if (!folder) return null;
    // A folder met again while its own path is worked out is a loop.
    paths.set(id, null);
    const above = folder.parent ? resolve(folder.parent) : null;
    const names = [...(above ?? [sharedName]), folder.name];
    paths.set(id, names);
    return names;
  };
  return (parentId) => (parentId ? resolve(parentId) : null) ?? [sharedName];
}

/** An error that leaves one file out of a sync and lets the rest come in. */
export function skipped(message) {
  const error = new HttpError(422, message);
  error.skip = true;
  return error;
}

/**
 * A file's bytes. The service refusing this one file (`skipStatuses`: too
 * large to export, downloads switched off, gone meanwhile) skips it alone.
 */
export async function fileBytes(url, { service, accessToken, fetchImpl, method = 'GET', headers = {},
  skipStatuses = [403, 404, 410] }) {
  let response;
  try {
    response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${await accessToken()}`, ...headers },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new HttpError(502, `${service} could not be reached: ${error.message}`);
  }
  // 202: the service is still preparing the file; it comes in on a later sync.
  if (response.status === 202) throw skipped(`${service} is still preparing the file.`);
  if (response.ok) {
    if (Number(response.headers.get('content-length')) > CLOUD_FILE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw skipped('The file is too large to bring in.');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > CLOUD_FILE_BYTES) throw skipped('The file is too large to bring in.');
    return bytes;
  }
  const payload = await response.json().catch(() => ({}));
  const reason = String(payload?.error?.errors?.[0]?.reason ?? payload?.error_summary ?? '');
  if (response.status === 401) {
    const error = new HttpError(401, `${service} no longer accepts Lasso's access. Connect it again.`);
    error.reauthorize = true;
    throw error;
  }
  if (response.status === 429 || /rateLimitExceeded|too_many_requests/i.test(reason)) {
    throw new HttpError(503, `${service} asked Lasso to slow down. It will try again shortly.`);
  }
  if (skipStatuses.includes(response.status)) {
    const message = payload?.error?.message ?? payload?.message ?? payload?.error_summary;
    throw skipped(typeof message === 'string' ? message : `${service} would not send the file.`);
  }
  throw new HttpError(502, `${service} answered with an error (HTTP ${response.status}).`);
}

/**
 * The item the mirror writes for one file. It is unchanged when the service
 * reports the same edit as the copy already here, and downloads only when asked.
 */
export function cloudItem({ id, title, extension, folders, edited, link = null, previous, download }) {
  const known = previous[id];
  return { id, kind: 'file', title: title || 'Untitled', extension, folders, edited: edited ?? null, link,
    unchanged: Boolean(known?.edited && known.edited === edited), download };
}

/** Files newest edits first, at most `limit` of them. */
export function newestFirst(files, editedOf, limit) {
  return [...files].sort((left, right) => String(editedOf(right) ?? '').localeCompare(String(editedOf(left) ?? '')))
    .slice(0, limit);
}
