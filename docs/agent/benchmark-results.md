# Lasso agent benchmark: results

Generated 2026-10-27T21:59:11.268Z on darwin arm64, Node v24.13.0. Produced by `node scripts/agent-benchmark.mjs`; the numbers below are this run's.

**Token figures are estimates** (tokenizer-free estimator, same for every arm) of complete-task model input and output under scripted, competent policies. They are not provider-recorded usage, reasoning tokens are not modelled, and a live model may take different steps.

## Complete-task totals (tasks with a direct-tools equivalent)

| Arm | Correct | Est. tokens T | of which tool definitions | Evidence tokens | T, dense estimate | Rounds J | Tool calls | Est. cost (no cache) | Est. cost (prefix cache) | Local tool time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 16/16 | 86,642 | 26,000 | 9,507 | 74,118 | 24 | 40 | $0.4167 | $0.2421 | 87 ms |
| legacy | 15/16 | 129,144 | 30,840 | 41,834 | 104,804 | 24 | 40 | $0.5851 | $0.3787 | 210 ms |
| lasso | 16/16 | 101,441 | 49,402 | 10,744 | 80,803 | 18 | 29 | $0.4713 | $0.2927 | 8 ms |
| optimized | 16/16 | 94,074 | 46,496 | 9,695 | 75,007 | 16 | 16 | $0.4357 | $0.2798 | 5 ms |
| routed | 16/16 | 93,209 | 46,496 | 8,968 | 74,450 | 16 | 16 | $0.4312 | $0.2755 | 5 ms |
| routed-deferred | 16/16 | 88,391 | 41,678 | 8,968 | 71,204 | 16 | 16 | $0.4119 | $0.2654 | 5 ms |

## Aggregate savings S = 1 − ΣT_L / ΣT_0 against direct tools

Negative S means the arm used more tokens than direct tools.

| Arm | S (all) | S, dense estimate | S (code) | S (docs) | Evidence-only saving | Per-task T_L/T_0 min / median / max | Tasks with more tokens than direct |
|---|---|---|---|---|---|---|---|
| legacy | -49.1% | -41.4% | -13.1% | -80.8% | -340% | 1.03 / 1.1 / 5.31 | 16 of 16 |
| lasso | -17.1% | -9% | -32.8% | -3.2% | -13% | 0.68 / 1.1 / 2.39 | 13 of 16 |
| optimized | -8.6% | -1.2% | -15.7% | -2.3% | -2% | 0.64 / 1.1 / 1.62 | 12 of 16 |
| routed | -7.6% | -0.4% | -14.9% | -1.1% | 5.7% | 0.64 / 1.1 / 1.6 | 12 of 16 |
| routed-deferred | -2% | 3.9% | -7% | 2.4% | 5.7% | 0.64 / 1 / 1.6 | 9 of 16 |

## Spread over 5 runs

Folder ids are random, so ranking ties and handle strings differ between runs. The tables above and below are the last run.

| Arm | S median (min…max) | S dense median (min…max) | Evidence-only median (min…max) | Correct per run |
|---|---|---|---|---|
| legacy | -48.9% (-49.3…-48.6) | -41.2% (-41.7…-40.9) | -338.8% (-342.1…-336.8) | 15/16, 15/16, 15/16, 15/16, 15/16 |
| lasso | -17.1% (-17.2…-17.1) | -9% (-9.1…-9) | -13.4% (-13.8…-13) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| optimized | -8.6% (-8.7…-8.6) | -1.2% (-1.2…-1.2) | -2.3% (-2.7…-2) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| routed | -7.6% (-7.6…-7.6) | -0.4% (-0.5…-0.4) | 5.4% (5.1…5.7) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| routed-deferred | -2.1% (-2.1…-2) | 3.9% (3.9…3.9) | 5.4% (5.1…5.7) | 16/16, 16/16, 16/16, 16/16, 16/16 |

## Per task (warm engine)

