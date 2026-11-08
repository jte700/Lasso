# Lasso agent benchmark: results

Generated 2026-10-31T06:39:22.428Z on darwin arm64, Node v24.13.0. Produced by `node scripts/agent-benchmark.mjs`; the numbers below are this run's.

**Token figures are estimates** (tokenizer-free estimator, same for every arm) of complete-task model input and output under scripted, competent policies. They are not provider-recorded usage, reasoning tokens are not modelled, and a live model may take different steps.

Arms: `lasso` and `optimized` are v3's scripted search-then-read policies (search and read tools); `routed` sends short reads of a named file to direct tools; `ask` is v4, one `lasso` call per task with the request as written, answered from what came back by one rule for every task and graded as live answers are (the known values present; a question when the files leave the choice open).

## Complete-task totals (tasks with a direct-tools equivalent)

| Arm | Correct | Est. tokens T | of which tool definitions | Evidence tokens | T, conservative estimate | Rounds J | Tool calls | Est. cost (no cache) | Est. cost (prefix cache) | Local tool time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 16/16 | 67,718 | 11,040 | 7,842 | 71,682 | 24 | 40 | $0.3279 | $0.1928 | 76 ms |
| legacy | 15/16 | 104,675 | 20,600 | 31,329 | 129,023 | 24 | 40 | $0.4746 | $0.3025 | 218 ms |
| lasso | 16/16 | 67,518 | 22,542 | 5,421 | 69,932 | 18 | 29 | $0.3219 | $0.2006 | 8 ms |
| optimized | 16/16 | 62,771 | 21,216 | 4,968 | 64,925 | 16 | 16 | $0.2981 | $0.1919 | 5 ms |
| routed | 16/16 | 62,438 | 21,216 | 4,711 | 64,471 | 16 | 16 | $0.2961 | $0.1901 | 4 ms |
| routed-deferred | 16/16 | 60,116 | 18,894 | 4,711 | 62,149 | 16 | 16 | $0.2868 | $0.1853 | 4 ms |
| ask | 16/16 | 54,645 | 14,368 | 4,068 | 56,259 | 16 | 16 | $0.2650 | $0.1732 | 209 ms |

## Aggregate savings S = 1 − ΣT_L / ΣT_0 against direct tools

Negative S means the arm used more tokens than direct tools.

| Arm | S (all) | S, conservative estimate | S (code) | S (docs) | Evidence-only saving | Per-task T_L/T_0 min / median / max | Tasks with more tokens than direct |
|---|---|---|---|---|---|---|---|
| legacy | -54.6% | -80% | -20.9% | -85.1% | -299.5% | 1.08 / 1.2 / 5.13 | 16 of 16 |
| lasso | 0.3% | 2.4% | -14.1% | 13.4% | 30.9% | 0.54 / 0.9 / 2.08 | 8 of 16 |
| optimized | 7.3% | 9.4% | -0.1% | 14% | 36.6% | 0.51 / 0.9 / 1.37 | 7 of 16 |
| routed | 7.8% | 10.1% | 0.2% | 14.6% | 39.9% | 0.51 / 0.9 / 1.37 | 7 of 16 |
| routed-deferred | 11.2% | 13.3% | 5.1% | 16.8% | 39.9% | 0.51 / 0.9 / 1.37 | 4 of 16 |
| ask | 19.3% | 21.5% | 11.5% | 26.4% | 48.1% | 0.44 / 0.8 / 1.18 | 7 of 16 |

## Spread over 3 runs

Folder ids are random, so ranking ties and handle strings differ between runs. The tables above and below are the last run.

| Arm | S median (min…max) | S conservative median (min…max) | Evidence-only median (min…max) | Correct per run |
|---|---|---|---|---|
| legacy | -54.6% (-54.8…-54.3) | -80% (-80.2…-79.7) | -299.5% (-301.5…-297.6) | 15/16, 15/16, 15/16 |
| lasso | 0.3% (0.3…0.4) | 2.4% (2.4…2.4) | 30.9% (30.7…31.4) | 16/16, 16/16, 16/16 |
| optimized | 7.3% (7.3…7.4) | 9.4% (9.3…9.4) | 36.6% (36.5…37.1) | 16/16, 16/16, 16/16 |
| routed | 7.8% (7.8…7.8) | 10% (10…10.1) | 39.9% (39.8…40.3) | 16/16, 16/16, 16/16 |
| routed-deferred | 11.2% (11.2…11.3) | 13.3% (13.2…13.3) | 39.9% (39.8…40.3) | 16/16, 16/16, 16/16 |
| ask | 19.3% (19.3…19.3) | 21.5% (21.5…21.5) | 48.2% (48.1…48.4) | 16/16, 16/16, 16/16 |

