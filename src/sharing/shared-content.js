// What a share link shows, resolved from the pinned version of its source:
// the excerpt or passage, a marked or redacted PDF, a cited model part, a
// slide's picture, or the whole document, by the link's scope. The public page
// and the exported excerpt read the same content.

import { buildFullShareDocument, buildSharedExcerpt, buildSharedPassage, buildSlideShareDocument, usesStructuredLayout, detectsCsvDelimiter } from './share-preview.js';
import { fullTextLayout } from './text-layout.js';
import { isMarkdownPath } from './markdown.js';
import { redactModelPlan } from './model-redaction.js';
import { citedPartModel } from './cited-part.js';
import { buildSafePdf, markedPdfRequest, pdfShareRequest } from './pdf-share.js';
import { buildPagePdf, slideCount, slidePicture } from './document-pages.js';
import { isPresentationPath } from '../dependencies/presentation-extraction.js';

/** The readers a request handler uses for shared content, over this timeline and its index. */
export function sharedContentReader({ timeline, dependencies }) {
  const resolvedModelPreview = resolved => dependencies.sourceModelPreview({ ...resolved.source,
    path: resolved.internal.filePath, snapshotId: resolved.internal.snapshotId });
  const resolvedModelDocument = async resolved => {
    const model = await resolvedModelPreview(resolved);
    return model?.kind === 'model-plan' ? { ...model, focusBounds: { ...model.bounds } } : model;
  };
  // The public view and exported excerpt resolve the same pinned content and
  // apply the same disclosure scope before either is rendered.
  const sharedContent = async resolved => {
    let preview = null, document = null;
    try {
      const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
      const sourceFile = file ? { path: file.path, content: timeline.blobs.get(file.contentHash), contentHash: file.contentHash } : null;
      preview = buildSharedExcerpt(sourceFile, resolved.source.anchor, resolved.source.metadata,
        { nearbyRows: resolved.share.context?.nearbyRows === true });
      // A passage from a text source is shared inside its paragraph.
      if (!preview && resolved.share.accessScope === 'INDEXED' && sourceFile) {
        preview = buildSharedPassage(sourceFile, resolved.source.anchor, resolved.source.metadata,
          resolved.source.label, resolved.source.objectType);
      }
      // A marked copy is the document's pages with the strokes drawn on, never the file.
      // When it cannot be drawn, nothing else of the document is shown in its place.
      const marked = markedPdfRequest(resolved);
      if (marked) {
        try {
          const content = await buildSafePdf(await buildPagePdf(sourceFile), marked);
          return { preview: null, document: content && { kind: 'pdf', safe: true, marked: true, page: 1, location: '',
            fileUrl: `/d/${encodeURIComponent(resolved.share.token)}/source`, content } };
        } catch (error) {
          console.error('Lasso could not draw the marked copy of %s: %s', resolved.internal.filePath, error.message);
          return { preview: null, document: null };
        }
      }
      // A 3D model's cited part is shared as its own view, never as the file.
      if (resolved.share.accessScope === 'INDEXED' && /\.(?:step|stp)$/i.test(resolved.internal.filePath)) {
        return { preview, document: citedPartModel(await resolvedModelPreview(resolved)) };
      }
      // A deck is shared whole, or as a picture of the slide the citation is on and nothing else.
      if (isPresentationPath(resolved.internal.filePath)) {
        if (resolved.share.accessScope === 'DOCUMENT') {
          // A deck of one slide may also be downloaded as that slide's picture.
          return { preview: null, document: { ...buildFullShareDocument(sourceFile),
            slideCount: slideCount(sourceFile.content, sourceFile.contentHash),
            slidePicture: () => slidePicture(sourceFile.content, 1, sourceFile.contentHash) } };
        }
        if (resolved.share.accessScope !== 'INDEXED') return { preview: null, document: null };
        const slide = buildSlideShareDocument(sourceFile, resolved.source.anchor, resolved.source.metadata);
        if (!slide) return { preview: null, document: null };
        // The slide's words are shown only when it cannot be drawn.
        const picture = await slidePicture(sourceFile.content, slide.slide, sourceFile.contentHash).catch((error) => {
          console.error('Lasso could not draw slide %d of %s: %s', slide.slide, resolved.internal.filePath, error.message);
          return null;
        });
        return { preview: null, document: { ...slide, picture } };
      }
      const pdfRequest = pdfShareRequest(resolved);
      if (pdfRequest && sourceFile?.content) {
        const content = await buildSafePdf(sourceFile.content, pdfRequest);
        const pages = [...new Set(pdfRequest.regions?.map(region => region.page) ?? [])].sort((a, b) => a - b);
        const excerptLocation = pages.length ? `${pages.length > 1 ? 'Pages' : 'Page'} ${pages.join(', ')}`
          : pdfRequest.page ? `Page ${pdfRequest.page}` : '';
        document = { kind: 'pdf', safe: true, redacted: resolved.share.accessScope === 'REDACTED',
          fileUrl: `/d/${encodeURIComponent(resolved.share.token)}/source`, page: 1, location: excerptLocation, content };
        return { preview: null, document };
      }
      if (resolved.share.accessScope !== 'INDEXED') {
        document = await resolvedModelDocument(resolved)
          ?? (resolved.share.accessScope === 'REDACTED'
            ? buildFullShareDocument(sourceFile, {
              structuredLayout: usesStructuredLayout(resolved.share.redactions, fullTextLayout(resolved.internal.filePath)),
              detectCsvDelimiter: detectsCsvDelimiter(resolved.share.redactions) })
            // The original is downloadable in this scope, so Markdown can be read in full.
            : isMarkdownPath(resolved.internal.filePath) ? buildFullShareDocument(sourceFile) : null);
        if (resolved.share.accessScope === 'DOCUMENT' && /\.pdf$/i.test(resolved.internal.filePath)) {
          document = { ...buildFullShareDocument(sourceFile, { visualPdf: true }),
            fileUrl: `/d/${encodeURIComponent(resolved.share.token)}/source`,
            page: Math.max(1, Number(resolved.source.anchor?.pageNumber ?? resolved.source.metadata?.pageNumber) || 1) };
        }
        if (resolved.share.accessScope === 'REDACTED' && /\.(?:dxf|ifc)$/i.test(resolved.internal.filePath)) {
          document = redactModelPlan(document, resolved.share.redactions);
        }
      }
    } catch { preview = null; document = null; }
    return { preview, document };
  };
  return { resolvedModelPreview, resolvedModelDocument, sharedContent };
}
