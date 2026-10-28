# Lasso agent benchmark: results

Generated 2026-10-28T00:29:03.846Z on darwin arm64, Node v24.13.0. Produced by `node scripts/agent-benchmark.mjs`; the numbers below are this run's.

**Token figures are estimates** (tokenizer-free estimator, same for every arm) of complete-task model input and output under scripted, competent policies. They are not provider-recorded usage, reasoning tokens are not modelled, and a live model may take different steps.

Arms: `lasso` and `optimized` are v3's scripted search-then-read policies (search and read tools); `routed` sends short reads of a named file to direct tools; `ask` is v4, one `lasso` call per task with the request as written, answered from what came back by one rule for every task and graded as live answers are (the known values present; a question when the files leave the choice open).

## Complete-task totals (tasks with a direct-tools equivalent)

| Arm | Correct | Est. tokens T | of which tool definitions | Evidence tokens | T, conservative estimate | Rounds J | Tool calls | Est. cost (no cache) | Est. cost (prefix cache) | Local tool time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 16/16 | 67,718 | 11,040 | 7,842 | 71,682 | 24 | 40 | $0.3279 | $0.1928 | 84 ms |
| legacy | 15/16 | 104,537 | 20,600 | 31,201 | 128,874 | 24 | 40 | $0.4741 | $0.3020 | 238 ms |
| lasso | 16/16 | 67,467 | 22,542 | 5,378 | 69,894 | 18 | 29 | $0.3217 | $0.2004 | 8 ms |
| optimized | 16/16 | 62,732 | 21,216 | 4,929 | 64,895 | 16 | 16 | $0.2979 | $0.1918 | 5 ms |
| routed | 16/16 | 62,405 | 21,216 | 4,678 | 64,445 | 16 | 16 | $0.2960 | $0.1900 | 4 ms |
| routed-deferred | 16/16 | 60,083 | 18,894 | 4,678 | 62,123 | 16 | 16 | $0.2867 | $0.1851 | 4 ms |
| ask | 16/16 | 53,373 | 13,600 | 3,703 | 54,834 | 16 | 16 | $0.2577 | $0.1673 | 207 ms |

## Aggregate savings S = 1 − ΣT_L / ΣT_0 against direct tools

Negative S means the arm used more tokens than direct tools.

| Arm | S (all) | S, conservative estimate | S (code) | S (docs) | Evidence-only saving | Per-task T_L/T_0 min / median / max | Tasks with more tokens than direct |
|---|---|---|---|---|---|---|---|
| legacy | -54.4% | -79.8% | -20.9% | -84.7% | -297.9% | 1.08 / 1.2 / 5.11 | 16 of 16 |
| lasso | 0.4% | 2.5% | -14.1% | 13.5% | 31.4% | 0.54 / 0.9 / 2.08 | 8 of 16 |
| optimized | 7.4% | 9.5% | -0.1% | 14.2% | 37.1% | 0.51 / 0.9 / 1.36 | 7 of 16 |
| routed | 7.8% | 10.1% | 0.2% | 14.7% | 40.3% | 0.51 / 0.9 / 1.36 | 7 of 16 |
| routed-deferred | 11.3% | 13.3% | 5% | 16.9% | 40.3% | 0.51 / 0.9 / 1.36 | 4 of 16 |
| ask | 21.2% | 23.5% | 12.6% | 28.9% | 52.8% | 0.4 / 0.7 / 1.15 | 7 of 16 |

## Spread over 5 runs

Folder ids are random, so ranking ties and handle strings differ between runs. The tables above and below are the last run.

| Arm | S median (min…max) | S conservative median (min…max) | Evidence-only median (min…max) | Correct per run |
|---|---|---|---|---|
| legacy | -54.4% (-54.8…-54.3) | -79.8% (-80.2…-79.7) | -297.9% (-301…-297.4) | 15/16, 15/16, 15/16, 15/16, 15/16 |
| lasso | 0.3% (0.3…0.4) | 2.4% (2.4…2.5) | 31.2% (30.8…31.4) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| optimized | 7.3% (7.3…7.4) | 9.4% (9.3…9.5) | 36.9% (36.6…37.1) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| routed | 7.8% (7.8…7.8) | 10% (10…10.1) | 40.2% (39.9…40.3) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| routed-deferred | 11.3% (11.2…11.3) | 13.3% (13.2…13.3) | 40.2% (39.9…40.3) | 16/16, 16/16, 16/16, 16/16, 16/16 |
| ask | 21.2% (21.2…21.2) | 23.5% (23.5…23.5) | 52.9% (52.8…52.9) | 16/16, 16/16, 16/16, 16/16, 16/16 |

