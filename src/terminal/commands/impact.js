// impact — what depends on a source or a dependency.
//
//   source → dependency → document references → shared references
//
// The argument may name either end: a file, or a single dependency. A file
// answers "what breaks if I change this workbook"; a dependency answers "what
// breaks if I change this one number".

import { ACTION, blank, dim, failure, fields, group, result, resultItem, text } from '../result.js';
import { plural, unresolved } from './shared.js';

export function impactCommand(context, command) {
  const target = command.args.join(' ').trim();
  if (!target) {
    return failure('impact', 'impact needs a source file or a dependency name.', {
      hints: ['impact Income-Statement.xlsx', 'impact depreciation-direct'],
    });
  }

  const resolution = context.graph.resolve(context.projectId, target);
  const looksLikeFile = /[./]/.test(target);
  const fromSource = looksLikeFile || resolution.status !== 'RESOLVED'
    ? context.graph.objectsFromSource(context.projectId, target)
    : [];

  // A name that resolves to one dependency wins unless the argument is
  // obviously a path; otherwise a file name that matches indexed objects wins.
  const objects = resolution.status === 'RESOLVED' && (!looksLikeFile || !fromSource.length)
    ? [resolution.object]
    : fromSource;

  if (!objects.length) {
    if (resolution.status === 'AMBIGUOUS') return unresolved('impact', resolution, context);
    return failure('impact', `Nothing indexed matches ${target}.`, {
      hints: ['`find` searches the index.', '`index status` shows which directories are covered.'],
    });
  }

  const singleDependency = objects.length === 1 && resolution.status === 'RESOLVED' && objects[0].id === resolution.object?.id;
  const analysis = context.graph.impactOf(context.projectId, objects);
  const totalReferences = analysis.documents.reduce((sum, document) => sum + document.references, 0);
  const activeShares = analysis.shares.filter((share) => share.status === 'active');
  const staleReferences = analysis.affected.reduce((sum, entry) => sum + entry.stale, 0);

  const blocks = [];
  if (singleDependency) {
    blocks.push(fields([
      ['source', objects[0].path],
      objects[0].locator ? ['location', objects[0].locator] : null,
      ['current value', objects[0].valueText],
      ['references', String(totalReferences)],
      ['documents', String(analysis.documents.length)],
      ['shared links', String(activeShares.length)],
    ]));
  } else {
    blocks.push(fields([
      ['sources', analysis.sources.length === 1 ? analysis.sources[0] : `${analysis.sources.length} files`],
      ['dependencies with references', String(analysis.affected.length)],
      ['documents referencing them', String(analysis.documents.length)],
      ['active shared links', String(activeShares.length)],
    ]));
  }

  if (!analysis.affected.length) {
    blocks.push(blank(), dim('Nothing currently references this source.'));
    return result('impact', {
      headline: singleDependency ? objects[0].name : target,
      blocks,
      hints: ['A dependency gains references when it is inserted from the document editor.'],
      data: analysis,
    });
  }

  if (!singleDependency) {
    blocks.push(blank(), text('affected dependencies'));
    for (const entry of analysis.affected) {
      blocks.push(group(entry.name, [{
        text: [entry.path, entry.locator].filter(Boolean).join('  '),
        meta: `${plural(entry.referenceCount, 'reference')}${entry.stale ? ` · ${entry.stale} stale` : ''}`,
        tone: entry.stale ? 'warn' : 'dim',
      }], entry.value ?? null));
    }
  }

  blocks.push(blank(), text('affected documents'));
  for (const document of analysis.documents) {
    blocks.push(group(document.documentPath, [{
      text: `${plural(document.references, 'reference')}${document.stale ? ` · ${document.stale} stale` : ''}`,
      tone: document.stale ? 'warn' : 'dim',
    }]));
  }

  if (activeShares.length) {
    blocks.push(blank(), text('shared references'));
    for (const share of activeShares) {
      blocks.push(group(share.target, [{
        text: `${share.name} · shared value ${share.sharedValue ?? '—'}`,
        meta: share.drifted ? 'source has changed since sharing' : null,
        tone: share.drifted ? 'warn' : 'dim',
      }]));
    }
  }

  // For a single dependency, every reference is shown with its exact text, so
  // the user can judge each one before deciding to update it.
  const results = singleDependency
    ? analysis.affected.flatMap((entry) => entry.references.map((reference) => resultItem({
      title: reference.documentPath,
      lines: [
        reference.blockIndex == null ? null : `block ${reference.blockIndex}`,
        `"${reference.spanText}"`,
        `source value  ${reference.sourceValue ?? '—'}`,
        `status        ${reference.status.toLowerCase().replace('_', ' ')}`,
      ],
      value: reference.linkedValue,
      tone: reference.status === 'LINKED' ? 'normal' : 'warn',
      ref: { kind: 'dependency', dependencyId: reference.dependencyId, objectId: entry.objectId, name: entry.name },
      actions: [ACTION.inspect, ACTION.updateOne, ACTION.keep],
    })))
    : analysis.affected.map((entry) => resultItem({
      title: entry.name,
      lines: [entry.path, entry.locator || null, `${plural(entry.referenceCount, 'reference')}${entry.stale ? ` · ${entry.stale} stale` : ''}`],
      value: entry.value,
      tone: entry.stale ? 'warn' : 'normal',
      ref: { kind: 'object', objectId: entry.objectId, objectKey: entry.objectKey, name: entry.name, path: entry.path },
      actions: [ACTION.inspect, ACTION.updateOne],
    }));

  return result('impact', {
    headline: singleDependency
      ? plural(totalReferences, 'affected reference')
      : `${plural(analysis.affected.length, 'dependency', 'dependencies')} ${analysis.affected.length === 1 ? 'originates' : 'originate'} from this source`,
    subhead: singleDependency ? objects[0].name : analysis.sources.length === 1 ? analysis.sources[0] : null,
    blocks,
    results,
    actions: [ACTION.inspect, ACTION.update, ACTION.showSource],
    hints: staleReferences
      ? [`\`update ${singleDependency ? objects[0].name : analysis.affected[0].name}\` reviews the stale references before changing anything.`]
      : [],
    data: analysis,
  });
}
