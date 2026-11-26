// Dropbox, read through its API. The whole folder tree is listed at once; the
// files Lasso has a reader for are downloaded and Paper docs are exported as
// Markdown, each in its Dropbox folder. Nothing in Dropbox is changed.
import path from 'node:path';
import { ITEM_LIMIT } from './providers.js';
import { json } from './fetchers.js';
import { CLOUD_FILE_BYTES, broughtExtension, cloudItem, fileBytes, newestFirst } from './cloud-files.js';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const NAME = 'Dropbox';
// A listing stops after this many pages of up to 2,000 entries.
const PAGE_LIMIT = 100;

export async function dropboxAccount({ token, fetchImpl }) {
  const account = await json(NAME, `${API}/users/get_current_account`, { fetchImpl, token, method: 'POST' });
  return account.email || account.name?.display_name || NAME;
}

/** Dropbox takes a download's arguments as JSON in a header, which must be plain ASCII. */
const headerArgument = (value) => JSON.stringify(value).replace(/[\u007f-￿]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function entries({ accessToken, fetchImpl }) {
  const found = [];
  let page = await json(NAME, `${API}/files/list_folder`, { fetchImpl, token: await accessToken(), method: 'POST',
    body: { path: '', recursive: true, include_deleted: false, limit: 2000 } });
  found.push(...(page.entries ?? []));
  for (let pages = 1; page.has_more && pages < PAGE_LIMIT; pages++) {
    page = await json(NAME, `${API}/files/list_folder/continue`, { fetchImpl, token: await accessToken(), method: 'POST',
      body: { cursor: page.cursor } });
    found.push(...(page.entries ?? []));
  }
  return { found, partial: Boolean(page.has_more) };
}

/** How one file comes in: downloaded, or a Paper doc exported as Markdown. */
function shape(entry) {
  if (entry.is_downloadable === false) {
    return /\.paper$/i.test(entry.name) && entry.export_info
      ? { title: entry.name.replace(/\.paper$/i, ''), extension: '.md', endpoint: 'export', argument: { export_format: 'markdown' } }
      : null;
  }
  const extension = broughtExtension(entry.name);
  return extension && Number(entry.size ?? 0) <= CLOUD_FILE_BYTES
    ? { title: entry.name, extension, endpoint: 'download', argument: {} } : null;
}

/** The files to mirror, newest edits first; each downloads only when asked. */
export async function fetchDropbox({ accessToken, fetchImpl, previous = {} }) {
  const listing = await entries({ accessToken, fetchImpl });
  const files = listing.found.filter((entry) => entry['.tag'] === 'file' && shape(entry));
  return {
    partial: listing.partial,
    items: newestFirst(files, (entry) => entry.server_modified, ITEM_LIMIT).map((entry) => {
      const { title, extension, endpoint, argument } = shape(entry);
      const directory = path.posix.dirname(entry.path_display ?? `/${entry.name}`);
      return cloudItem({
        id: entry.id, title, extension, edited: entry.server_modified, previous,
        folders: [NAME, ...directory.split('/').filter(Boolean)],
        link: `https://www.dropbox.com/home${encodeURI(directory === '/' ? '' : directory)}?preview=${encodeURIComponent(entry.name)}`,
        // Dropbox answers 409 for a path it will not send, such as one removed meanwhile.
        download: () => fileBytes(`${CONTENT}/files/${endpoint}`, { service: NAME, accessToken, fetchImpl, method: 'POST',
          headers: { 'Dropbox-API-Arg': headerArgument({ path: entry.id, ...argument }) }, skipStatuses: [403, 404, 409, 410] }),
      });
    }),
  };
}