| Task | Family | Arm | Correct | Est. tokens | Evidence | Rounds | Calls | Local ms |
|---|---|---|---|---|---|---|---|---|
| code-range-known | code | direct | yes | 3810 | 203 | 1 | 1 | 0.1 |
| code-range-known | code | legacy (=direct) | yes | 4052 | 203 | 1 | 1 | 0.1 |
| code-duplicate-named | code | direct | yes | 5474 | 148 | 2 | 2 | 0.1 |
| code-duplicate-named | code | legacy (=direct) | yes | 5837 | 148 | 2 | 2 | 0 |
| code-duplicate-ambiguous | code | direct | yes | 3455 | 36 | 1 | 1 | 0 |
| code-duplicate-ambiguous | code | legacy (=direct) | yes | 3697 | 36 | 1 | 1 | 0 |
| code-function-lookup | code | direct | yes | 6635 | 1093 | 2 | 2 | 9.1 |
| code-function-lookup | code | legacy | yes | 9310 | 2273 | 2 | 2 | 51.6 |
| code-multi-function | code | direct | yes | 9099 | 2505 | 2 | 4 | 10.7 |
| code-multi-function | code | legacy (=direct) | yes | 9462 | 2505 | 2 | 4 | 5.9 |
| code-config-key | code | direct | yes | 3489 | 28 | 1 | 1 | 5 |
| code-config-key | code | legacy | yes | 4448 | 795 | 1 | 1 | 21.7 |
| code-repeated-inspections | code | direct | yes | 5150 | 703 | 1 | 5 | 0.6 |
| code-repeated-inspections | code | legacy (=direct) | yes | 5392 | 703 | 1 | 5 | 0.5 |
| code-stale-reference * | code | direct | **no** | 3810 | 180 | 1 | 1 | 0.1 |
| code-stale-reference * | code | legacy (=direct) | **no** | 4052 | 180 | 1 | 1 | 0.1 |
| code-modified-on-disk | code | direct | yes | 3517 | 39 | 1 | 1 | 0 |
| code-modified-on-disk | code | legacy (=direct) | yes | 3759 | 39 | 1 | 1 | 0 |
| doc-short-file | docs | direct | yes | 3494 | 59 | 1 | 1 | 0 |
| doc-short-file | docs | legacy (=direct) | yes | 3736 | 59 | 1 | 1 | 0 |
| doc-long-fact | docs | direct | yes | 5045 | 1555 | 1 | 1 | 6.9 |
| doc-long-fact | docs | legacy | yes | 26777 | 23121 | 1 | 1 | 27.1 |
| doc-large-table | docs | direct | yes | 5409 | 76 | 2 | 3 | 9.3 |
| doc-large-table | docs | legacy (=direct) | yes | 5772 | 76 | 2 | 3 | 8.9 |
| doc-identifier | docs | direct | yes | 5375 | 64 | 2 | 2 | 5.9 |
| doc-identifier | docs | legacy | **no** | 18881 | 8878 | 2 | 2 | 57.4 |
| doc-ambiguous-sources | docs | direct | yes | 5677 | 135 | 2 | 3 | 4.6 |
| doc-ambiguous-sources | docs | legacy (=direct) | yes | 6040 | 135 | 2 | 3 | 4.5 |
| doc-related-facts | docs | direct | yes | 5447 | 72 | 2 | 2 | 0.1 |
| doc-related-facts | docs | legacy (=direct) | yes | 5810 | 72 | 2 | 2 | 0 |
| doc-missing | docs | direct | yes | 3448 | 15 | 1 | 1 | 7.5 |
| doc-missing | docs | legacy (=direct) | yes | 3690 | 15 | 1 | 1 | 5.6 |
| doc-history * | docs | direct | **no** | 3524 | 43 | 1 | 1 | 0 |
| doc-history * | docs | legacy (=direct) | **no** | 3766 | 43 | 1 | 1 | 0 |
| doc-multi-batch | docs | direct | yes | 12118 | 2776 | 2 | 10 | 26.7 |
| doc-multi-batch | docs | legacy (=direct) | yes | 12481 | 2776 | 2 | 10 | 26.4 |
| code-range-known | code | lasso | yes | 5550 | 305 | 1 | 1 | 0.4 |
| code-range-known | code | optimized | yes | 5550 | 305 | 1 | 1 | 0.3 |
| code-duplicate-named | code | lasso | yes | 5394 | 223 | 1 | 1 | 0.2 |
| code-duplicate-named | code | optimized | yes | 5394 | 223 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | lasso | yes | 5255 | 190 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | optimized | yes | 5255 | 190 | 1 | 1 | 0.2 |
| code-function-lookup | code | lasso | yes | 8920 | 723 | 2 | 2 | 1.4 |
| code-function-lookup | code | optimized | yes | 5730 | 440 | 1 | 1 | 0.8 |
| code-multi-function | code | lasso | yes | 7736 | 1533 | 1 | 3 | 0.9 |
| code-multi-function | code | optimized | yes | 7574 | 1483 | 1 | 1 | 0.5 |
| code-config-key | code | lasso | yes | 5259 | 196 | 1 | 1 | 0.2 |
| code-config-key | code | optimized | yes | 5259 | 196 | 1 | 1 | 0.2 |
| code-repeated-inspections | code | lasso | yes | 7431 | 1222 | 1 | 5 | 1.4 |
| code-repeated-inspections | code | optimized | yes | 6935 | 950 | 1 | 1 | 1 |
| code-stale-reference * | code | lasso | yes | 5663 | 346 | 1 | 1 | 0.4 |
| code-stale-reference * | code | optimized | yes | 5663 | 346 | 1 | 1 | 0.3 |
| code-modified-on-disk | code | lasso | yes | 8407 | 384 | 2 | 2 | 0.5 |
| code-modified-on-disk | code | optimized | yes | 5295 | 163 | 1 | 1 | 0.2 |
| doc-short-file | docs | lasso | yes | 5659 | 560 | 1 | 1 | 0.3 |
| doc-short-file | docs | optimized | yes | 5659 | 560 | 1 | 1 | 0.2 |
| doc-long-fact | docs | lasso | yes | 5591 | 519 | 1 | 1 | 0.2 |
| doc-long-fact | docs | optimized | yes | 5591 | 519 | 1 | 1 | 0.2 |
| doc-large-table | docs | lasso | yes | 5545 | 486 | 1 | 1 | 0.2 |
| doc-large-table | docs | optimized | yes | 5545 | 486 | 1 | 1 | 0.2 |
| doc-identifier | docs | lasso | yes | 5656 | 564 | 1 | 1 | 0.2 |
| doc-identifier | docs | optimized | yes | 5656 | 564 | 1 | 1 | 0.2 |
| doc-ambiguous-sources | docs | lasso | yes | 5765 | 654 | 1 | 1 | 0.2 |
| doc-ambiguous-sources | docs | optimized | yes | 5765 | 654 | 1 | 1 | 0.2 |
| doc-related-facts | docs | lasso | yes | 5565 | 408 | 1 | 1 | 0.2 |
| doc-related-facts | docs | optimized | yes | 5565 | 408 | 1 | 1 | 0.2 |
| doc-missing | docs | lasso | yes | 5528 | 479 | 1 | 1 | 0.3 |
| doc-missing | docs | optimized | yes | 5528 | 479 | 1 | 1 | 0.2 |
| doc-history * | docs | lasso | yes | 8716 | 588 | 2 | 2 | 0.6 |
| doc-history * | docs | optimized | yes | 8716 | 588 | 2 | 2 | 0.7 |
| doc-multi-batch | docs | lasso | yes | 8180 | 2298 | 1 | 6 | 1.1 |
| doc-multi-batch | docs | optimized | yes | 7773 | 2075 | 1 | 1 | 0.5 |