## Per task (warm engine)

| Task | Family | Arm | Correct | Est. tokens | Evidence | Rounds | Calls | Local ms |
|---|---|---|---|---|---|---|---|---|
| code-range-known | code | direct | yes | 2988 | 178 | 1 | 1 | 0.1 |
| code-range-known | code | legacy (=direct) | yes | 3466 | 178 | 1 | 1 | 0.1 |
| code-duplicate-named | code | direct | yes | 4258 | 125 | 2 | 2 | 0.1 |
| code-duplicate-named | code | legacy (=direct) | yes | 4975 | 125 | 2 | 2 | 0 |
| code-duplicate-ambiguous | code | direct | yes | 2686 | 33 | 1 | 1 | 0 |
| code-duplicate-ambiguous | code | legacy (=direct) | yes | 3164 | 33 | 1 | 1 | 0 |
| code-function-lookup | code | direct | yes | 5287 | 975 | 2 | 2 | 8.7 |
| code-function-lookup | code | legacy | yes | 7673 | 1826 | 2 | 2 | 57 |
| code-multi-function | code | direct | yes | 7344 | 2193 | 2 | 4 | 10.1 |
| code-multi-function | code | legacy (=direct) | yes | 8061 | 2193 | 2 | 4 | 5.7 |
| code-config-key | code | direct | yes | 2700 | 26 | 1 | 1 | 5 |
| code-config-key | code | legacy | yes | 3701 | 581 | 1 | 1 | 23.2 |
| code-repeated-inspections | code | direct | yes | 4198 | 650 | 1 | 5 | 0.4 |
| code-repeated-inspections | code | legacy (=direct) | yes | 4676 | 650 | 1 | 5 | 0.3 |
| code-stale-reference * | code | direct | **no** | 2978 | 155 | 1 | 1 | 0.1 |
| code-stale-reference * | code | legacy (=direct) | **no** | 3456 | 155 | 1 | 1 | 0.1 |
| code-modified-on-disk | code | direct | yes | 2729 | 32 | 1 | 1 | 0 |
| code-modified-on-disk | code | legacy (=direct) | yes | 3207 | 32 | 1 | 1 | 0 |
| doc-short-file | docs | direct | yes | 2707 | 47 | 1 | 1 | 0 |
| doc-short-file | docs | legacy (=direct) | yes | 3185 | 47 | 1 | 1 | 0 |
| doc-long-fact | docs | direct | yes | 3883 | 1186 | 1 | 1 | 6.1 |
| doc-long-fact | docs | legacy | yes | 19925 | 16802 | 1 | 1 | 30 |
| doc-large-table | docs | direct | yes | 4190 | 65 | 2 | 3 | 7 |
| doc-large-table | docs | legacy (=direct) | yes | 4907 | 65 | 2 | 3 | 6.9 |
| doc-identifier | docs | direct | yes | 4192 | 61 | 2 | 2 | 6 |
| doc-identifier | docs | legacy | **no** | 14550 | 6526 | 2 | 2 | 58.7 |
| doc-ambiguous-sources | docs | direct | yes | 4425 | 121 | 2 | 3 | 4.5 |
| doc-ambiguous-sources | docs | legacy (=direct) | yes | 5142 | 121 | 2 | 3 | 4.4 |
| doc-related-facts | docs | direct | yes | 4229 | 65 | 2 | 2 | 0.1 |
| doc-related-facts | docs | legacy (=direct) | yes | 4946 | 65 | 2 | 2 | 0 |
| doc-missing | docs | direct | yes | 2671 | 13 | 1 | 1 | 5.6 |
| doc-missing | docs | legacy (=direct) | yes | 3149 | 13 | 1 | 1 | 7.4 |
| doc-history * | docs | direct | **no** | 2729 | 40 | 1 | 1 | 0 |
| doc-history * | docs | legacy (=direct) | **no** | 3207 | 40 | 1 | 1 | 0 |
| doc-multi-batch | docs | direct | yes | 9231 | 2072 | 2 | 10 | 22.6 |
| doc-multi-batch | docs | legacy (=direct) | yes | 9948 | 2072 | 2 | 10 | 24.3 |
| code-range-known | code | lasso | yes | 3800 | 198 | 1 | 1 | 0.5 |
| code-range-known | code | optimized | yes | 3800 | 198 | 1 | 1 | 0.3 |
| code-range-known | code | ask | yes | 3350 | 198 | 1 | 1 | 0.4 |
| code-duplicate-named | code | lasso | yes | 3670 | 139 | 1 | 1 | 0.2 |
| code-duplicate-named | code | optimized | yes | 3670 | 139 | 1 | 1 | 0.2 |
| code-duplicate-named | code | ask | yes | 3222 | 139 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | lasso | yes | 3534 | 79 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | optimized | yes | 3534 | 79 | 1 | 1 | 0.2 |
| code-duplicate-ambiguous | code | ask | yes | 3093 | 79 | 1 | 1 | 0.2 |
| code-function-lookup | code | lasso | yes | 5948 | 398 | 2 | 2 | 1.4 |
| code-function-lookup | code | optimized | yes | 3930 | 294 | 1 | 1 | 0.8 |
| code-function-lookup | code | ask | yes | 3500 | 294 | 1 | 1 | 0.8 |
| code-multi-function | code | lasso | yes | 5393 | 1046 | 1 | 3 | 0.8 |
| code-multi-function | code | optimized | yes | 5287 | 1028 | 1 | 1 | 0.5 |
| code-multi-function | code | ask | yes | 4837 | 1034 | 1 | 1 | 0.6 |
| code-config-key | code | lasso | yes | 3518 | 72 | 1 | 1 | 0.2 |
| code-config-key | code | optimized | yes | 3518 | 72 | 1 | 1 | 0.2 |
| code-config-key | code | ask | yes | 3067 | 61 | 1 | 1 | 20.4 |
| code-repeated-inspections | code | lasso | yes | 5196 | 788 | 1 | 5 | 1.4 |
| code-repeated-inspections | code | optimized | yes | 4908 | 676 | 1 | 1 | 0.8 |
| code-repeated-inspections | code | ask | yes | 4286 | 686 | 1 | 1 | 0.9 |
| code-stale-reference * | code | lasso | yes | 3887 | 227 | 1 | 1 | 0.3 |
| code-stale-reference * | code | optimized | yes | 3887 | 227 | 1 | 1 | 0.3 |
| code-stale-reference * | code | ask | yes | 3451 | 227 | 1 | 1 | 0.4 |
| code-modified-on-disk | code | lasso | yes | 5674 | 217 | 2 | 2 | 0.4 |
| code-modified-on-disk | code | optimized | yes | 3586 | 87 | 1 | 1 | 0.2 |
| code-modified-on-disk | code | ask | yes | 3144 | 87 | 1 | 1 | 0.2 |
| doc-short-file | docs | lasso | yes | 3693 | 229 | 1 | 1 | 0.2 |
| doc-short-file | docs | optimized | yes | 3693 | 229 | 1 | 1 | 0.2 |
| doc-short-file | docs | ask | yes | 3115 | 81 | 1 | 1 | 6.3 |
| doc-long-fact | docs | lasso | yes | 3678 | 225 | 1 | 1 | 0.2 |
| doc-long-fact | docs | optimized | yes | 3678 | 225 | 1 | 1 | 0.2 |
| doc-long-fact | docs | ask | yes | 3278 | 197 | 1 | 1 | 67.5 |
| doc-large-table | docs | lasso | yes | 3624 | 187 | 1 | 1 | 0.3 |
| doc-large-table | docs | optimized | yes | 3624 | 187 | 1 | 1 | 0.2 |
| doc-large-table | docs | ask | yes | 3055 | 54 | 1 | 1 | 0.8 |
| doc-identifier | docs | lasso | yes | 3696 | 226 | 1 | 1 | 0.3 |
| doc-identifier | docs | optimized | yes | 3696 | 226 | 1 | 1 | 0.2 |
| doc-identifier | docs | ask | yes | 3111 | 74 | 1 | 1 | 0.7 |
| doc-ambiguous-sources | docs | lasso | yes | 3770 | 286 | 1 | 1 | 0.2 |
| doc-ambiguous-sources | docs | optimized | yes | 3770 | 286 | 1 | 1 | 0.2 |
| doc-ambiguous-sources | docs | ask | yes | 3163 | 120 | 1 | 1 | 0.6 |
| doc-related-facts | docs | lasso | yes | 3685 | 180 | 1 | 1 | 0.2 |
| doc-related-facts | docs | optimized | yes | 3685 | 180 | 1 | 1 | 0.2 |
| doc-related-facts | docs | ask | yes | 3208 | 154 | 1 | 1 | 1.1 |
| doc-missing | docs | lasso | yes | 3646 | 214 | 1 | 1 | 0.2 |
| doc-missing | docs | optimized | yes | 3646 | 214 | 1 | 1 | 0.2 |
| doc-missing | docs | ask | yes | 3154 | 164 | 1 | 1 | 46.1 |
| doc-history * | docs | lasso | yes | 5709 | 270 | 2 | 2 | 0.7 |
| doc-history * | docs | optimized | yes | 5709 | 270 | 2 | 2 | 0.5 |
| doc-history * | docs | ask | yes | 3190 | 137 | 1 | 1 | 1.2 |
| doc-multi-batch | docs | lasso | yes | 4993 | 937 | 1 | 6 | 1.2 |
| doc-multi-batch | docs | optimized | yes | 4746 | 848 | 1 | 1 | 0.5 |
| doc-multi-batch | docs | ask | yes | 4062 | 646 | 1 | 1 | 62.6 |

