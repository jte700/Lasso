// Google Drive, read through the Drive API. Docs, Sheets and Slides are
// exported as Word, Excel and PowerPoint files, and the files Lasso has a
// reader for are downloaded as they are, each in the folder it sits in on
// Drive, so the readers that index a work directory read them too. Shared
// drives the person belongs to come in too, each under a top folder named
// after it. Nothing in Drive is changed.
import { ITEM_LIMIT } from './providers.js';
import { json } from './fetchers.js';
import { CLOUD_FILE_BYTES, DOCX, PPTX, XLSX, broughtExtension, cloudItem, fileBytes, folderPaths } from './cloud-files.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const NAME = 'Google Drive';
const FOLDER = 'application/vnd.google-apps.folder';

const PAGE_SIZE = 1000;
// A listing stops after this many pages, however many pictures it skipped.
const PAGE_LIMIT = 50;
const FOLDER_LIMIT = 20_000;
const FILE_FIELDS = 'id,name,mimeType,parents,driveId,modifiedTime,size,webViewLink';
// Shared drives are listed this many to a page, and no more pages than this.
const DRIVES_PAGE_SIZE = 100;
const DRIVES_PAGE_LIMIT = 20;
// What every listing and download adds once the account belongs to a shared drive.
const ALL_DRIVES = Object.freeze({ corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' });

// Google's own files, and the Office file each is brought in as.
const EXPORTS = Object.freeze({
  'application/vnd.google-apps.document': { mimeType: DOCX, extension: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mimeType: XLSX, extension: '.xlsx' },
  'application/vnd.google-apps.presentation': { mimeType: PPTX, extension: '.pptx' },
});

/** The shared drives the person belongs to, by id and name. */
async function sharedDrives({ accessToken, fetchImpl }) {
  const drives = [];
  let pageToken = null, pages = 0;
  do {
    const query = new URLSearchParams({ pageSize: String(DRIVES_PAGE_SIZE), fields: 'nextPageToken,drives(id,name)',
      ...(pageToken ? { pageToken } : {}) });
    const page = await json(NAME, `${DRIVE}/drives?${query}`, { fetchImpl, token: await accessToken() });
    drives.push(...(page.drives ?? []).filter((drive) => drive?.id && drive?.name));
    pageToken = page.nextPageToken ?? null;
  } while (pageToken && ++pages < DRIVES_PAGE_LIMIT);
  return drives;
}

async function listed({ accessToken, fetchImpl, q, orderBy, limit, scope = {}, keep = () => true }) {
  const found = [];
  let pageToken = null, pages = 0, incomplete = false;
  do {
    const query = new URLSearchParams({ q, fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
      pageSize: String(PAGE_SIZE), spaces: 'drive', ...scope, ...(orderBy ? { orderBy } : {}),
      ...(pageToken ? { pageToken } : {}) });
    const page = await json(NAME, `${DRIVE}/files?${query}`, { fetchImpl, token: await accessToken() });
    found.push(...(page.files ?? []).filter(keep));
    incomplete ||= page.incompleteSearch === true;
    pageToken = page.nextPageToken ?? null;
  } while (pageToken && found.length < limit && ++pages < PAGE_LIMIT);
  // Stopped at the page limit with pages left, or Drive searched only some
  // shared drives: what was not reached is not known to be gone.
  return Object.assign(found.slice(0, limit), { partial: (Boolean(pageToken) || incomplete) && found.length < limit });
}

function driveItem(file, { settings, previous, folderOf, accessToken, fetchImpl, scope }) {
  const exported = EXPORTS[file.mimeType];
  if (!settings.parts.includes(exported ? 'docs' : 'files')) return null;
  const extension = exported?.extension ?? broughtExtension(file.name, file.mimeType);
  if (!extension || (!exported && Number(file.size ?? 0) > CLOUD_FILE_BYTES)) return null;
  const url = exported
    ? `${DRIVE}/files/${encodeURIComponent(file.id)}/export?${new URLSearchParams({ mimeType: exported.mimeType })}`
    : `${DRIVE}/files/${encodeURIComponent(file.id)}?${new URLSearchParams({ alt: 'media',
      ...(scope.supportsAllDrives ? { supportsAllDrives: 'true' } : {}) })}`;
  return cloudItem({ id: file.id, title: file.name, extension, folders: folderOf(file.parents?.[0]),
    edited: file.modifiedTime, link: file.webViewLink, previous,
    download: () => fileBytes(url, { service: NAME, accessToken, fetchImpl }) });
}

/**
 * The files to mirror, newest edits first. Each item downloads its bytes
 * only when asked, so an unchanged file is not downloaded again.
 */
export async function fetchGoogleDrive({ accessToken, settings, fetchImpl, previous = {} }) {
  const root = await json(NAME, `${DRIVE}/files/root?fields=id`, { fetchImpl, token: await accessToken() });
  const drives = await sharedDrives({ accessToken, fetchImpl });
  // An account in no shared drive is listed as before, which Drive answers fastest.
  const scope = drives.length ? ALL_DRIVES : {};
  const context = { accessToken, fetchImpl, scope };
  const folders = await listed({ ...context, q: `mimeType = '${FOLDER}' and trashed = false`, limit: FOLDER_LIMIT });
  const folderOf = folderPaths(folders.map((folder) => ({ id: folder.id, name: folder.name, parent: folder.parents?.[0] })),
    { rootId: root.id, rootName: 'My Drive', roots: drives.map((drive) => [drive.id, drive.name]) });
  const options = { settings, previous, folderOf, ...context };
  const files = await listed({ ...context, q: `mimeType != '${FOLDER}' and trashed = false`, orderBy: 'modifiedTime desc',
    limit: ITEM_LIMIT, keep: (file) => Boolean(driveItem(file, options)) });
  return { items: files.map((file) => driveItem(file, options)), partial: files.partial || folders.partial };
}
