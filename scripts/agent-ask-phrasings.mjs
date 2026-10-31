// How `lasso` copes with the ways a model words an ask: 104 phrasings of the
// benchmark's 18 tasks (terse keywords, full questions, paths with and
// without folders, range lists, objects), each answered in one call and
// graded as live answers are. Calls no model and spends nothing.
//
//   node scripts/agent-ask-phrasings.mjs [task-id-substring]
//
// The phrasings were written to find where asks fail, before the fixes they
// led to; a failure prints the answer the model would have seen.

import fs from 'node:fs';
import { openLocal } from '../src/agent/client.js';
import { formatAnswer } from '../src/agent/render.js';
import { estimateTokens } from '../src/agent/metrics.js';
import { composeAnswer, graders, prepareLibrary, REPEATED_RANGES, taskPrompts } from './agent-benchmark-corpus.mjs';

function phrasings(truth, oldBillingRev, prompts) {
  const range = `${truth.discount.start}-${truth.discount.start + 11}`;
  const cited = `${truth.discount.originalStart}-${truth.discount.originalStart + 11}`;
  const repeated = REPEATED_RANGES.map(([first, last]) => `${first}-${last}`);
  return {
    'code-range-known': [[`Shop/lib/billing.py lines ${range}`], [`lines ${range} of Shop/lib/billing.py`], [`Shop/lib/billing.py:${range}`],
      [`billing.py lines ${range}`], [prompts['code-range-known']], [{ file: 'Shop/lib/billing.py', lines: range }],
      [`Shop/lib/billing.py L${truth.discount.start}-L${truth.discount.start + 11}`]],
    'code-duplicate-named': [['Admin app.py lines 10-20'], ['Admin/app.py lines 10-20'], ['app.py in the Admin folder, lines 10-20'],
      [prompts['code-duplicate-named']], [{ file: 'app.py', folder: 'Admin', lines: '10-20' }], ['Admin/src/app.py lines 10-20'], ['lines 10-20 of Admin/app.py']],
    'code-duplicate-ambiguous': [['app.py lines 1-5'], ['lines 1-5 of app.py'], ['app.py:1-5'], [prompts['code-duplicate-ambiguous']], [{ file: 'app.py', lines: '1-5' }]],
    'code-function-lookup': [['apply_discount function'], ['apply_discount'], ['def apply_discount'], ['full apply_discount function'],
      [{ symbol: 'apply_discount' }], [prompts['code-function-lookup']], ['apply_discount definition']],
    'code-multi-function': [['normalize_sku', 'retry_payment', 'registerRoutes'], ['normalize_sku function', 'retry_payment function', 'registerRoutes function'],
      ['definitions of normalize_sku, retry_payment and registerRoutes'], ['normalize_sku, retry_payment, registerRoutes'], [prompts['code-multi-function']],
      [{ symbol: 'normalize_sku' }, { symbol: 'retry_payment' }, { symbol: 'registerRoutes' }]],
    'code-config-key': [['MAX_RETRIES'], ['where is MAX_RETRIES defined'], ['MAX_RETRIES definition and value'], ['MAX_RETRIES value'],
      [prompts['code-config-key']], [{ symbol: 'MAX_RETRIES' }]],
    'code-repeated-inspections': [[`Shop/lib/billing.py lines ${repeated.join(', ')}`], repeated.map((lines) => `Shop/lib/billing.py lines ${lines}`),
      repeated.map((lines) => `billing.py lines ${lines}`), [prompts['code-repeated-inspections']],
      repeated.map((lines) => ({ file: 'Shop/lib/billing.py', lines })), [`Shop/lib/billing.py:${repeated.join(',')}`]],
    'code-stale-reference': [[`Shop/lib/billing.py lines ${cited} at revision ${oldBillingRev}`], [`Shop/lib/billing.py lines ${cited} @${oldBillingRev}`],
      [prompts['code-stale-reference']], [{ file: 'Shop/lib/billing.py', lines: cited, rev: oldBillingRev }], [`Shop/lib/billing.py lines ${cited} at commit ${oldBillingRev}`]],
    'code-modified-on-disk': [['Shop/web/routes.js lines 1-3 as the file is now'], ['Shop/web/routes.js lines 1-3 on disk'], ['Shop/web/routes.js lines 1-3'],
      [prompts['code-modified-on-disk']], [{ file: 'Shop/web/routes.js', lines: '1-3', version: 'disk' }], ['current Shop/web/routes.js lines 1-3']],
    'doc-short-file': [['vendor review date in Finance/notes/short_note.md'], [prompts['doc-short-file']], ['short_note.md vendor review'], ['vendor review scheduled'],
      ['Finance/notes/short_note.md'], ['vendor review'], ['when is the vendor review']],
    'doc-long-fact': [['warranty reserve at year end in the annual report'], ['year-end warranty reserve'], ['warranty reserve'],
      ['annual report warranty reserve year end'], [prompts['doc-long-fact']], ['warranty reserve year end']],
    'doc-large-table': [['balance of Account 104233'], ['Account 104233 balance'], ['Account 104233'], ['104233'], ['ledger Account 104233 balance'],
      [prompts['doc-large-table']], ['account 104233 balance in the ledger']],
    'doc-identifier': [['INV-2025-00417 customer and amount'], ['invoice INV-2025-00417'], ['INV-2025-00417'], ['customer and amount for invoice INV-2025-00417'],
      [prompts['doc-identifier']]],
    'doc-ambiguous-sources': [['North division FY2025 revenue'], ['North division revenue'], [prompts['doc-ambiguous-sources']], ['revenue North division'], ['North division']],
    'doc-related-facts': [['South division Revenue, Reporting period, Headcount in the approved budget'], ['approved budget South division revenue reporting period headcount'],
      ['South division approved budget'], [prompts['doc-related-facts']], ['South division revenue, reporting period and headcount (approved budget)']],
    'doc-missing': [['West division revenue'], ['West division'], [prompts['doc-missing']], ['revenue of the West division']],
    'doc-history': [['North division planning revenue before the latest change'], ['North division revenue in the planning budget before the last change'],
      ['history of North division revenue in planning budget'], [prompts['doc-history']], ['previous value of North division planning revenue'],
      ['North division revenue planning budget history']],
    'doc-multi-batch': [['Account 120001 balance', 'INV-2025-01200 customer', 'warranty reserve year end', 'vendor review date', 'East division approved revenue',
      'Central division planning headcount'], [prompts['doc-multi-batch']], ['the balance of Account 120001', 'the customer of INV-2025-01200',
      'the year-end warranty reserve', 'the vendor review date', 'the East division approved revenue', 'the Central division planning headcount'],
    ['Account 120001', 'INV-2025-01200', 'warranty reserve', 'vendor review', 'East division revenue approved', 'Central division headcount planning']],
  };
}

async function main() {
  const only = process.argv[2];
  const library = await prepareLibrary();
  const lasso = openLocal({ dataDir: library.dataDir, scope: ['*'], client: 'phrasings' });
  const grade = graders(library);
  let passed = 0;
  let failed = 0;
  try {
    for (const [task, asks] of Object.entries(phrasings(library.truth, library.oldBillingRev, taskPrompts(library.truth, library.oldBillingRev)))) {
      if (only && !task.includes(only)) continue;
      for (const ask of asks) {
        const response = lasso.ask({ ask });
        const rendered = formatAnswer('ask', response);
        const correct = grade[task](composeAnswer(response));
        if (correct) passed += 1; else failed += 1;
        console.log(`${correct ? 'ok  ' : 'FAIL'} ${task} ${JSON.stringify(ask).slice(0, 110)} (~${estimateTokens(rendered)} tokens)`);
        if (!correct) console.log(rendered.split('\n').slice(0, 16).map((line) => `      ${line.slice(0, 200)}`).join('\n'));
      }
    }
  } finally {
    await lasso.close();
    await library.app.close();
    fs.rmSync(library.root, { recursive: true, force: true });
  }
  console.log(`\n${passed} answered correctly, ${failed} not`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