\* capability task: needs history the direct tools cannot reach, so it is left out of the savings and reported as a capability difference.

## Ablation: deterministic insertion (bind)

| Task | Arm | Correct | Est. tokens | Rounds | Calls |
|---|---|---|---|---|---|
| doc-related-facts | direct | yes | 4229 | 2 | 2 |
| doc-related-facts | optimized | yes | 3685 | 1 | 1 |
| doc-related-facts | optimized+bind | yes | 6435 | 2 | 2 |

## Routing

The routed arms send a short read of a file the request already names to direct tools and everything else to Lasso (optimized). "routed" still carries Lasso's definitions on direct tasks, as a connected server does; "routed-deferred" assumes a host that loads them only when used, and does not count the loading call, so it is a lower bound. Tasks sent to direct tools:

- code-range-known
- code-modified-on-disk
- doc-short-file

## Startup, shutdown and idle cost

- Indexing the corpus in the app (one time, not per agent call): 5823 ms.
- In-process engine open: cold 1.2 ms, warm 0.8 ms.
- MCP over stdio (median of 5 launches): initialize answered 65.7 ms after spawn; first tool result 68.6 ms after spawn; process exited 2.5 ms after the host closed stdin (exit codes 0); RSS 69 MB.
- REST, started on demand: first result 112 ms cold (spawn + open + call), 2 ms for a second client reusing it (same process: true); idle RSS 72 MB at 0.6% CPU; stopped 3550 ms after both leases were released (idle time 3 s).

## Cold versus warm Lasso engine (sum of local tool time over the suite)

Cold: the first pass, on engines opened for it. Warm: the same tasks again on the same engines. The routed arms run on the optimized arm's engine after it, so their local time is warm.

- lasso: cold 403 ms, warm 9 ms.
- optimized: cold 362 ms, warm 6 ms.
- ask: cold 388 ms, warm 211 ms.

## Constants

Tool definitions are charged as a provider counted them (docs/agent/token-probe.json, gpt-5.4-mini): direct 276, Lasso search and read (v3) +387, the lasso tool (current) +173 per call. The terminal-find arm is still estimated.

System prompt 1000 tokens per invocation; 15 tokens per tool call and 10 per tool result of framing; estimated tool definitions: direct 436, Lasso search and read 501, the lasso tool 260 (each added to the direct tools, never replacing them), terminal find 78. Prices: Claude Opus 5.5 list ($4/$20 per M input/output, cache reads $0.2).

