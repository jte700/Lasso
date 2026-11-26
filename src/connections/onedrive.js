// OneDrive, personal or Microsoft 365, read through Microsoft Graph. Every
// file and folder comes from one delta listing of the drive; the files Lasso
// has a reader for are downloaded, each in its OneDrive folder. With the
// SharePoint part chosen, a work or school account's followed sites add
// their document libraries, each under SharePoint/<site>/<library>. Nothing
// in OneDrive or SharePoint is changed.
//
// Files shared with the person are not read: Graph's sharedWithMe listing
// stops returning data in November 2026 and Microsoft names no replacement.
import { ITEM_LIMIT } from './providers.js';
import { json } from './fetchers.js';
import { CLOUD_FILE_BYTES, broughtExtension, cloudItem, fileBytes, folderPaths, newestFirst } from './cloud-files.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const NAME = 'OneDrive';
const FIELDS = 'id,name,file,folder,root,package,deleted,parentReference,lastModifiedDateTime,size,webUrl';
// A listing stops after this many pages (Graph sends about 200 items a page).
const PAGE_LIMIT = 200;
// At most this many followed sites, and libraries in each, are read.
const SITE_LIMIT = 50;
const LIBRARY_LIMIT = 20;
const SHAREPOINT = 'SharePoint';

async function deltaItems(url, { accessToken, fetchImpl }) {
  const items = [];
  let next = `${url}?${new URLSearchParams({ $select: FIELDS })}`;
  for (let pages = 0; next && pages < PAGE_LIMIT; pages++) {
    const page = await json(NAME, next, { fetchImpl, token: await accessToken() });
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'] ?? null;
  }
  // An item renamed or moved while the pages are read comes again; its last state counts.
  return { items: [...new Map(items.map((item) => [item.id, item])).values()], partial: Boolean(next) };
}

/**
 * One drive's files as mirror items. `top` are the folders its files sit
 * under; `idPrefix` keeps ids apart across drives; `itemsUrl` is where a
 * file's content is downloaded from.
 */
function driveFiles(listing, { top, itemsUrl, idPrefix = '', previous, accessToken, fetchImpl }) {
  const items = listing.items.filter((item) => !item.deleted);
  const root = items.find((item) => item.root);
  const folderOf = folderPaths(items.filter((item) => item.folder && !item.root)
    .map((item) => ({ id: item.id, name: item.name, parent: item.parentReference?.id })), { rootId: root?.id, rootName: top.at(-1) });
  // The drive's own top folder is the last of `top`; the others sit above it.
  const above = top.slice(0, -1);
  // OneNote notebooks are packages, not files Lasso reads.
  return items.filter((item) => item.file && !item.package && Number(item.size ?? 0) <= CLOUD_FILE_BYTES
    && broughtExtension(item.name, item.file.mimeType)).map((item) => ({
    edited: item.lastModifiedDateTime,
    entry: cloudItem({
      id: `${idPrefix}${item.id}`, title: item.name, extension: broughtExtension(item.name, item.file.mimeType),
      folders: [...above, ...folderOf(item.parentReference?.id)],
      edited: item.lastModifiedDateTime, link: item.webUrl, previous,
      download: () => fileBytes(`${itemsUrl}/${encodeURIComponent(item.id)}/content`, { service: NAME, accessToken, fetchImpl }),
    }),
  }));
}

/** The document libraries of the sites a work or school account follows. */
async function sharePointLibraries(context) {
  const { accessToken, fetchImpl } = context;
  const drive = await json(NAME, `${GRAPH}/me/drive?$select=driveType`, { fetchImpl, token: await accessToken() });
  // A personal account has no SharePoint sites; Graph does not list them for it.
  if (drive.driveType !== 'business') return [];
  const sites = await json(NAME, `${GRAPH}/me/followedSites?$select=id,displayName,name`, { fetchImpl, token: await accessToken() });
  const libraries = [];
  for (const site of (sites.value ?? []).slice(0, SITE_LIMIT)) {
    if (!site?.id) continue;
    const drives = await json(NAME, `${GRAPH}/sites/${encodeURIComponent(site.id)}/drives?$select=id,name,driveType`,
      { fetchImpl, token: await accessToken() });
    for (const library of (drives.value ?? []).filter((entry) => entry?.id && entry.driveType === 'documentLibrary')
      .slice(0, LIBRARY_LIMIT)) {
      libraries.push({ id: library.id, site: site.displayName || site.name || 'Site', name: library.name || 'Documents' });
    }
  }
  return libraries;
}

/** The files to mirror, newest edits first; each downloads only when asked. */
export async function fetchOneDrive({ accessToken, settings, fetchImpl, previous = {} }) {
  const context = { accessToken, fetchImpl, previous };
  const parts = settings?.parts ?? ['files'];
  const files = [];
  let partial = false;
  if (parts.includes('files')) {
    const listing = await deltaItems(`${GRAPH}/me/drive/root/delta`, context);
    partial ||= listing.partial;
    files.push(...driveFiles(listing, { ...context, top: [NAME], itemsUrl: `${GRAPH}/me/drive/items` }));
  }
  if (parts.includes('sharepoint')) {
    for (const library of await sharePointLibraries(context)) {
      const base = `${GRAPH}/drives/${encodeURIComponent(library.id)}`;
      const listing = await deltaItems(`${base}/root/delta`, context);
      partial ||= listing.partial;
      files.push(...driveFiles(listing, { ...context, top: [SHAREPOINT, library.site, library.name], itemsUrl: `${base}/items`,
        idPrefix: `${library.id}:` }));
    }
  }
  return { partial, items: newestFirst(files, (file) => file.edited, ITEM_LIMIT).map((file) => file.entry) };
}
