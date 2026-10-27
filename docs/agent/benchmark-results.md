# Lasso agent benchmark: results

Generated 2026-10-27T22:48:16.071Z on darwin arm64, Node v24.13.0. Produced by `node scripts/agent-benchmark.mjs`; the numbers below are this run's.

**Token figures are estimates** (tokenizer-free estimator, same for every arm) of complete-task model input and output under scripted, competent policies. They are not provider-recorded usage, reasoning tokens are not modelled, and a live model may take different steps.

## Complete-task totals (tasks with a direct-tools equivalent)

| Arm | Correct | Est. tokens T | of which tool definitions | Evidence tokens | T, conservative estimate | Rounds J | Tool calls | Est. cost (no cache) | Est. cost (prefix cache) | Local tool time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 16/16 | 67,718 | 11,040 | 7,842 | 71,682 | 24 | 40 | $0.3279 | $0.1928 | 81 ms |
| legacy | 15/16 | 104,644 | 20,600 | 31,315 | 128,976 | 24 | 40 | $0.4745 | $0.3025 | 203 ms |
| lasso | 16/16 | 67,484 | 22,542 | 5,400 | 69,896 | 18 | 29 | $0.3217 | $0.2004 | 7 ms |
| optimized | 16/16 | 62,748 | 21,216 | 4,945 | 64,888 | 16 | 16 | $0.2980 | $0.1918 | 5 ms |
| routed | 16/16 | 62,405 | 21,216 | 4,678 | 64,423 | 16 | 16 | $0.2960 | $0.1900 | 5 ms |
| routed-deferred | 16/16 | 60,083 | 18,894 | 4,678 | 62,101 | 16 | 16 | $0.2867 | $0.1851 | 4 ms |

## Aggregate savings S = 1 − ΣT_L / ΣT_0 against direct tools

Negative S means the arm used more tokens than direct tools.

| Arm | S (all) | S, conservative estimate | S (code) | S (docs) | Evidence-only saving | Per-task T_L/T_0 min / median / max | Tasks with more tokens than direct |
|---|---|---|---|---|---|---|---|
| legacy | -54.5% | -79.9% | -20.9% | -85% | -299.3% | 1.08 / 1.2 / 5.13 | 16 of 16 |
| lasso | 0.3% | 2.5% | -14% | 13.3% | 31.1% | 0.54 / 0.9 / 2.08 | 8 of 16 |
| optimized | 7.3% | 9.5% | 0% | 14% | 36.9% | 0.52 / 0.9 / 1.37 | 7 of 16 |
| routed | 7.8% | 10.1% | 0.3% | 14.6% | 40.3% | 0.52 / 0.9 / 1.36 | 7 of 16 |
| routed-deferred | 11.3% | 13.4% | 5.2% | 16.8% | 40.3% | 0.52 / 0.9 / 1.36 | 4 of 16 |

## Spread over 5 runs

Folder ids are random, so ranking ties and handle strings differ between runs. The tables above and below are the last run.

| Arm | S median (min…max) | S conservative median (min…max) | Evidence-only median (min…max) | Correct per run |
|---|---|---|---|---|
| legacy | -54.4% (-54.8…-54.1) | -79.9% (-80.2…-79.6) | -298% (-301.6…-296.5) | 15/16, 15/16, 15/16, 15/16, 15/16 |
| lasso | 0.3% (0.3…0.4) | 2.4% (2.4…2.5) | 31.1% (30.8…31.5) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| optimized | 7.3% (7.3…7.4) | 9.4% (9.4…9.5) | 37% (36.6…37.3) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| routed | 7.9% (7.8…7.9) | 10.1% (10…10.2) | 40.4% (40.1…40.7) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| routed-deferred | 11.3% (11.2…11.3) | 13.3% (13.3…13.4) | 40.4% (40.1…40.7) | 16/16, 16/16, 16/16, 16/16, 16/16 |

## Per task (warm engine)

