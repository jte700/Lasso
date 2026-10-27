import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { anchorForSpan, detectClaimSpans } from '../src/dependencies/service.js';
import { diffInternals } from '../src/history/diff.js';

const ada = { id: 'human:ada', displayName: 'Ada Okafor', actorType: 'HUMAN_SELF' };
const alex = { id: 'human:alex', displayName: 'Alex Rivera', actorType: 'HUMAN_COLLABORATOR' };

function locatedClaim(content, expectedText) {
  const blocks = diffInternals.markdownBlocks(content);
  for (const [blockIndex, block] of blocks.entries()) {
    const claim = detectClaimSpans(block.text).find((item) => item.text === expectedText);
    if (claim) {
      return {
        claim,
        anchor: anchorForSpan(blockIndex, block.type, block.text, claim.start, claim.end),
      };
    }
  }
  assert.fail(`Expected a detected claim for ${expectedText}`);
}

test('dependency autocomplete acceptance workflows', async (suite) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-autocomplete-test-'));
  const projectRoot = path.join(sandbox, 'RecoveryStudy');
  const dataDir = path.join(sandbox, 'history');
  for (const directory of ['manuscript', 'references', 'results', 'analysis', 'data', 'figures']) {
    fs.mkdirSync(path.join(projectRoot, directory), { recursive: true });
  }

  const manuscriptPath = path.join(projectRoot, 'manuscript', 'results.md');
  const discussionPath = path.join(projectRoot, 'manuscript', 'discussion.md');
  const accountingPath = path.join(projectRoot, 'manuscript', 'accounting.md');
  const legacyAccountingPath = path.join(projectRoot, 'manuscript', 'accounting-legacy.md');
  const resultPath = path.join(projectRoot, 'results', 'igf1_summary.csv');
  const manuscript = '# Results\n\nJohnson et al. (2024) described recovery signaling.\n\nIGF-1 increased by 50%.\n\nThis paragraph is ordinary narrative prose.\n';
  const discussion = '# Discussion\n\nThe comparator increased by 50%.\n';
  fs.writeFileSync(manuscriptPath, manuscript);
  fs.writeFileSync(discussionPath, discussion);
  fs.writeFileSync(accountingPath, '# Accounting\n\nSupplies were around 120.\n');
  fs.writeFileSync(legacyAccountingPath, '# Accounting\n\nSupplies were recorded.\n');
  fs.writeFileSync(resultPath, 'marker,fold_change\nIGF-1,1.50\n');
  fs.writeFileSync(path.join(projectRoot, 'results', 'igf2_summary.csv'), 'marker,fold_change\nIGF-2,1.50\n');
  fs.writeFileSync(path.join(projectRoot, 'data', 'recovery_cohort.csv'), 'sample_id,group\nS01,treated\nS02,control\n');
  fs.writeFileSync(path.join(projectRoot, 'data', 'data_dictionary.csv'), [
    'variable,description,units',
    'plac_wt,Placental weight measured after delivery,g',
    'maternal_age,Maternal age at enrollment,years',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, 'results', 'study_results.csv'), [
    'variable,estimate',
    'plac_wt,521.4',
    'maternal_age,521.4',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, 'results', 'vitamin_effects.csv'), [
    'variable,fold_change,p_value',
    'Vitamin B1,1.25,0.03',
    'Vitamin B2,0.80,0.04',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, 'data', 'birth_cohort.csv'), [
    'sample_id,birth_weight_g,gestational_age_weeks',
    'S01,3200,39',
    'S02,2875,37',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, 'data', 'placental_vitamins.csv'), [
    'Sample ID,Group,Vitamin B1,Vitamin B2,Vitamin B3,Vitamin B12,Vitamin C',
    'S01,treated,1.4,2.1,3.2,4.8,5.1',
    'S02,control,0.9,1.8,2.7,4.2,4.9',
    'CON4,control,0.7,1.6,2.5,4.0,4.7',
    'CON5,control,0.8,1.7,2.6,4.1,4.8',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, 'data', 'income_statement.csv'), [
    'Account,Current Period,Prior Period,Increase (Decrease)',
    'Supplies,120,100,20',
    'Travel,80,75,5',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, 'data', 'irregular_headers.csv'), '0,1,actual_measure\n2,3,4\n');
  fs.writeFileSync(path.join(projectRoot, 'data', 'preamble_metals.csv'), [
    '0,,88',
    '1',
    'Sample ID,Aluminum,Magnesium',
    'S01,ND,2.4',
    'S02,ND,3.1',
  ].join('\n'));
  fs.writeFileSync(path.join(projectRoot, 'references', 'Xie_findings.md'),
    '# Xie et al.\n\nWe found that gal-3 KO dams were more prone to fetal demise.\n');
  fs.writeFileSync(path.join(projectRoot, 'figures', 'figure_2.png'), Buffer.from('opaque-figure'));
  fs.writeFileSync(path.join(projectRoot, 'references', 'Johnson_2023.pdf'), Buffer.from('%PDF-1.4\n'));
  fs.writeFileSync(path.join(projectRoot, 'references', 'library.bib'), `@article{johnson2022,
  title={Early recovery markers},
  author={Johnson, Leah and Patel, Ari},
  year={2022},
  doi={10.1000/johnson.2022}
}
@article{johnson2024,
  title={IGF-1 signaling during recovery},
  author={Johnson, Leah and Chen, Maya},
  year={2024},
  doi={10.1000/johnson.2024}
}
@article{johnson2025,
  title={Longitudinal recovery signaling},
  author={Johnson, Leah and Rivera, Alex},
  year={2025},
  doi={10.1000/johnson.2025}
}
`);
  const analysisLines = Array.from({ length: 100 }, (_, index) => {
    if (index === 83) return 'def estimate_igf1_fold_change(data):';
    if (index === 84) return '    model = fit_mixed_effects(data)';
    if (index === 90) return '    return 1.50';
    return `# analysis line ${index + 1}`;
  });
  fs.writeFileSync(path.join(projectRoot, 'analysis', 'estimate_fold_change.py'), `${analysisLines.join('\n')}\n`);

  let application = createApplication({ dataDir, watchProjects: false });
  let project = application.timeline.importProject(projectRoot, ada, { watch: false }).project;
  let literatureDependencyId;
  let resultDependencyId;
  let manualDependencyId;
  let tableShareDependencyId;
  let resultCandidate;

  await suite.test('A — Tab acceptance stores an AUTOCOMPLETE literature dependency', () => {
    const prediction = application.dependencies.predict(project.id, {
      text: 'Johnson et al. (2024) described recovery signaling.',
      cursor: 18,
      context: 'Johnson et al. (2024) described recovery signaling.',
      section: 'Results',
      documentPath: 'manuscript/results.md',
    }).claims[0];
    assert.equal(prediction.text, 'Johnson et al. (2024)');
    const selected = prediction.candidates.find((candidate) => candidate.metadata.citationKey === 'johnson2024');
    assert.ok(selected);
    assert.equal(prediction.candidates[0].id, selected.id);
    const located = locatedClaim(manuscript, prediction.text);
    const linked = application.dependencies.link(project.id, {
      documentPath: 'manuscript/results.md',
      anchor: located.anchor,
      spanText: located.claim.text,
      sourceObjectId: selected.id,
      sourceSnapshotId: selected.snapshotId,
      selectionMethod: 'AUTOCOMPLETE',
      confidence: selected.score,
      expectedSnapshotId: project.currentSnapshotId,
    }, ada);
    project = application.timeline.getProject(project.id);
    literatureDependencyId = linked.dependency.id;
    assert.equal(linked.dependency.selectionMethod, 'AUTOCOMPLETE');
    assert.equal(linked.dependency.source.metadata.doi, '10.1000/johnson.2024');
    assert.equal(linked.dependency.spanText, 'Johnson et al. (2024)');
  });

  await suite.test('B — an equivalent +50% result ranks first and exposes its exact code origin', () => {
    const prediction = application.dependencies.predict(project.id, {
      text: 'IGF-1 increased by 50%.',
      cursor: 22,
      context: 'IGF-1 increased by 50%.',
      section: 'Results',
      documentPath: 'manuscript/results.md',
    }).claims[0];
    resultCandidate = prediction.candidates.find((candidate) => candidate.path === 'results/igf1_summary.csv'
      && candidate.valueText === '1.50');
    assert.equal(prediction.candidates[0].id, resultCandidate.id);
    assert.equal(resultCandidate.displayValue, '+50%');
    application.timeline.addProvenanceLink(project.id, {
      fromSnapshotId: resultCandidate.snapshotId,
      fromPath: resultCandidate.path,
      relation: 'GENERATED_BY',
      toSnapshotId: resultCandidate.snapshotId,
      toPath: 'analysis/estimate_fold_change.py',
      toAnchor: { kind: 'line', line: 84, lineStart: 84, lineEnd: 91 },
      metadata: { function: 'estimate_igf1_fold_change', version: project.currentVersion },
    });
    const located = locatedClaim(manuscript, prediction.text);
    const linked = application.dependencies.link(project.id, {
      documentPath: 'manuscript/results.md',
      anchor: located.anchor,
      spanText: located.claim.text,
      sourceObjectId: resultCandidate.id,
      sourceSnapshotId: resultCandidate.snapshotId,
      selectionMethod: 'AUTOCOMPLETE',
      confidence: resultCandidate.score,
      expectedSnapshotId: project.currentSnapshotId,
    }, ada);
    project = application.timeline.getProject(project.id);
    resultDependencyId = linked.dependency.id;
    assert.equal(linked.dependency.source.origin.path, 'analysis/estimate_fold_change.py');
    assert.deepEqual(linked.dependency.source.origin.anchor, { kind: 'line', line: 84, lineStart: 84, lineEnd: 91 });
  });

  await suite.test('C — same-valued results remain alternatives and entity context breaks the tie', () => {
    const candidates = application.dependencies.predict(project.id, {
      text: 'IGF-1 increased by 50%.',
      cursor: 22,
      context: 'IGF-1 increased by 50%.',
      documentPath: 'manuscript/results.md',
    }).claims[0].candidates;
    const igf1 = candidates.find((candidate) => candidate.path === 'results/igf1_summary.csv' && candidate.valueText === '1.50');
    const igf2 = candidates.find((candidate) => candidate.path === 'results/igf2_summary.csv' && candidate.valueText === '1.50');
    assert.ok(igf1 && igf2);
    assert.ok(candidates.indexOf(igf1) < candidates.indexOf(igf2));
    assert.ok(igf1.score > igf2.score);
    assert.equal(candidates.some((candidate) => candidate.valueText === 'IGF-1'), false,
      'row identifiers should enrich result labels, not become numeric result candidates');
  });

  await suite.test('D — manual selection records only the chosen canonical source', () => {
    const prediction = application.dependencies.predict(project.id, {
      text: 'The comparator increased by 50%.',
      cursor: 31,
      context: 'The comparator increased by 50%.',
      documentPath: 'manuscript/discussion.md',
    }).claims[0];
    const selected = prediction.candidates.find((candidate) => candidate.path === 'results/igf2_summary.csv'
      && candidate.valueText === '1.50');
    assert.ok(selected);
    const located = locatedClaim(discussion, prediction.text);
    const linked = application.dependencies.link(project.id, {
      documentPath: 'manuscript/discussion.md',
      anchor: located.anchor,
      spanText: located.claim.text,
      sourceObjectId: selected.id,
      sourceSnapshotId: selected.snapshotId,
      selectionMethod: 'MANUAL',
      expectedSnapshotId: project.currentSnapshotId,
    }, ada);
    project = application.timeline.getProject(project.id);
    manualDependencyId = linked.dependency.id;
    const dependencies = application.dependencies.getDocument(project.id, 'manuscript/discussion.md').dependencies;
    assert.equal(dependencies.length, 1);
    assert.equal(dependencies[0].selectionMethod, 'MANUAL');
    assert.equal(dependencies[0].source.id, selected.id);
  });

  await suite.test('E — ordinary prose produces no dependency popup payload', () => {
    const prediction = application.dependencies.predict(project.id, {
      text: 'This paragraph is ordinary narrative prose.',
      cursor: 21,
      context: 'This paragraph is ordinary narrative prose.',
      documentPath: 'manuscript/results.md',
    });
    assert.equal(prediction.claims.length, 0);
  });

  await suite.test('E2 — partial entities and unfinished result values predict while typing', () => {
    const entity = application.dependencies.predict(project.id, {
      text: 'IGF',
      cursor: 3,
      context: 'IGF',
      documentPath: 'manuscript/results.md',
    }).claims[0];
    assert.equal(entity.type, 'STUDY_VARIABLE');
    assert.equal(entity.partial, true);
    assert.equal(entity.candidates[0].path, 'results/igf1_summary.csv');

    const result = application.dependencies.predict(project.id, {
      text: 'IGF-1 increased by 50',
      cursor: 21,
      context: 'IGF-1 increased by 50',
      section: 'Results',
      documentPath: 'manuscript/results.md',
    }).claims[0];
    assert.equal(result.type, 'QUANTITATIVE');
    assert.equal(result.partial, true);
    assert.equal(result.candidates[0].path, 'results/igf1_summary.csv');
    assert.equal(result.candidates[0].displayValue, '+50%');
  });

  await suite.test('E3 — study numbers resolve through dictionary definitions and inferred variables', () => {
    const dictionaryPrediction = application.dependencies.predict(project.id, {
      text: 'The mean placental weight was 521.4 g',
      cursor: 40,
      context: 'The mean placental weight was 521.4 g',
      section: 'Results',
      documentPath: 'manuscript/results.md',
    }).claims.find((claim) => claim.studyResult);
    assert.ok(dictionaryPrediction);
    assert.equal(dictionaryPrediction.variable, 'placental weight');
    assert.equal(dictionaryPrediction.candidates[0].path, 'results/study_results.csv');
    assert.equal(dictionaryPrediction.candidates[0].valueText, '521.4');
    assert.equal(dictionaryPrediction.candidates[0].metadata.variable, 'plac_wt');
    assert.equal(dictionaryPrediction.candidates[0].metadata.definition, 'Placental weight measured after delivery');
    assert.equal(dictionaryPrediction.candidates[0].variableDefinition.description, 'Placental weight measured after delivery');
    assert.ok(dictionaryPrediction.candidates[0].reasons.includes('matching data dictionary definition'));

    const inferredPrediction = application.dependencies.predict(project.id, {
      text: 'Birth weight was 3200 g',
      cursor: 23,
      context: 'Birth weight was 3200 g',
      section: 'Results',
      documentPath: 'manuscript/results.md',
    }).claims.find((claim) => claim.studyResult);
    assert.ok(inferredPrediction);
    assert.equal(inferredPrediction.variable, 'Birth weight');
    assert.equal(inferredPrediction.candidates[0].path, 'data/birth_cohort.csv');
    assert.equal(inferredPrediction.candidates[0].valueText, '3200');
    assert.equal(inferredPrediction.candidates[0].metadata.variable, 'birth_weight_g');
    assert.ok(inferredPrediction.candidates[0].reasons.includes('matching study variable'));
    assert.match(inferredPrediction.candidates[0].variableDefinition.description, /birth weight g; inferred numeric variable/);
    assert.equal(inferredPrediction.candidates[0].variableDefinition.inferred, true);
  });

  await suite.test('E4 — first-person study prose searches project data progressively and never paper prose', () => {
    const cue = application.dependencies.predict(project.id, {
      text: 'We found that', cursor: 'We found that'.length,
      context: 'We found that', documentPath: 'manuscript/results.md',
    });
    assert.equal(cue.completion, null);
    assert.equal(cue.claims.length, 0);
    assert.equal(cue.sourceContext.kind, 'PROJECT_DATA');
    assert.equal(cue.sourceContext.exclusive, true);
    assert.ok(cue.workspaceCompletions.length >= 2);
    assert.ok(cue.workspaceCompletions.every((suggestion) => suggestion.generated === false));
    assert.ok(cue.workspaceCompletions.some((suggestion) => suggestion.dependencyCandidate.objectType === 'VARIABLE'));
    assert.ok(cue.workspaceCompletions.every((suggestion) => suggestion.dependencyCandidate.objectType !== 'VARIABLE'
      || /[A-Za-z]/.test(suggestion.replacementText)));

    const ownWorkspacePrompts = [
      'Our data showed that',
      'The study found a',
      'In the current analysis, we observed',
      'These results indicate',
      'Our cohort includes',
    ];
    for (const text of ownWorkspacePrompts) {
      const contextual = application.dependencies.predict(project.id, {
        text, cursor: text.length, context: text, documentPath: 'manuscript/results.md',
      });
      assert.equal(contextual.sourceContext.kind, 'PROJECT_DATA', text);
      assert.ok(contextual.workspaceCompletions.length >= 2, text);
      assert.ok(contextual.workspaceCompletions.every((suggestion) => suggestion.replacementText
        && suggestion.dependencyCandidate.path
        && !['PAPER', 'REFERENCE'].includes(suggestion.dependencyCandidate.objectType)), text);
      assert.ok(contextual.workspaceCompletions.some((suggestion) => /^(?:data|results|analysis)\//.test(
        suggestion.dependencyCandidate.path,
      )), text);
    }

    const partialText = 'We found that vitam';
    const partial = application.dependencies.predict(project.id, {
      text: partialText, cursor: partialText.length,
      context: partialText, documentPath: 'manuscript/results.md',
    }).claims[0];
    assert.equal(partial.type, 'STUDY_VARIABLE');
    assert.equal(partial.text, 'vitam');
    assert.equal(partial.start, 'We found that '.length);
    assert.equal(partial.candidates[0].label, 'Vitamin B1');
    assert.equal(partial.candidates[0].completionText, 'Vitamin B1');
    assert.equal(partial.candidates[0].path, 'data/placental_vitamins.csv');
    assert.equal(partial.candidates[0].objectType, 'VARIABLE');
    // The results file's own Vitamin B1 and B2 rows follow the data's columns of the same name.
    assert.deepEqual(partial.candidates.map((candidate) => `${candidate.label} · ${candidate.path}`), [
      'Vitamin B1 · data/placental_vitamins.csv', 'Vitamin B1 · results/vitamin_effects.csv',
      'Vitamin B12 · data/placental_vitamins.csv',
      'Vitamin B2 · data/placental_vitamins.csv', 'Vitamin B2 · results/vitamin_effects.csv',
      'Vitamin B3 · data/placental_vitamins.csv', 'Vitamin C · data/placental_vitamins.csv',
    ]);
    assert.ok(partial.candidates.every((candidate) => !['PAPER', 'REFERENCE'].includes(candidate.objectType)));

    const alternateWording = 'Our study found that vita';
    const alternate = application.dependencies.predict(project.id, {
      text: alternateWording, cursor: alternateWording.length,
      context: alternateWording, documentPath: 'manuscript/results.md',
    }).claims[0];
    assert.equal(alternate.text, 'vita');
    assert.equal(alternate.candidates.length, partial.candidates.length);

    const noTemplate = 'Vitam';
    const direct = application.dependencies.predict(project.id, {
      text: noTemplate, cursor: noTemplate.length,
      context: noTemplate, documentPath: 'manuscript/results.md',
    }).claims[0];
    assert.equal(direct.text, 'Vitam');
    assert.equal(direct.candidates.length, partial.candidates.length);

    const exactText = 'We found that vitamin B1';
    const exact = application.dependencies.predict(project.id, {
      text: exactText, cursor: exactText.length,
      context: exactText, documentPath: 'manuscript/results.md',
    }).claims[0];
    assert.equal(exact.candidates[0].label, 'Vitamin B1');
    assert.ok(exact.candidates[0].score >= 0.95);

    const valueText = 'We found that Vitamin B1 was 1.4';
    const value = application.dependencies.predict(project.id, {
      text: valueText, cursor: valueText.length,
      context: valueText, documentPath: 'manuscript/results.md',
    }).claims.find((claim) => claim.studyResult);
    assert.ok(value);
    assert.equal(value.variable, 'Vitamin B1');
    assert.equal(value.candidates[0].path, 'data/placental_vitamins.csv');
    assert.equal(value.candidates[0].valueText, '1.4');

    const preambleText = 'Our data showed that magnes';
    const preambleVariable = application.dependencies.predict(project.id, {
      text: preambleText, cursor: preambleText.length,
      context: preambleText, documentPath: 'manuscript/results.md',
    }).claims[0].candidates[0];
    assert.equal(preambleVariable.label, 'Magnesium');
    assert.equal(preambleVariable.path, 'data/preamble_metals.csv');

    const scopedText = 'Our data showed that Vitamin B1 increased by';
    const scopedVariableStart = scopedText.indexOf('Vitamin B1');
    const scopedVariableEnd = scopedVariableStart + 'Vitamin B1'.length;
    const scopedValue = application.dependencies.predict(project.id, {
      text: scopedText, cursor: scopedText.length, blockIndex: 1,
      context: scopedText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-vitamin-b1', blockIndex: 1, start: scopedVariableStart, end: scopedVariableEnd,
        sourceObjectId: exact.candidates[0].id, sourceSnapshotId: exact.candidates[0].snapshotId,
      }],
    });
    assert.equal(scopedValue.sourceContext.kind, 'PROJECT_OBJECT');
    assert.equal(scopedValue.sourceContext.variable, 'Vitamin B1');
    assert.equal(scopedValue.workspaceHeading, 'Values for Vitamin B1');
    assert.equal(scopedValue.workspaceCompletions[0].replacementText, '25%');
    assert.equal(scopedValue.workspaceCompletions[0].dependencyCandidate.path, 'results/vitamin_effects.csv');
    assert.equal(scopedValue.workspaceCompletions[0].dependencyCandidate.metadata.column, 'fold_change');
    assert.ok(scopedValue.workspaceCompletions.every((suggestion) => suggestion.dependencyCandidate.objectType !== 'VARIABLE'
      && suggestion.dependencyCandidate.metadata.variable === 'Vitamin B1'));

    const aluminumText = 'Our data showed that Aluminum increased by';
    const aluminumStart = aluminumText.indexOf('Aluminum');
    const aluminumCandidate = application.dependencies.predict(project.id, {
      text: 'Our data showed that Alum', cursor: 'Our data showed that Alum'.length,
      context: 'Our data showed that Alum', documentPath: 'manuscript/results.md',
    }).claims[0].candidates.find((candidate) => candidate.path === 'data/preamble_metals.csv');
    assert.ok(aluminumCandidate);
    const unsupportedChange = application.dependencies.predict(project.id, {
      text: aluminumText, cursor: aluminumText.length, blockIndex: 1,
      context: aluminumText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-aluminum', blockIndex: 1, start: aluminumStart, end: aluminumStart + 'Aluminum'.length,
        sourceObjectId: aluminumCandidate.id, sourceSnapshotId: aluminumCandidate.snapshotId,
      }],
    });
    assert.equal(unsupportedChange.sourceContext.kind, 'PROJECT_OBJECT');
    assert.ok(unsupportedChange.workspaceCompletions.length > 0);
    assert.ok(unsupportedChange.workspaceCompletions.every((suggestion) => suggestion.dependencyCandidate.objectType !== 'VARIABLE'
      && suggestion.dependencyCandidate.metadata.variable === 'Aluminum'));
    assert.ok(unsupportedChange.workspaceCompletions.some((suggestion) => suggestion.replacementText === 'not detected'));

    const partialRowText = 'Our data showed that Vitamin B1 CO';
    const partialRow = application.dependencies.predict(project.id, {
      text: partialRowText, cursor: partialRowText.length, blockIndex: 1,
      context: partialRowText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-vitamin-b1', blockIndex: 1,
        start: partialRowText.indexOf('Vitamin B1'), end: partialRowText.indexOf('Vitamin B1') + 'Vitamin B1'.length,
        sourceObjectId: exact.candidates[0].id, sourceSnapshotId: exact.candidates[0].snapshotId,
      }],
    });
    assert.equal(partialRow.workspaceHeading, 'Rows for Vitamin B1');
    assert.deepEqual(partialRow.workspaceCompletions.map((suggestion) => suggestion.replacementText), ['CON4', 'CON5']);
    assert.ok(partialRow.workspaceCompletions.every((suggestion) => suggestion.category === 'Row'
      && suggestion.claimStart === partialRowText.lastIndexOf('CO')
      && suggestion.claimEnd === partialRowText.length
      && suggestion.dependencyCandidate.metadata.variable === 'Vitamin B1'));

    const narrowerRowText = 'Our data showed that Vitamin B1 CON4';
    const narrowerRow = application.dependencies.predict(project.id, {
      text: narrowerRowText, cursor: narrowerRowText.length, blockIndex: 1,
      context: narrowerRowText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-vitamin-b1', blockIndex: 1,
        start: narrowerRowText.indexOf('Vitamin B1'), end: narrowerRowText.indexOf('Vitamin B1') + 'Vitamin B1'.length,
        sourceObjectId: exact.candidates[0].id, sourceSnapshotId: exact.candidates[0].snapshotId,
      }],
    });
    assert.equal(narrowerRow.workspaceHeading, 'Values for Vitamin B1');
    assert.ok(narrowerRow.workspaceCompletions.length > 0);
    assert.ok(narrowerRow.workspaceCompletions.every((suggestion) => suggestion.dependencyCandidate.metadata.row === 'CON4'));

    for (const rowWording of ['CON4', 'control 4']) {
      const rowText = `Our data showed that Vitamin B1 ${rowWording} had`;
      const rowValue = application.dependencies.predict(project.id, {
        text: rowText, cursor: rowText.length, blockIndex: 1,
        context: rowText, documentPath: 'manuscript/results.md',
        pendingDependencies: [{
          id: 'pending-vitamin-b1', blockIndex: 1,
          start: rowText.indexOf('Vitamin B1'), end: rowText.indexOf('Vitamin B1') + 'Vitamin B1'.length,
          sourceObjectId: exact.candidates[0].id, sourceSnapshotId: exact.candidates[0].snapshotId,
        }],
      });
      assert.equal(rowValue.workspaceCompletions[0].replacementText, '0.7', rowWording);
      assert.equal(rowValue.workspaceCompletions[0].dependencyCandidate.metadata.row, 'CON4', rowWording);
      assert.equal(rowValue.workspaceCompletions[0].dependencyCandidate.metadata.variable, 'Vitamin B1', rowWording);
      assert.match(rowValue.workspaceCompletions[0].provenanceLabel, /CON4.*Vitamin B1/, rowWording);
    }

    const selectedRowText = 'Our data showed that Vitamin B1 CON4 had';
    const selectedRowStart = selectedRowText.indexOf('CON4');
    const selectedRowSource = partialRow.workspaceCompletions.find((suggestion) => suggestion.replacementText === 'CON4').dependencyCandidate;
    const selectedRowValue = application.dependencies.predict(project.id, {
      text: selectedRowText, cursor: selectedRowText.length, blockIndex: 1,
      context: selectedRowText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-con4', blockIndex: 1, start: selectedRowStart, end: selectedRowStart + 'CON4'.length,
        sourceObjectId: selectedRowSource.id, sourceSnapshotId: selectedRowSource.snapshotId,
      }],
    });
    assert.equal(selectedRowValue.workspaceHeading, 'Values for Vitamin B1');
    assert.equal(selectedRowValue.workspaceCompletions[0].replacementText, '0.7');
    assert.ok(selectedRowValue.workspaceCompletions.every((suggestion) => suggestion.dependencyCandidate.metadata.row === 'CON4'));

    const suppliesPrefix = 'The income statement shows that the Supp';
    const suppliesClaim = application.dependencies.predict(project.id, {
      text: suppliesPrefix, cursor: suppliesPrefix.length,
      context: suppliesPrefix, documentPath: 'manuscript/results.md',
    }).claims[0];
    const suppliesSource = suppliesClaim.candidates.find((candidate) => candidate.completionText === 'Supplies'
      && candidate.path === 'data/income_statement.csv');
    assert.ok(suppliesSource);
    assert.equal(suppliesSource.objectType, 'DATASET_ROW');
    assert.equal(suppliesSource.valueText, null);
    assert.equal(suppliesSource.anchor.kind, 'table-row');

    const rowCandidates = application.dependencies.candidatesForClaim(project.id, {
      type: 'ENTITY', text: 'Tra', value: 'Tra', partial: true,
    }, { context: 'I reviewed Tra' });
    assert.equal(rowCandidates[0].objectType, 'DATASET_ROW');
    assert.equal(rowCandidates[0].label, 'Travel');
    assert.equal(rowCandidates[0].valueText, null);

    const fieldText = 'The income statement shows that the Supplies for the';
    const suppliesStart = fieldText.indexOf('Supplies');
    const fieldPrediction = application.dependencies.predict(project.id, {
      text: fieldText, cursor: fieldText.length, blockIndex: 1,
      context: fieldText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-supplies', blockIndex: 1, start: suppliesStart, end: suppliesStart + 'Supplies'.length,
        sourceObjectId: suppliesSource.id, sourceSnapshotId: suppliesSource.snapshotId,
      }],
    });
    assert.equal(fieldPrediction.workspaceHeading, 'Columns for Supplies');
    assert.deepEqual(fieldPrediction.workspaceCompletions.map((suggestion) => suggestion.replacementText),
      ['Current Period', 'Prior Period', 'Increase (Decrease)']);
    assert.ok(fieldPrediction.workspaceCompletions.every((suggestion) => suggestion.category === 'Column'
      && suggestion.dependencyCandidate.metadata.row === 'Supplies'));

    const partialFieldText = 'The income statement shows that the Supplies for the pri';
    const partialFieldPrediction = application.dependencies.predict(project.id, {
      text: partialFieldText, cursor: partialFieldText.length, blockIndex: 1,
      context: partialFieldText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-supplies', blockIndex: 1, start: suppliesStart, end: suppliesStart + 'Supplies'.length,
        sourceObjectId: suppliesSource.id, sourceSnapshotId: suppliesSource.snapshotId,
      }],
    });
    assert.equal(partialFieldPrediction.workspaceCompletions[0].replacementText, 'Prior Period');
    assert.equal(partialFieldPrediction.workspaceCompletions[0].claimStart, partialFieldText.lastIndexOf('pri'));

    const priorField = fieldPrediction.workspaceCompletions.find((suggestion) => suggestion.replacementText === 'Prior Period');
    const selectedFieldText = 'The income statement shows that the Supplies for the Prior Period was';
    const priorStart = selectedFieldText.indexOf('Prior Period');
    const selectedFieldValue = application.dependencies.predict(project.id, {
      text: selectedFieldText, cursor: selectedFieldText.length, blockIndex: 1,
      context: selectedFieldText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-prior-period', blockIndex: 1, start: priorStart, end: priorStart + 'Prior Period'.length,
        sourceObjectId: priorField.dependencyCandidate.id,
        sourceSnapshotId: priorField.dependencyCandidate.snapshotId,
      }],
    });
    assert.equal(selectedFieldValue.workspaceHeading, 'Value for Supplies · Prior Period');
    assert.equal(selectedFieldValue.workspaceCompletions[0].replacementText, '100');
    assert.equal(selectedFieldValue.workspaceCompletions[0].dependencyCandidate.metadata.column, 'Prior Period');

    const unknownRowText = 'Our data showed that Vitamin B1 control 999 had';
    const unknownRow = application.dependencies.predict(project.id, {
      text: unknownRowText, cursor: unknownRowText.length, blockIndex: 1,
      context: unknownRowText, documentPath: 'manuscript/results.md',
      pendingDependencies: [{
        id: 'pending-vitamin-b1', blockIndex: 1,
        start: unknownRowText.indexOf('Vitamin B1'), end: unknownRowText.indexOf('Vitamin B1') + 'Vitamin B1'.length,
        sourceObjectId: exact.candidates[0].id, sourceSnapshotId: exact.candidates[0].snapshotId,
      }],
    });
    assert.equal(unknownRow.workspaceCompletions.length, 0);
    assert.match(unknownRow.notice, /control999|con999/i);

    const endedVariableScope = application.dependencies.predict(project.id, {
      text: scopedText, cursor: scopedText.length, blockIndex: 1,
      context: scopedText, documentPath: 'manuscript/results.md',
      sourceScopeBoundary: scopedText.length,
      pendingDependencies: [{
        id: 'pending-vitamin-b1', blockIndex: 1, start: scopedVariableStart, end: scopedVariableEnd,
        sourceObjectId: exact.candidates[0].id, sourceSnapshotId: exact.candidates[0].snapshotId,
      }],
    });
    assert.equal(endedVariableScope.sourceContext.kind, 'PROJECT_DATA');
  });

  await suite.test('E5 — row dependencies carry row semantics and preview every associated column', () => {
    const text = 'The income statement shows that the Supp';
    const rowSource = application.dependencies.predict(project.id, {
      text, cursor: text.length, context: text, documentPath: 'manuscript/accounting.md',
    }).claims[0].candidates.find((candidate) => candidate.completionText === 'Supplies'
      && candidate.path === 'data/income_statement.csv');
    assert.ok(rowSource);

    const document = application.dependencies.getDocument(project.id, 'manuscript/accounting.md');
    const blockIndex = document.blocks.findIndex((block) => block.text.includes('Supplies'));
    const block = document.blocks[blockIndex];
    const start = block.text.indexOf('Supplies');
    const linked = application.dependencies.link(project.id, {
      documentPath: 'manuscript/accounting.md',
      anchor: anchorForSpan(blockIndex, block.type, block.text, start, start + 'Supplies'.length),
      spanText: 'Supplies',
      sourceObjectId: rowSource.id,
      sourceSnapshotId: rowSource.snapshotId,
      selectionMethod: 'AUTOCOMPLETE',
      expectedSnapshotId: project.currentSnapshotId,
    }, ada);
    project = application.timeline.getProject(project.id);
    assert.equal(linked.dependency.source.objectType, 'DATASET_ROW');
    assert.equal(linked.dependency.source.valueText, null);

    const preview = application.dependencies.dependencyPreview(linked.dependency.id, { contextRadius: 1 });
    assert.equal(preview.source.objectType, 'DATASET_ROW');
    assert.equal(preview.source.valueText, null);
    assert.equal(preview.content.referenceKind, 'ROW');
    assert.equal(preview.content.selectedColumn, -1);
    assert.deepEqual(preview.content.headers,
      ['Account', 'Current Period', 'Prior Period', 'Increase (Decrease)']);
    assert.deepEqual(preview.content.rows, [['Supplies', '120', '100', '20']]);

    const viewer = application.dependencies.dependencySourceViewer(linked.dependency.id);
    assert.equal(viewer.kind, 'table');
    assert.equal(viewer.selectedRow, 0);
    assert.equal(viewer.selectedColumn, -1);
    assert.deepEqual(viewer.headers, ['Account', 'Current Period', 'Prior Period', 'Increase (Decrease)']);
    assert.deepEqual(viewer.rows.slice(0, 2), [['Supplies', '120', '100', '20'], ['Travel', '80', '75', '5']]);
    assert.match(viewer.fileUrl, /\/source-file$/);

    const settings = application.dependencies.dependencyShareSettings(linked.dependency.id);
    assert.equal(settings.dependency.source.objectType, 'DATASET_ROW');
    assert.equal(settings.dependency.source.valueText, null);
  });

  await suite.test('E6 — existing cell-backed row links are interpreted as rows in the inspector', () => {
    const cellSource = application.dependencies.objectsAt(project.id, project.currentSnapshotId)
      .find((object) => object.path === 'data/income_statement.csv'
        && object.objectType === 'DATASET_VALUE'
        && object.anchor?.rowKey === 'Supplies'
        && object.anchor?.column === 'Current Period');
    assert.ok(cellSource);
    const document = application.dependencies.getDocument(project.id, 'manuscript/accounting-legacy.md');
    const blockIndex = document.blocks.findIndex((block) => block.text.includes('Supplies'));
    const block = document.blocks[blockIndex];
    const start = block.text.indexOf('Supplies');
    const linked = application.dependencies.link(project.id, {
      documentPath: 'manuscript/accounting-legacy.md',
      anchor: anchorForSpan(blockIndex, block.type, block.text, start, start + 'Supplies'.length),
      spanText: 'Supplies',
      sourceObjectId: cellSource.id,
      sourceSnapshotId: cellSource.snapshotId,
      selectionMethod: 'AUTOCOMPLETE',
      expectedSnapshotId: project.currentSnapshotId,
    }, ada);
    project = application.timeline.getProject(project.id);
    assert.equal(linked.dependency.source.objectType, 'DATASET_VALUE');
    assert.equal(linked.dependency.source.valueText, '120');

    const preview = application.dependencies.dependencyPreview(linked.dependency.id, { contextRadius: 1 });
    assert.equal(preview.source.objectType, 'DATASET_ROW');
    assert.equal(preview.source.valueText, null);
    assert.deepEqual(preview.content.headers,
      ['Account', 'Current Period', 'Prior Period', 'Increase (Decrease)']);
    assert.deepEqual(preview.content.rows, [['Supplies', '120', '100', '20']]);
  });

  await suite.test('F — same-author papers remain visible and deterministically disambiguated', () => {
    const candidates = application.dependencies.predict(project.id, {
      text: 'Johnson et al. described recovery signaling.',
      cursor: 15,
      context: 'Johnson et al. described recovery signaling.',
      documentPath: 'manuscript/results.md',
    }).claims[0].candidates;
    const johnson = candidates.filter((candidate) => candidate.metadata.author === 'Johnson, Leah and Patel, Ari'
      || candidate.metadata.author === 'Johnson, Leah and Chen, Maya'
      || candidate.metadata.author === 'Johnson, Leah and Rivera, Alex');
    assert.equal(johnson.length, 3);
    assert.deepEqual(johnson.map((candidate) => candidate.metadata.year), ['2025', '2024', '2022']);
  });

  await suite.test('G — RFI and dependency inspection reach the selected code-line version', () => {
    const dependency = application.dependencies.getDependency(resultDependencyId);
    assert.equal(dependency.source.origin.path, 'analysis/estimate_fold_change.py');
    assert.equal(dependency.source.origin.snapshotId, resultCandidate.snapshotId);
    assert.equal(dependency.source.origin.anchor.lineStart, 84);
    assert.equal(dependency.source.origin.anchor.lineEnd, 91);
    const rfi = application.rfi.request(project.id, {
      path: dependency.documentPath,
      snapshotId: project.currentSnapshotId,
      anchor: dependency.anchor,
    });
    const code = rfi.provenance.find((link) => link.to.path === 'analysis/estimate_fold_change.py');
    assert.ok(code);
    assert.equal(code.to.anchor.lineStart, 84);
    assert.equal(rfi.linkedDependency.id, resultDependencyId);
  });

  await suite.test('H — changed source values mark links stale without rewriting prose', () => {
    fs.writeFileSync(resultPath, 'marker,fold_change\nIGF-1,1.42\n');
    const capture = application.timeline.capture(project.id, ada, {
      expectedSnapshotId: project.currentSnapshotId,
      source: 'WATCHER',
    });
    project = application.timeline.getProject(project.id);
    const dependency = application.dependencies.getDependency(resultDependencyId);
    assert.equal(capture.changed, true);
    assert.equal(dependency.status, 'STALE');
    assert.equal(dependency.statusDetails.linkedSourceValue, '1.50');
    assert.equal(dependency.statusDetails.currentSourceValue, '1.42');
    assert.match(fs.readFileSync(manuscriptPath, 'utf8'), /increased by 50%/);
  });

  await suite.test('I — a collaborator and application restart see the same dependency identity', async () => {
    fs.appendFileSync(manuscriptPath, '\nAlex reviewed this paragraph.\n');
    application.timeline.capture(project.id, alex, {
      expectedSnapshotId: project.currentSnapshotId,
      source: 'COLLABORATOR_SYNC',
    });
    project = application.timeline.getProject(project.id);
    const beforeRestart = application.dependencies.getDocument(project.id, 'manuscript/results.md')
      .dependencies.find((dependency) => dependency.id === resultDependencyId);
    assert.ok(beforeRestart);
    assert.equal(beforeRestart.status, 'STALE');
    await application.close();
    application = createApplication({ dataDir, watchProjects: false });
    project = application.timeline.getProject(project.id);
    const afterRestart = application.dependencies.getDocument(project.id, 'manuscript/results.md')
      .dependencies.find((dependency) => dependency.id === resultDependencyId);
    assert.equal(afterRestart.id, beforeRestart.id);
    assert.equal(afterRestart.source.id, beforeRestart.source.id);
    assert.equal(afterRestart.linkedBy.displayName, 'Ada Okafor');
    const literature = application.dependencies.getDependency(literatureDependencyId);
    const literatureRfi = application.rfi.request(project.id, {
      path: literature.documentPath,
      snapshotId: project.currentSnapshotId,
      anchor: literature.anchor,
    });
    assert.equal(literatureRfi.linkedDependency.source.metadata.doi, '10.1000/johnson.2024');
    assert.equal(literatureRfi.provenance[0].relation, 'DEPENDS_ON');
  });

  await suite.test('J — autocomplete, manual, stale, and collaborator actions are timeline evidence', () => {
    const events = application.timeline.listEvents(project.id);
    assert.ok(events.filter((event) => event.source === 'DEPENDENCY_LINKED').length >= 3);
    assert.ok(events.some((event) => event.source === 'DEPENDENCY_STALE'));
    assert.ok(events.some((event) => event.source === 'COLLABORATOR_SYNC' && event.actor.displayName === 'Alex Rivera'));
    assert.equal(application.dependencies.getDependency(literatureDependencyId).selectionMethod, 'AUTOCOMPLETE');
    assert.equal(application.dependencies.getDependency(manualDependencyId).selectionMethod, 'MANUAL');
  });

  await suite.test('K — queued editor links commit together in one dependency version', () => {
    const birthSentence = 'Birth weight was 3200 g.';
    const placentalSentence = 'The mean placental weight was 521.4 g.';
    const content = `${fs.readFileSync(manuscriptPath, 'utf8').trim()}\n\n${birthSentence}\n\n${placentalSentence}\n`;
    application.dependencies.saveDocument(project.id, {
      path: 'manuscript/results.md', content, baseSnapshotId: project.currentSnapshotId,
    }, ada);
    project = application.timeline.getProject(project.id);
    const document = application.dependencies.getDocument(project.id, 'manuscript/results.md');
    const prepared = [birthSentence, placentalSentence].map((sentence) => {
      const blockIndex = document.blocks.findIndex((block) => block.text === sentence);
      const block = document.blocks[blockIndex];
      const claim = application.dependencies.predict(project.id, {
        text: sentence, cursor: sentence.length - 1, context: sentence,
        blockIndex, section: 'Results', documentPath: 'manuscript/results.md',
      }).claims.find((item) => item.studyResult);
      assert.ok(claim);
      return {
        documentPath: 'manuscript/results.md',
        anchor: anchorForSpan(blockIndex, block.type, block.text, claim.start, claim.end),
        spanText: claim.text,
        sourceObjectId: claim.candidates[0].id,
        sourceSnapshotId: claim.candidates[0].snapshotId,
        selectionMethod: 'AUTOCOMPLETE',
        confidence: claim.candidates[0].score,
      };
    });
    const beforeVersion = project.currentVersion;
    const linked = application.dependencies.linkMany(project.id, {
      links: prepared, expectedSnapshotId: project.currentSnapshotId,
    }, ada);
    project = application.timeline.getProject(project.id);
    assert.equal(linked.dependencies.length, 2);
    tableShareDependencyId = linked.dependencies[0].id;
    assert.equal(project.currentVersion, beforeVersion + 1);
    assert.equal(linked.event.dependencyChanges.length, 2);
    assert.ok(linked.dependencies.every((dependency) => dependency.selectionMethod === 'AUTOCOMPLETE'));
  });

  await suite.test('L — dependency sharing defaults to cited context and never exposes a full table implicitly', () => {
    const ownerPreview = application.dependencies.dependencyPreview(tableShareDependencyId, { contextRadius: 0 });
    assert.equal(ownerPreview.accessScope, 'CONTEXT');
    assert.equal(ownerPreview.content.kind, 'table-context');
    assert.equal(ownerPreview.content.rows.length, 1);
    assert.ok(ownerPreview.content.headers.some((header) => /birth_weight/i.test(header)));
    assert.ok(ownerPreview.content.rows[0].includes('S01'));
    assert.ok(ownerPreview.content.rows[0].includes('3200'));

    const contextSettings = application.dependencies.configureDependencyShare(tableShareDependencyId, {
      scope: 'CONTEXT', recipientLabel: 'Review collaborator', contextRadius: 0,
    }, ada);
    assert.equal(contextSettings.recommendedScope, 'CONTEXT');
    assert.equal(contextSettings.grants.length, 1);
    const contextShare = application.dependencies.sharedDependency(contextSettings.grants[0].token);
    assert.equal(contextShare.access.scope, 'CONTEXT');
    assert.equal(contextShare.content.kind, 'table-context');
    assert.equal(contextShare.content.rows.length, 1);
    assert.ok(contextShare.content.headers.some((header) => /birth_weight/i.test(header)));
    assert.ok(contextShare.content.rows[0].includes('S01'));
    assert.ok(contextShare.content.rows[0].includes('3200'));

    const fullSettings = application.dependencies.configureDependencyShare(tableShareDependencyId, {
      scope: 'FULL', recipientLabel: 'Data reviewer',
    }, ada);
    const fullGrant = fullSettings.grants.find((grant) => grant.scope === 'FULL');
    const fullShare = application.dependencies.sharedDependency(fullGrant.token);
    assert.equal(fullShare.content.kind, 'table');
    assert.ok(fullShare.content.rows.length >= 2);

    const privateSettings = application.dependencies.configureDependencyShare(tableShareDependencyId, {
      scope: 'PRIVATE',
    }, ada);
    assert.equal(privateSettings.grants.length, 0);
    assert.throws(() => application.dependencies.sharedDependency(fullGrant.token), /unavailable|expired/i);
  });

  await suite.test('M: a shared link publishes only file names and closes when its dependency is removed', () => {
    // Arrange
    const settings = application.dependencies.configureDependencyShare(tableShareDependencyId, {
      scope: 'FULL', recipientLabel: 'Auditor',
    }, ada);
    const token = settings.grants.find((grant) => grant.scope === 'FULL').token;
    const shared = application.dependencies.sharedDependency(token);
    assert.equal(shared.documentPath, undefined, 'the private manuscript path is not published');
    assert.ok(!shared.source.path.includes('/'), `only the file name is published: ${shared.source.path}`);

    // Act
    application.dependencies.revise(tableShareDependencyId, ada, { action: 'REMOVE' });

    // Assert
    assert.throws(() => application.dependencies.sharedDependency(token), /unavailable|expired/i);
    const open = application.db.prepare(`SELECT COUNT(*) AS count FROM dependency_share_grants
      WHERE dependency_id = ? AND revoked_at IS NULL`).get(tableShareDependencyId).count;
    assert.equal(open, 0);
  });

  await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});
