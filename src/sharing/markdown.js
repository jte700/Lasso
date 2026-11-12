// Markdown structure shared by previews, the private inspector, the share
// composer and recipient pages. Each block keeps its original source lines so
// redactions, downloads and citations always refer to the pinned file itself.

import { locateWords, sourceWords } from './passage-locator.js';

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const TABLE_DIVIDER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/// Recorded on Markdown BLOCK redactions so their indexes keep their meaning.
export const MARKDOWN_LAYOUT = 'markdown';

export function isMarkdownPath(filePath) {
  return /\.(?:md|mdx|qmd|rmd)$/i.test(String(filePath ?? ''));
}

function indentWidth(value) {
  return [...value].reduce((width, character) => width + (character === '\t' ? 4 : 1), 0);
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/**
 * Splits Markdown into display blocks. Every list item is its own block so a
 * single entry can be cited or redacted without hiding its neighbours.
 */
export function markdownBlocks(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    blocks.push(current);
    current = null;
  };
  const start = (type, index, extra = {}) => {
    flush();
    current = { type, level: 0, lines: [], source: [], lineStart: index + 1, lineEnd: index + 1, ...extra };
  };
  const append = (index, content, source = lines[index]) => {
    current.lines.push(content);
    current.source.push(source);
    current.lineEnd = index + 1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (current?.type === 'code' && current.fence) {
      const closing = line.match(FENCE);
      if (closing && closing[1][0] === current.fence[0] && closing[1].length >= current.fence.length && !closing[2]) {
        current.source.push(line);
        current.lineEnd = index + 1;
        current.fence = null;
        flush();
      } else {
        append(index, line);
      }
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      start('code', index, { fence: fence[1], language: fence[2] || null });
      current.source.push(line);
      continue;
    }

    if (!line.trim()) {
      // Blank lines inside an item belong to that item only when the next line
      // is still indented beneath it; otherwise the block ends here.
      flush();
      continue;
    }

    if (current?.type === 'table' && line.includes('|')) {
      append(index, line);
      continue;
    }
    if (line.includes('|') && TABLE_DIVIDER.test(lines[index + 1] ?? '') && (lines[index + 1] ?? '').includes('-')) {
      start('table', index);
      append(index, line);
      append(index + 1, lines[index + 1]);
      index += 1;
      continue;
    }

    const heading = line.match(ATX_HEADING);
    if (heading) {
      start('heading', index, { level: heading[1].length });
      append(index, heading[2] ?? '');
      flush();
      continue;
    }

    if (current?.type === 'paragraph' && /^ {0,3}=+[ \t]*$/.test(line)) {
      current.type = 'heading';
      current.level = 1;
      current.source.push(line);
      current.lineEnd = index + 1;
      flush();
      continue;
    }
    if (current?.type === 'paragraph' && /^ {0,3}-+[ \t]*$/.test(line)) {
      current.type = 'heading';
      current.level = 2;
      current.source.push(line);
      current.lineEnd = index + 1;
      flush();
      continue;
    }

    if (RULE.test(line)) {
      start('rule', index);
      append(index, '');
      flush();
      continue;
    }

    const quote = line.match(QUOTE);
    if (quote) {
      if (current?.type !== 'quote') start('quote', index);
      append(index, quote[1]);
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item && (item[3] !== undefined || current?.type !== 'paragraph')) {
      const ordered = /\d/.test(item[2]);
      const depth = Math.min(6, Math.floor(indentWidth(item[1]) / 2));
      const task = item[3]?.match(/^\[([ xX])\][ \t]+(.*)$/);
      start('item', index, {
        level: depth, ordered,
        marker: ordered ? `${item[2].slice(0, -1)}.` : '•',
        ...(task ? { checked: task[1].toLowerCase() === 'x' } : {}),
      });
      append(index, task ? task[2] : item[3] ?? '');
      continue;
    }

    if (current?.type === 'item' && /^[ \t]+\S/.test(line)) {
      append(index, line.trim());
      continue;
    }

    if (current?.type !== 'paragraph') start('paragraph', index);
    append(index, line.trim());
  }
  flush();

  return blocks.map(({ fence, lines: content, source, ...block }) => {
    const text = block.type === 'code' ? content.join('\n')
      : block.type === 'table' ? content.join('\n')
        : block.type === 'quote' ? content.join('\n').trim()
          : content.join(block.type === 'paragraph' || block.type === 'item' ? '\n' : ' ').trim();
    return {
      ...block,
      text,
      source: source.join('\n'),
      ...(block.type === 'table' ? { rows: content.filter((_, row) => row !== 1).map(tableCells) } : {}),
    };
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

/**
 * Inline Markdown as escaped HTML. Images are reduced to their alternative
 * text so a preview never loads a remote or local resource. Links become
 * anchors only for web and mail addresses, and only when the caller allows it.
 */
export function markdownInlineHtml(value, { links = true } = {}) {
  const tokens = [];
  const hold = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let text = String(value ?? '');

  text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escapeHtml(code.trim())}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(([^()\s]*)(?:\s+"[^"]*")?\)/g, (_, alt) =>
    hold(`<span class="md-image">${escapeHtml(alt || 'Image')}</span>`));
  text = text.replace(/\[([^\]]+)\]\(([^()\s]*)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const inner = markdownInlineHtml(label, { links: false });
    return hold(links && SAFE_LINK.test(href)
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${inner}</a>`
      : `<span class="md-link">${inner}</span>`);
  });
  text = text.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, href) => hold(links
    ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(href)}</a>`
    : `<span class="md-link">${escapeHtml(href)}</span>`));

  let html = escapeHtml(text);
  html = html.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  html = html.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  html = html.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  html = html.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');
  html = html.replace(/\n/g, '<br>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

/** Readable text for a block, without inline Markdown markers. */
export function markdownPlainText(value) {
  return String(value ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, '$1')
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, '$2')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1');
}

const PASSAGE_BLOCKS = new Set(['paragraph', 'item', 'quote']);
const MAX_PASSAGES = 2000;
const passageWords = (value) => String(value ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
// Read in place at an offset, so a long text is not copied for every sentence.
const CLOSING_MARKS = /[*_~`]*[.!?:;]?/y;
const LEADING_MARKS = /[^\p{L}\p{N}]*/uy;

/**
 * Sentences and paragraphs of a Markdown or plain-text source, the way PDF
 * passages are indexed. Each passage keeps its offsets and 1-based line range
 * in the original text so previews and shares cite exactly that passage.
 * Headings, tables and code are structure, not prose, and are not passages.
 */
export function markdownPassages(value, { plain = false } = {}) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  const lineOffsets = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lineOffsets.push(index + 1);
  const lineAt = (offset) => {
    let low = 0;
    let high = lineOffsets.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineOffsets[middle] <= offset) low = middle; else high = middle - 1;
    }
    return low + 1;
  };
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const source = sourceWords(text);
  const passages = [];
  let section = null;

  const add = (selectedText, excerptType, start, end) => {
    if (selectedText.length < 18 || selectedText.length > 1600 || (selectedText.match(/\p{L}+/gu)?.length ?? 0) < 4) return;
    passages.push({ excerptType, selectedText, start, end, lineStart: lineAt(start), lineEnd: lineAt(Math.max(start, end - 1)), section });
  };

  for (const block of markdownBlocks(text)) {
    if (block.type === 'heading') { section = markdownPlainText(block.text).trim() || section; continue; }
    if (!PASSAGE_BLOCKS.has(block.type)) continue;
    const blockStart = lineOffsets[block.lineStart - 1] ?? 0;
    const blockEnd = (lineOffsets[block.lineEnd] ?? text.length + 1) - 1;
    const prose = (plain ? block.text : markdownPlainText(block.text)).replace(/\s+/g, ' ').trim();
    if (!prose) continue;
    let cursor = blockStart;
    const locate = (sentence) => {
      const words = passageWords(sentence);
      // Links and images keep text in the source that their readable form drops,
      // so fall back to locating the opening and closing words separately.
      let found = locateWords(source, words, cursor, blockEnd);
      if (!found) {
        const head = locateWords(source, words.slice(0, 3), cursor, blockEnd);
        const tail = head && locateWords(source, words.slice(-3), head.start, blockEnd);
        found = head && tail ? { start: head.start, end: tail.end } : null;
      }
      if (found) {
        // Closing emphasis markers and the sentence's own punctuation belong to it.
        CLOSING_MARKS.lastIndex = found.end;
        found.end = Math.min(blockEnd, found.end + CLOSING_MARKS.exec(text)[0].length);
        cursor = found.end;
      }
      LEADING_MARKS.lastIndex = cursor;
      const span = found ?? { start: cursor + Math.min(LEADING_MARKS.exec(text)[0].length, Math.max(0, blockEnd - cursor)), end: blockEnd };
      return { text: sentence, ...span };
    };

    // Sentences are read one at a time, so a long paragraph stops being read
    // once the passage limit is reached.
    let paragraph = null;
    let count = 0;
    for (const part of segmenter.segment(prose)) {
      const trimmed = part.segment.trim();
      if (!trimmed) continue;
      const sentence = locate(trimmed);
      count += 1;
      if (sentence.text.length <= 420) add(sentence.text, 'sentence', sentence.start, sentence.end);
      if (paragraph && paragraph.text.length + sentence.text.length > 1400) {
        add(paragraph.text, 'paragraph', paragraph.start, paragraph.end);
        paragraph = null;
      }
      if (passages.length >= MAX_PASSAGES) return passages.slice(0, MAX_PASSAGES);
      paragraph = paragraph ? { ...paragraph, text: `${paragraph.text} ${sentence.text}`, end: sentence.end } : { ...sentence };
    }
    // One-sentence paragraphs already have a precise sentence passage.
    if (paragraph && (count > 1 || paragraph.text.length > 420)) add(paragraph.text, 'paragraph', paragraph.start, paragraph.end);
    if (passages.length >= MAX_PASSAGES) return passages.slice(0, MAX_PASSAGES);
  }
  return passages;
}

/** One block as HTML. `inner` replaces the content, for example with a mask. */
export function markdownBlockHtml(block, { links = true, inner = null, className = '' } = {}) {
  const classes = (extra = '') => {
    const value = [extra, className].filter(Boolean).join(' ');
    return value ? ` class="${value}"` : '';
  };
  const content = inner ?? markdownInlineHtml(block.text, { links });
  switch (block.type) {
    case 'heading': return `<h${block.level + 2}${classes(`md-heading md-h${block.level}`)}>${content}</h${block.level + 2}>`;
    case 'item': {
      const marker = block.checked === undefined ? escapeHtml(block.marker ?? '•') : block.checked ? '☑' : '☐';
      return `<div${classes(`md-item${block.ordered ? ' md-ordered' : ''}`)} style="--md-depth:${block.level ?? 0}"><span class="md-marker" aria-hidden="true">${marker}</span><div>${content}</div></div>`;
    }
    case 'code': return `<pre${classes('md-code')}>${inner ?? `<code>${escapeHtml(block.text)}</code>`}</pre>`;
    case 'quote': return `<blockquote${classes('md-quote')}>${content}</blockquote>`;
    case 'rule': return `<hr${classes('md-rule')}>`;
    case 'table': return inner
      ? `<div${classes('md-table')}>${inner}</div>`
      : `<div${classes('md-table')}><table><thead><tr>${(block.rows[0] ?? []).map((cell) => `<th>${markdownInlineHtml(cell, { links })}</th>`).join('')}</tr></thead><tbody>${block.rows.slice(1).map((row) => `<tr>${row.map((cell) => `<td>${markdownInlineHtml(cell, { links })}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    default: return `<p${classes('md-paragraph')}>${content}</p>`;
  }
}

/** Shared Markdown typography for server-rendered pages. */
export const MARKDOWN_STYLE = `
  .markdown-document{display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
  .markdown-document .md-heading{margin:14px 0 4px;color:var(--text);line-height:1.25;letter-spacing:-.01em}
  .markdown-document .md-heading:first-child{margin-top:0}
  .markdown-document .md-h1{font-size:20px}.markdown-document .md-h2{font-size:16px}.markdown-document .md-h3{font-size:14px}
  .markdown-document .md-h4,.markdown-document .md-h5,.markdown-document .md-h6{font-size:13px}
  .markdown-document .md-paragraph{margin:4px 0}
  .markdown-document .md-item{display:flex;gap:7px;margin:1px 0;padding-left:calc(4px + var(--md-depth,0) * 18px)}
  .markdown-document .md-marker{flex:0 0 auto;min-width:12px;color:var(--text2);font-variant-numeric:tabular-nums}
  .markdown-document .md-ordered .md-marker{min-width:18px;text-align:right}
  .markdown-document .md-quote{margin:4px 0;padding:2px 0 2px 11px;border-left:3px solid var(--line);color:var(--text2)}
  .markdown-document .md-code{margin:6px 0;padding:9px 11px;overflow:auto;border-radius:7px;background:rgba(127,127,127,.1);font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
  .markdown-document code{padding:1px 4px;border-radius:4px;background:rgba(127,127,127,.12);font:.92em ui-monospace,SFMono-Regular,Menlo,monospace}
  .markdown-document .md-code code{padding:0;background:none;font:inherit}
  .markdown-document .md-rule{width:100%;margin:10px 0;border:0;border-top:1px solid var(--line)}
  .markdown-document .md-table{margin:6px 0;overflow:auto}
  .markdown-document .md-table table{border-collapse:collapse;font-size:12px}
  .markdown-document .md-table th,.markdown-document .md-table td{padding:4px 8px;border:1px solid var(--line);text-align:left}
  .markdown-document .md-image,.markdown-document .md-link{color:var(--accent)}
  .markdown-document a{color:var(--accent)}
  .markdown-document .cited{margin-left:-6px;margin-right:-6px;padding-left:6px;padding-right:6px;border-radius:5px;
    background:color-mix(in srgb,var(--cited,var(--accent)) 14%,transparent);box-shadow:inset 2.5px 0 0 var(--cited,var(--accent))}
`;
