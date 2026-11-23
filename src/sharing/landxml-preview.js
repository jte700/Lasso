// A LandXML source previews as a civil engineer sees it in Civil 3D: the
// plan, with the cited element highlighted, when the file states
// coordinates; otherwise the property table of the cited element's kind
// (pipes, structures, parcels, alignments, curves, PVIs, points, surfaces),
// with the cited cell marked. The whole model without coordinates is an
// outline of what was read. The XML itself stays in the file and in full
// shares, which redact it line by line.

import path from 'node:path';
import { extractLandXmlDocument, isLandXmlContent } from '../dependencies/landxml-extraction.js';
import { buildLandXmlPlan } from './landxml-plan.js';
import { columnName, landXmlTable, rowName, tableKind } from './landxml-table.js';

const CITED_TEXT_LENGTH = 1200;

/** Whether a file is LandXML: a .landxml file, or a civil export saved as .xml. */
export function isLandXmlFile(file) {
  const extension = path.extname(String(file?.path ?? '')).toLowerCase();
  return extension === '.landxml' || (extension === '.xml' && Boolean(file?.content) && isLandXmlContent(file.content));
}

const escapeInline = (text) => String(text).replace(/[\\*_`[\]]/g, '\\$&');
const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** A Civil 3D export names its project by the drawing's path; the file name reads better. */
function projectTitle(title) {
  const name = String(title ?? '').split(/[\\/]/).at(-1).trim();
  return name || 'LandXML civil model';
}

/** Parcels, alignments, profiles, pipe networks, points and surfaces in file order, each with its elements and their values. */
function modelSections(facts) {
  const sections = new Map();
  for (const fact of facts) {
    const type = tableKind(fact);
    if (!type) continue;
    const title = type.title(fact.group ?? null);
    if (!sections.has(title)) sections.set(title, new Map());
    const elements = sections.get(title);
    if (!elements.has(fact.elementId)) elements.set(fact.elementId, { first: type.first, name: rowName(fact), facts: [] });
    elements.get(fact.elementId).facts.push(fact);
  }
  return [...sections].map(([title, elements]) => ({ title, elements: [...elements.values()] }));
}

function citedFact(facts, anchor) {
  if (anchor.identifier) {
    const found = facts.find((fact) => fact.id === anchor.identifier);
    if (found) return found;
  }
  if (!anchor.elementId) return null;
  return facts.find((fact) => fact.elementId === anchor.elementId
    && (!anchor.propertyName || fact.propertyName === anchor.propertyName)) ?? null;
}

/** "rim elevation", "pipe JH-P1 invert", "route JH-MH1 to JH-MH2" without the value. */
function measurementName(fact) {
  if (fact.pipeRef) return `pipe ${fact.pipeRef} invert`;
  return columnName(fact).toLowerCase();
}

const elementTitle = (element) => `${element.first} ${element.name}`;
const elementText = (element) => `${element.first} **${escapeInline(element.name)}**`;

function modelBlocks(title, sections, cited) {
  const blocks = [{ type: 'heading', level: 2, text: escapeInline(title), cited: false }];
  for (const section of sections) {
    blocks.push({ type: 'heading', level: 3, text: escapeInline(section.title), cited: false });
    for (const element of section.elements) {
      // An element with one measurement reads on one line; one with several lists them beneath it.
      if (element.facts.length === 1) {
        const [fact] = element.facts;
        blocks.push({ type: 'item', level: 0, marker: '•', cited: fact === cited,
          text: `${elementText(element)} · ${escapeInline(`${measurementName(fact)} ${fact.value}`)}` });
        continue;
      }
      blocks.push({ type: 'item', level: 0, marker: '•', cited: false, text: elementText(element) });
      for (const fact of element.facts) {
        blocks.push({ type: 'item', level: 1, marker: '•', cited: fact === cited,
          text: escapeInline(`${capitalized(measurementName(fact))} ${fact.value}`) });
      }
    }
  }
  return blocks;
}

/**
 * The card and inspector preview of a LandXML source, or null when Lasso
 * read no value from it (its XML lines show instead). `context` is how many
 * outline blocks to keep before and after the cited one.
 */
export function buildLandXmlPreview(content, anchor, context) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''));
  const model = extractLandXmlDocument(buffer, { lines: true });
  const page = model.pages[0];
  if (!page?.annotations.length) return null;
  const facts = page.annotations;
  const cited = citedFact(facts, anchor ?? {});
  const told = cited ? { openAt: cited.line ? { line: cited.line } : null, text: `${cited.label} ${cited.value}`.slice(0, CITED_TEXT_LENGTH) } : {};
  const table = cited ? landXmlTable(facts, cited) : null;
  // Where the value sits is said as its table names it, under a plan too: "Storm pipes · Pipe JH-P1".
  const plan = buildLandXmlPlan(buffer, cited);
  if (plan) return { ...plan, ...told, location: cited ? table?.location ?? cited.label : 'Plan view' };
  if (table) return { ...table, ...told };
  return outlinePreview(page, facts, cited, context);
}

function outlinePreview(page, facts, cited, context) {
  const sections = modelSections(facts);
  const blocks = modelBlocks(projectTitle(page.title), sections, cited);
  const firstCited = blocks.findIndex((block) => block.cited);
  const start = firstCited < 0 ? 0 : Math.max(0, firstCited - context.blocksBefore);
  const end = Math.min(blocks.length, Math.max(firstCited, 0) + context.blocksAfter);
  const citedElement = cited && sections.flatMap((section) => section.elements.map((element) => ({ section, element })))
    .find(({ element }) => element.facts.includes(cited));
  return {
    kind: 'text', format: 'markdown', extracted: true,
    openAt: cited?.line ? { line: cited.line } : null,
    location: citedElement ? `${citedElement.section.title} · ${elementTitle(citedElement.element)}` : 'Entire model',
    text: cited ? `${cited.label} ${cited.value}`.slice(0, CITED_TEXT_LENGTH) : '',
    firstBlock: start, blockCount: blocks.length,
    blocks: blocks.slice(start, end),
  };
}