| Task | Family | Arm | Correct | Est. tokens | Evidence | Rounds | Calls | Local ms |
|---|---|---|---|---|---|---|---|---|
| code-range-known | code | direct | yes | 2988 | 178 | 1 | 1 | 0.1 |
| code-range-known | code | legacy (=direct) | yes | 3466 | 178 | 1 | 1 | 0.1 |
| code-duplicate-named | code | direct | yes | 4258 | 125 | 2 | 2 | 0.1 |
| code-duplicate-named | code | legacy (=direct) | yes | 4975 | 125 | 2 | 2 | 0 |
| code-duplicate-ambiguous | code | direct | yes | 2686 | 33 | 1 | 1 | 0 |
| code-duplicate-ambiguous | code | legacy (=direct) | yes | 3164 | 33 | 1 | 1 | 0 |
| code-function-lookup | code | direct | yes | 5287 | 975 | 2 | 2 | 9.1 |
| code-function-lookup | code | legacy | yes | 7673 | 1826 | 2 | 2 | 49 |
| code-multi-function | code | direct | yes | 7344 | 2193 | 2 | 4 | 10.7 |
| code-multi-function | code | legacy (=direct) | yes | 8061 | 2193 | 2 | 4 | 5.7 |
| code-config-key | code | direct | yes | 2700 | 26 | 1 | 1 | 5 |
| code-config-key | code | legacy | yes | 3708 | 588 | 1 | 1 | 21.5 |
| code-repeated-inspections | code | direct | yes | 4198 | 650 | 1 | 5 | 0.6 |
| code-repeated-inspections | code | legacy (=direct) | yes | 4676 | 650 | 1 | 5 | 0.5 |
| code-stale-reference * | code | direct | **no** | 2978 | 155 | 1 | 1 | 0.1 |
| code-stale-reference * | code | legacy (=direct) | **no** | 3456 | 155 | 1 | 1 | 0.1 |
| code-modified-on-disk | code | direct | yes | 2729 | 32 | 1 | 1 | 0 |
| code-modified-on-disk | code | legacy (=direct) | yes | 3207 | 32 | 1 | 1 | 0 |
| doc-short-file | docs | direct | yes | 2707 | 47 | 1 | 1 | 0 |
| doc-short-file | docs | legacy (=direct) | yes | 3185 | 47 | 1 | 1 | 0 |
| doc-long-fact | docs | direct | yes | 3883 | 1186 | 1 | 1 | 4.9 |
| doc-long-fact | docs | legacy | yes | 19938 | 16815 | 1 | 1 | 26.6 |
| doc-large-table | docs | direct | yes | 4190 | 65 | 2 | 3 | 8.6 |
| doc-large-table | docs | legacy (=direct) | yes | 4907 | 65 | 2 | 3 | 8.5 |
| doc-identifier | docs | direct | yes | 4192 | 61 | 2 | 2 | 5.8 |
| doc-identifier | docs | legacy | **no** | 14499 | 6492 | 2 | 2 | 55.5 |
| doc-ambiguous-sources | docs | direct | yes | 4425 | 121 | 2 | 3 | 4.5 |
| doc-ambiguous-sources | docs | legacy (=direct) | yes | 5142 | 121 | 2 | 3 | 5.9 |
| doc-related-facts | docs | direct | yes | 4229 | 65 | 2 | 2 | 0.1 |
| doc-related-facts | docs | legacy (=direct) | yes | 4946 | 65 | 2 | 2 | 0 |
| doc-missing | docs | direct | yes | 2671 | 13 | 1 | 1 | 5.6 |
| doc-missing | docs | legacy (=direct) | yes | 3149 | 13 | 1 | 1 | 5.5 |
| doc-history * | docs | direct | **no** | 2729 | 40 | 1 | 1 | 0 |
| doc-history * | docs | legacy (=direct) | **no** | 3207 | 40 | 1 | 1 | 0 |
| doc-multi-batch | docs | direct | yes | 9231 | 2072 | 2 | 10 | 25.4 |
| doc-multi-batch | docs | legacy (=direct) | yes | 9948 | 2072 | 2 | 10 | 24.2 |
| code-range-known | code | lasso | yes | 3800 | 198 | 1 | 1 | 0.4 |
| code-range-known | code | optimized | yes | 3800 | 198 | 1 | 1 | 0.3 |
| code-duplicate-named | code | lasso | yes | 3668 | 137 | 1 | 1 | 0.2 |
| code-duplicate-named | code | optimized | yes | 3668 | 137 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | lasso | yes | 3534 | 79 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | optimized | yes | 3534 | 79 | 1 | 1 | 0.2 |
| code-function-lookup | code | lasso | yes | 5934 | 396 | 2 | 2 | 1.4 |
| code-function-lookup | code | optimized | yes | 3925 | 289 | 1 | 1 | 0.7 |
| code-multi-function | code | lasso | yes | 5371 | 1024 | 1 | 3 | 0.8 |
| code-multi-function | code | optimized | yes | 5265 | 1006 | 1 | 1 | 0.5 |
| code-config-key | code | lasso | yes | 3516 | 70 | 1 | 1 | 0.2 |
| code-config-key | code | optimized | yes | 3516 | 70 | 1 | 1 | 0.1 |
| code-repeated-inspections | code | lasso | yes | 5193 | 785 | 1 | 5 | 1.3 |
| code-repeated-inspections | code | optimized | yes | 4905 | 673 | 1 | 1 | 0.9 |
| code-stale-reference * | code | lasso | yes | 3885 | 225 | 1 | 1 | 0.3 |
| code-stale-reference * | code | optimized | yes | 3885 | 225 | 1 | 1 | 0.3 |
| code-modified-on-disk | code | lasso | yes | 5672 | 216 | 2 | 2 | 0.4 |
| code-modified-on-disk | code | optimized | yes | 3586 | 87 | 1 | 1 | 0.2 |
| doc-short-file | docs | lasso | yes | 3703 | 239 | 1 | 1 | 0.2 |
| doc-short-file | docs | optimized | yes | 3703 | 239 | 1 | 1 | 0.2 |
| doc-long-fact | docs | lasso | yes | 3681 | 228 | 1 | 1 | 0.2 |
| doc-long-fact | docs | optimized | yes | 3681 | 228 | 1 | 1 | 0.2 |
| doc-large-table | docs | lasso | yes | 3623 | 186 | 1 | 1 | 0.2 |
| doc-large-table | docs | optimized | yes | 3623 | 186 | 1 | 1 | 0.2 |
| doc-identifier | docs | lasso | yes | 3697 | 227 | 1 | 1 | 0.2 |
| doc-identifier | docs | optimized | yes | 3697 | 227 | 1 | 1 | 0.2 |
| doc-ambiguous-sources | docs | lasso | yes | 3771 | 287 | 1 | 1 | 0.2 |
| doc-ambiguous-sources | docs | optimized | yes | 3771 | 287 | 1 | 1 | 0.2 |
| doc-related-facts | docs | lasso | yes | 3681 | 176 | 1 | 1 | 0.2 |
| doc-related-facts | docs | optimized | yes | 3681 | 176 | 1 | 1 | 0.2 |
| doc-missing | docs | lasso | yes | 3636 | 204 | 1 | 1 | 0.3 |
| doc-missing | docs | optimized | yes | 3636 | 204 | 1 | 1 | 0.2 |
| doc-history * | docs | lasso | yes | 5736 | 281 | 2 | 2 | 0.6 |
| doc-history * | docs | optimized | yes | 5736 | 281 | 2 | 2 | 0.5 |
| doc-multi-batch | docs | lasso | yes | 5004 | 948 | 1 | 6 | 1 |
| doc-multi-batch | docs | optimized | yes | 4757 | 859 | 1 | 1 | 0.4 |