\* capability task: needs history the direct tools cannot reach, so it is left out of the savings and reported as a capability difference.

## Ablation: deterministic insertion (bind)

| Task | Arm | Correct | Est. tokens | Rounds | Calls |
|---|---|---|---|---|---|
| doc-related-facts | direct | yes | 5447 | 2 | 2 |
| doc-related-facts | optimized | yes | 5565 | 1 | 1 |
| doc-related-facts | optimized+bind | yes | 9206 | 2 | 2 |

## Routing

The routed arms send a short read of a file the request already names to direct tools and everything else to Lasso (optimized). "routed" still carries Lasso's definitions on direct tasks, as a connected server does; "routed-deferred" assumes a host that loads them only when used, and does not count the loading call, so it is a lower bound. Tasks sent to direct tools:

- code-range-known
- code-modified-on-disk
- doc-short-file

## Startup, shutdown and idle cost

- Indexing the corpus in the app (one time, not per agent call): 5892 ms.
- In-process engine open: cold 1.9 ms, warm 0.9 ms.
- MCP over stdio (median of 5 launches): initialize answered 64.3 ms after spawn; first tool result 70.3 ms after spawn; process exited 5.9 ms after the host closed stdin (exit codes 0); RSS 156 MB.
- REST, started on demand: first result 111 ms cold (spawn + open + call), 2 ms for a second client reusing it (same process: true); idle RSS 72 MB at 0.6% CPU; stopped 3549 ms after both leases were released (idle time 3 s).

## Cold versus warm Lasso engine (sum of local tool time over the suite)

Cold: the first pass, on engines opened for it. Warm: the same tasks again on the same engines. The routed arms run on the optimized arm's engine after it, so their local time is warm.

- lasso: cold 390 ms, warm 9 ms.
- optimized: cold 350 ms, warm 6 ms.

## Constants

System prompt 1000 tokens per invocation; 15 tokens per tool call and 10 per tool result of framing; tool definitions: direct 650, Lasso 804 (added to the direct tools, never replacing them), terminal find 120. Prices: Claude Opus 5.5 list ($4/$20 per M input/output, cache reads $0.2).