## Per task (warm engine)

| Task | Family | Arm | Correct | Est. tokens | Evidence | Rounds | Calls | Local ms |
|---|---|---|---|---|---|---|---|---|
| code-range-known | code | direct | yes | 2988 | 178 | 1 | 1 | 0.2 |
| code-range-known | code | legacy (=direct) | yes | 3466 | 178 | 1 | 1 | 0.8 |
| code-duplicate-named | code | direct | yes | 4258 | 125 | 2 | 2 | 0.1 |
| code-duplicate-named | code | legacy (=direct) | yes | 4975 | 125 | 2 | 2 | 0 |
| code-duplicate-ambiguous | code | direct | yes | 2686 | 33 | 1 | 1 | 0 |
| code-duplicate-ambiguous | code | legacy (=direct) | yes | 3164 | 33 | 1 | 1 | 0 |
| code-function-lookup | code | direct | yes | 5287 | 975 | 2 | 2 | 9.8 |
| code-function-lookup | code | legacy | yes | 7683 | 1831 | 2 | 2 | 65.4 |
| code-multi-function | code | direct | yes | 7344 | 2193 | 2 | 4 | 12 |
| code-multi-function | code | legacy (=direct) | yes | 8061 | 2193 | 2 | 4 | 6.1 |
| code-config-key | code | direct | yes | 2700 | 26 | 1 | 1 | 5.3 |
| code-config-key | code | legacy | yes | 3698 | 578 | 1 | 1 | 29.4 |
| code-repeated-inspections | code | direct | yes | 4198 | 650 | 1 | 5 | 0.6 |
| code-repeated-inspections | code | legacy (=direct) | yes | 4676 | 650 | 1 | 5 | 0.5 |
| code-stale-reference * | code | direct | **no** | 2978 | 155 | 1 | 1 | 0.1 |
| code-stale-reference * | code | legacy (=direct) | **no** | 3456 | 155 | 1 | 1 | 0.1 |
| code-modified-on-disk | code | direct | yes | 2729 | 32 | 1 | 1 | 0 |
| code-modified-on-disk | code | legacy (=direct) | yes | 3207 | 32 | 1 | 1 | 0 |
| doc-short-file | docs | direct | yes | 2707 | 47 | 1 | 1 | 0 |
| doc-short-file | docs | legacy (=direct) | yes | 3185 | 47 | 1 | 1 | 0 |
| doc-long-fact | docs | direct | yes | 3883 | 1186 | 1 | 1 | 4.9 |
| doc-long-fact | docs | legacy | yes | 19825 | 16702 | 1 | 1 | 28.9 |
| doc-large-table | docs | direct | yes | 4190 | 65 | 2 | 3 | 8.7 |
| doc-large-table | docs | legacy (=direct) | yes | 4907 | 65 | 2 | 3 | 8.5 |
| doc-identifier | docs | direct | yes | 4192 | 61 | 2 | 2 | 5.9 |
| doc-identifier | docs | legacy | **no** | 14505 | 6496 | 2 | 2 | 59.7 |
| doc-ambiguous-sources | docs | direct | yes | 4425 | 121 | 2 | 3 | 4.7 |
| doc-ambiguous-sources | docs | legacy (=direct) | yes | 5142 | 121 | 2 | 3 | 6.3 |
| doc-related-facts | docs | direct | yes | 4229 | 65 | 2 | 2 | 0.1 |
| doc-related-facts | docs | legacy (=direct) | yes | 4946 | 65 | 2 | 2 | 0 |
| doc-missing | docs | direct | yes | 2671 | 13 | 1 | 1 | 5.5 |
| doc-missing | docs | legacy (=direct) | yes | 3149 | 13 | 1 | 1 | 5.5 |
| doc-history * | docs | direct | **no** | 2729 | 40 | 1 | 1 | 0 |
| doc-history * | docs | legacy (=direct) | **no** | 3207 | 40 | 1 | 1 | 0 |
| doc-multi-batch | docs | direct | yes | 9231 | 2072 | 2 | 10 | 26 |
| doc-multi-batch | docs | legacy (=direct) | yes | 9948 | 2072 | 2 | 10 | 26.4 |
| code-range-known | code | lasso | yes | 3800 | 198 | 1 | 1 | 0.4 |
| code-range-known | code | optimized | yes | 3800 | 198 | 1 | 1 | 0.3 |
| code-range-known | code | ask | yes | 3302 | 198 | 1 | 1 | 0.4 |
| code-duplicate-named | code | lasso | yes | 3671 | 140 | 1 | 1 | 0.2 |
| code-duplicate-named | code | optimized | yes | 3671 | 140 | 1 | 1 | 0.2 |
| code-duplicate-named | code | ask | yes | 3175 | 140 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | lasso | yes | 3534 | 79 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | optimized | yes | 3534 | 79 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | ask | yes | 3045 | 79 | 1 | 1 | 0.2 |
| code-function-lookup | code | lasso | yes | 5939 | 395 | 2 | 2 | 1.4 |
| code-function-lookup | code | optimized | yes | 3929 | 293 | 1 | 1 | 0.8 |
| code-function-lookup | code | ask | yes | 3451 | 293 | 1 | 1 | 0.8 |
| code-multi-function | code | lasso | yes | 5392 | 1045 | 1 | 3 | 0.8 |
| code-multi-function | code | optimized | yes | 5286 | 1027 | 1 | 1 | 0.5 |
| code-multi-function | code | ask | yes | 4788 | 1033 | 1 | 1 | 0.6 |
| code-config-key | code | lasso | yes | 3518 | 72 | 1 | 1 | 0.2 |
| code-config-key | code | optimized | yes | 3518 | 72 | 1 | 1 | 0.2 |
| code-config-key | code | ask | yes | 3020 | 62 | 1 | 1 | 19.2 |
| code-repeated-inspections | code | lasso | yes | 5200 | 792 | 1 | 5 | 1.5 |
| code-repeated-inspections | code | optimized | yes | 4912 | 680 | 1 | 1 | 0.8 |
| code-repeated-inspections | code | ask | yes | 4242 | 690 | 1 | 1 | 0.9 |
| code-stale-reference * | code | lasso | yes | 3888 | 228 | 1 | 1 | 0.4 |
| code-stale-reference * | code | optimized | yes | 3888 | 228 | 1 | 1 | 0.3 |
| code-stale-reference * | code | ask | yes | 3404 | 228 | 1 | 1 | 0.4 |
| code-modified-on-disk | code | lasso | yes | 5670 | 215 | 2 | 2 | 0.4 |
| code-modified-on-disk | code | optimized | yes | 3586 | 87 | 1 | 1 | 0.2 |
| code-modified-on-disk | code | ask | yes | 3096 | 87 | 1 | 1 | 0.3 |
| doc-short-file | docs | lasso | yes | 3687 | 223 | 1 | 1 | 0.3 |
| doc-short-file | docs | optimized | yes | 3687 | 223 | 1 | 1 | 0.2 |
| doc-short-file | docs | ask | yes | 3049 | 63 | 1 | 1 | 2.6 |
| doc-long-fact | docs | lasso | yes | 3681 | 228 | 1 | 1 | 0.2 |
| doc-long-fact | docs | optimized | yes | 3681 | 228 | 1 | 1 | 0.2 |
| doc-long-fact | docs | ask | yes | 3068 | 83 | 1 | 1 | 51 |
| doc-large-table | docs | lasso | yes | 3616 | 179 | 1 | 1 | 0.3 |
| doc-large-table | docs | optimized | yes | 3616 | 179 | 1 | 1 | 0.2 |
| doc-large-table | docs | ask | yes | 3005 | 52 | 1 | 1 | 0.7 |
| doc-identifier | docs | lasso | yes | 3691 | 221 | 1 | 1 | 0.2 |
| doc-identifier | docs | optimized | yes | 3691 | 221 | 1 | 1 | 0.2 |
| doc-identifier | docs | ask | yes | 3061 | 72 | 1 | 1 | 0.6 |
| doc-ambiguous-sources | docs | lasso | yes | 3764 | 280 | 1 | 1 | 0.3 |
| doc-ambiguous-sources | docs | optimized | yes | 3764 | 280 | 1 | 1 | 0.2 |
| doc-ambiguous-sources | docs | ask | yes | 3116 | 121 | 1 | 1 | 0.5 |
| doc-related-facts | docs | lasso | yes | 3682 | 177 | 1 | 1 | 0.2 |
| doc-related-facts | docs | optimized | yes | 3682 | 177 | 1 | 1 | 0.2 |
| doc-related-facts | docs | ask | yes | 3163 | 157 | 1 | 1 | 1.1 |
| doc-missing | docs | lasso | yes | 3637 | 205 | 1 | 1 | 0.2 |
| doc-missing | docs | optimized | yes | 3637 | 205 | 1 | 1 | 0.2 |
| doc-missing | docs | ask | yes | 3065 | 123 | 1 | 1 | 51.7 |
| doc-history * | docs | lasso | yes | 5705 | 268 | 2 | 2 | 0.7 |
| doc-history * | docs | optimized | yes | 5705 | 268 | 2 | 2 | 0.6 |
| doc-history * | docs | ask | yes | 3142 | 137 | 1 | 1 | 1.2 |
| doc-multi-batch | docs | lasso | yes | 4985 | 929 | 1 | 6 | 1.1 |
| doc-multi-batch | docs | optimized | yes | 4738 | 840 | 1 | 1 | 0.5 |
| doc-multi-batch | docs | ask | yes | 3727 | 450 | 1 | 1 | 76.2 |

