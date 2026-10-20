import { MODEL_PLAN_STYLE, modelPlanViewBox, renderModelPlan } from '../../public/model-preview.js';

// One renderer supplies both the recipient page and its downloadable drawing.
export function renderSharedDrawing(document, { requireRedacted = false } = {}) {
  // Fail closed even if a future caller forgets the server-side clipping step.
  if (requireRedacted && document.redacted !== true) return '<div class="privacy-preview">A safe redacted drawing preview could not be rendered.</div>';
  let markup = renderModelPlan(document, { interactive: false });
  if (document.redacted) {
    const shapes = (document.redactionRegions ?? []).map((region, regionIndex) => {
      const x = region.minX, y = -region.maxY, width = region.maxX - region.minX, height = region.maxY - region.minY;
      const effect = region.effect === 'BLANK' ? 'blank' : 'blur';
      // The source beneath each region has already been removed server-side.
      // These shapes contain no original pixels, geometry or text.
      const blurId = `drawing-mask-blur-${regionIndex}`, clipId = `drawing-mask-clip-${regionIndex}`;
      const blurred = effect === 'blur' ? `<defs><filter id="${blurId}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${Math.min(width, height) * .065}"/></filter><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></clipPath></defs><g clip-path="url(#${clipId})"><g filter="url(#${blurId})">${[0.2, 0.45, 0.7].map((offset, index) => `<rect x="${x + width * .12}" y="${y + height * offset}" width="${width * (.63 - index * .07)}" height="${height * .13}" rx="${height * .05}" fill="#8895a7" opacity=".75"/>`).join('')}</g></g>` : '';
      // SVG stroke widths use drawing units, so even a small inherited icon
      // stroke can cover metres of an IFC plan. Masks have only their exact fill.
      return `<g class="drawing-redaction ${effect}" stroke="none" role="img" aria-label="Redacted"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${effect === 'blank' ? '#000' : '#b5bdc9'}"/>${blurred}</g>`;
    }).join('');
    if (!markup.includes('<svg')) {
      markup = markup.replace(/<p class="model-plan-empty">[^<]*<\/p>/, `<svg class="model-plan-svg" xmlns="http://www.w3.org/2000/svg" viewBox="${modelPlanViewBox(document.bounds).join(' ')}" role="img" aria-label="Redacted drawing"></svg>`);
    }
    markup = markup.replace('</svg>', `${shapes}</svg>`);
  }
  return `<div class="full-document drawing-document">${markup}</div>`;
}

export function sharedDrawingSvg(document, options = {}) {
  const markup = renderSharedDrawing(document, options);
  const svg = markup.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/)?.[0];
  if (!svg) return null;
  const box = modelPlanViewBox(document.bounds);
  const height = Math.round(Math.max(200, Math.min(2400, 1200 * box[3] / Math.max(box[2], .001))));
  const style = `<style>${MODEL_PLAN_STYLE}svg{--model-paper:#fff;--model-line:#7c8b9e;--model-ink:#24344a;--model-blue:#1877ea;background:#fff}</style>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.replace('<svg ', `<svg width="1200" height="${height}" `).replace(/(<svg\b[^>]*>)/, `$1${style}`)}`
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '\uFFFD');
}