\* capability task: needs history the direct tools cannot reach, so it is left out of the savings and reported as a capability difference.

## Ablation: deterministic insertion (bind)

| Task | Arm | Correct | Est. tokens | Rounds | Calls |
|---|---|---|---|---|---|
| doc-related-facts | direct | yes | 4229 | 2 | 2 |
| doc-related-facts | optimized | yes | 3681 | 1 | 1 |
| doc-related-facts | optimized+bind | yes | 6424 | 2 | 2 |

## Routing

The routed arms send a short read of a file the request already names to direct tools and everything else to Lasso (optimized). "routed" still carries Lasso's definitions on direct tasks, as a connected server does; "routed-deferred" assumes a host that loads them only when used, and does not count the loading call, so it is a lower bound. Tasks sent to direct tools:

- code-range-known
- code-modified-on-disk
- doc-short-file

## Startup, shutdown and idle cost

- Indexing the corpus in the app (one time, not per agent call): 5750 ms.
- In-process engine open: cold 1 ms, warm 0.9 ms.
- MCP over stdio (median of 5 launches): initialize answered 62.4 ms after spawn; first tool result 68.2 ms after spawn; process exited 5.3 ms after the host closed stdin (exit codes 0); RSS 156 MB.
- REST, started on demand: first result 114 ms cold (spawn + open + call), 2 ms for a second client reusing it (same process: true); idle RSS 71 MB at 0.9% CPU; stopped 3472 ms after both leases were released (idle time 3 s).

## Cold versus warm Lasso engine (sum of local tool time over the suite)

Cold: the first pass, on engines opened for it. Warm: the same tasks again on the same engines. The routed arms run on the optimized arm's engine after it, so their local time is warm.

- lasso: cold 374 ms, warm 8 ms.
- optimized: cold 344 ms, warm 6 ms.

## Constants

Tool definitions are charged as a provider counted them (docs/agent/token-probe.json, gpt-5.4-mini): direct 276, Lasso +387 per call. The terminal-find arm is still estimated.

System prompt 1000 tokens per invocation; 15 tokens per tool call and 10 per tool result of framing; tool definitions: direct 436, Lasso 501 (added to the direct tools, never replacing them), terminal find 78. Prices: Claude Opus 5.5 list ($4/$20 per M input/output, cache reads $0.2).