\* capability task: needs history the direct tools cannot reach, so it is left out of the savings and reported as a capability difference.

## Ablation: deterministic insertion (bind)

| Task | Arm | Correct | Est. tokens | Rounds | Calls |
|---|---|---|---|---|---|
| doc-related-facts | direct | yes | 4229 | 2 | 2 |
| doc-related-facts | optimized | yes | 3682 | 1 | 1 |
| doc-related-facts | optimized+bind | yes | 6438 | 2 | 2 |

## Routing

The routed arms send a short read of a file the request already names to direct tools and everything else to Lasso (optimized). "routed" still carries Lasso's definitions on direct tasks, as a connected server does; "routed-deferred" assumes a host that loads them only when used, and does not count the loading call, so it is a lower bound. Tasks sent to direct tools:

- code-range-known
- code-modified-on-disk
- doc-short-file

## Startup, shutdown and idle cost

- Indexing the corpus in the app (one time, not per agent call): 5956 ms.
- In-process engine open: cold 2 ms, warm 0.8 ms.
- MCP over stdio (median of 5 launches): initialize answered 63.4 ms after spawn; first tool result 66.4 ms after spawn; process exited 2.5 ms after the host closed stdin (exit codes 0); RSS 68 MB.
- REST, started on demand: first result 114 ms cold (spawn + open + call), 3 ms for a second client reusing it (same process: true); idle RSS 71 MB at 0.6% CPU; stopped 3471 ms after both leases were released (idle time 3 s).

## Cold versus warm Lasso engine (sum of local tool time over the suite)

Cold: the first pass, on engines opened for it. Warm: the same tasks again on the same engines. The routed arms run on the optimized arm's engine after it, so their local time is warm.

- lasso: cold 425 ms, warm 9 ms.
- optimized: cold 364 ms, warm 6 ms.
- ask: cold 318 ms, warm 209 ms.

## Constants

Tool definitions are charged as a provider counted them (docs/agent/token-probe.json, gpt-5.4-mini): direct 276, Lasso search and read (v3) +387, the lasso tool (v4) +149 per call. The terminal-find arm is still estimated.

System prompt 1000 tokens per invocation; 15 tokens per tool call and 10 per tool result of framing; estimated tool definitions: direct 436, Lasso search and read 501, the lasso tool 215 (each added to the direct tools, never replacing them), terminal find 78. Prices: Claude Opus 5.5 list ($4/$20 per M input/output, cache reads $0.2).

