# Lasso agent benchmark: live model runs

Generated 2026-10-28T00:14:18.916Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 2 run(s); spent $0.253 of a $0.4 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.4-mini

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 29/32 | 219,302 | 205,794 | 104,064 | 13,508 | 2,148 | 98 | 135 | $0.1449 | 145.6 s |
| lasso-v4 | 32/32 | 67,439 | 58,967 | 3,840 | 8,472 | 1,646 | 69 | 42 | $0.0798 | 100.9 s |

- **lasso-v4**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **69.2%** (code 14.5%, docs 80.2%); per-task ratio min 0.04, median 0.82, max 2.53; more tokens than direct on 14 of 32. Used Lasso on 32 of 32 tasks, also needing file tools on 3 of those (lasso ×32, Grep ×6, Read ×4).
- First-call input (instructions + tool definitions + request), median: direct 424, lasso-v4 569 tokens; so each Lasso version adds lasso-v4 +145 tokens per call.
- Capability tasks (not in S): code-stale-reference run 1 lasso-v4 correct; code-stale-reference run 1 direct wrong; doc-history run 1 direct wrong; doc-history run 1 lasso-v4 correct; code-stale-reference run 2 lasso-v4 correct; code-stale-reference run 2 direct wrong; doc-history run 2 direct wrong; doc-history run 2 lasso-v4 correct.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | code-range-known | direct | yes | 1278 | 0 | 211 | 2 | 1 | Read×1 | 3.1 | answered |
| 1 | code-range-known | lasso-v4 | yes | 1567 | 0 | 211 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | code-duplicate-named | lasso-v4 | yes | 1485 | 0 | 172 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | code-duplicate-named | direct | **no** | 1738 | 0 | 197 | 3 | 2 | Glob×1 Read×1 | 3.8 | answered |
| 1 | code-duplicate-ambiguous | direct | yes | 1053 | 0 | 140 | 2 | 1 | Glob×1 | 2.5 | answered |
| 1 | code-duplicate-ambiguous | lasso-v4 | yes | 1444 | 0 | 169 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | code-function-lookup | lasso-v4 | yes | 1664 | 0 | 251 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | code-function-lookup | direct | yes | 3392 | 0 | 417 | 3 | 3 | Grep×2 Read×1 | 4.3 | answered |
| 1 | code-multi-function | direct | yes | 4932 | 0 | 1148 | 3 | 6 | Grep×3 Read×3 | 7.3 | answered |
| 1 | code-multi-function | lasso-v4 | yes | 3131 | 0 | 939 | 2 | 1 | lasso×1 | 5.5 | answered |
| 1 | code-config-key | lasso-v4 | yes | 1349 | 0 | 113 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | code-config-key | direct | yes | 1129 | 0 | 151 | 2 | 2 | Grep×2 | 2.2 | answered |
| 1 | code-repeated-inspections | direct | yes | 3443 | 0 | 873 | 3 | 5 | Read×5 | 6.3 | answered |
| 1 | code-repeated-inspections | lasso-v4 | yes | 2833 | 0 | 780 | 2 | 1 | lasso×1 | 4.8 | answered |
| 1 | code-stale-reference * | lasso-v4 | yes | 1759 | 0 | 330 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | code-stale-reference * | direct | **no** | 2563 | 0 | 502 | 3 | 3 | Glob×1 Grep×1 Read×1 | 5.2 | answered |
| 1 | code-modified-on-disk | direct | yes | 1019 | 0 | 79 | 2 | 1 | Read×1 | 2.0 | answered |
| 1 | code-modified-on-disk | lasso-v4 | yes | 1384 | 0 | 108 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | doc-short-file | lasso-v4 | yes | 1336 | 0 | 81 | 2 | 1 | lasso×1 | 2.2 | answered |
| 1 | doc-short-file | direct | yes | 1030 | 0 | 74 | 2 | 1 | Read×1 | 2.0 | answered |
| 1 | doc-long-fact | direct | yes | 8105 | 2432 | 433 | 4 | 6 | Grep×6 | 6.0 | answered |
| 1 | doc-long-fact | lasso-v4 | yes | 1387 | 0 | 112 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | doc-large-table | lasso-v4 | yes | 1337 | 0 | 97 | 2 | 1 | lasso×1 | 2.3 | answered |
| 1 | doc-large-table | direct | yes | 1096 | 0 | 122 | 2 | 2 | Grep×1 Glob×1 | 2.3 | answered |
| 1 | doc-identifier | direct | yes | 1178 | 0 | 163 | 2 | 2 | Grep×2 | 2.5 | answered |
| 1 | doc-identifier | lasso-v4 | yes | 1337 | 0 | 88 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | doc-ambiguous-sources | lasso-v4 | yes | 1580 | 0 | 177 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | doc-ambiguous-sources | direct | yes | 6725 | 2432 | 410 | 3 | 5 | Grep×3 Read×2 | 4.3 | answered |
| 1 | doc-related-facts | direct | yes | 3611 | 1152 | 273 | 3 | 4 | Grep×3 Read×1 | 3.7 | answered |
| 1 | doc-related-facts | lasso-v4 | yes | 1491 | 0 | 140 | 2 | 1 | lasso×1 | 2.3 | answered |
| 1 | doc-missing | lasso-v4 | yes | 6627 | 2304 | 352 | 4 | 5 | lasso×1 Grep×4 | 5.3 | answered |
| 1 | doc-missing | direct | yes | 30007 | 19200 | 877 | 7 | 14 | Grep×10 Glob×1 Read×3 | 11.1 | answered |
| 1 | doc-history * | direct | **no** | 5195 | 1536 | 467 | 3 | 5 | Grep×4 Glob×1 | 5.4 | answered |
| 1 | doc-history * | lasso-v4 | yes | 1775 | 0 | 162 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | doc-multi-batch | lasso-v4 | yes | 1974 | 0 | 273 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | doc-multi-batch | direct | yes | 47218 | 35968 | 1493 | 9 | 16 | Grep×16 | 15.2 | answered |
| 2 | code-range-known | direct | yes | 1266 | 0 | 198 | 2 | 1 | Read×1 | 2.9 | answered |
| 2 | code-range-known | lasso-v4 | yes | 3207 | 0 | 537 | 3 | 2 | lasso×1 Read×1 | 6.5 | answered |
| 2 | code-duplicate-named | lasso-v4 | yes | 1473 | 0 | 159 | 2 | 1 | lasso×1 | 3.0 | answered |
| 2 | code-duplicate-named | direct | **no** | 1807 | 0 | 244 | 3 | 2 | Glob×1 Read×1 | 3.8 | answered |
| 2 | code-duplicate-ambiguous | direct | yes | 1050 | 0 | 138 | 2 | 1 | Glob×1 | 2.6 | answered |
| 2 | code-duplicate-ambiguous | lasso-v4 | yes | 1406 | 0 | 140 | 2 | 1 | lasso×1 | 2.4 | answered |
| 2 | code-function-lookup | lasso-v4 | yes | 1653 | 0 | 245 | 2 | 1 | lasso×1 | 2.7 | answered |
| 2 | code-function-lookup | direct | yes | 3170 | 0 | 379 | 3 | 3 | Grep×2 Read×1 | 4.2 | answered |
| 2 | code-multi-function | direct | yes | 5782 | 0 | 1152 | 3 | 6 | Grep×3 Read×3 | 6.7 | answered |
| 2 | code-multi-function | lasso-v4 | yes | 3146 | 0 | 954 | 2 | 1 | lasso×1 | 5.3 | answered |
| 2 | code-config-key | lasso-v4 | yes | 1343 | 0 | 105 | 2 | 1 | lasso×1 | 2.5 | answered |
| 2 | code-config-key | direct | yes | 1062 | 0 | 138 | 2 | 1 | Grep×1 | 2.0 | answered |
| 2 | code-repeated-inspections | direct | yes | 3427 | 0 | 855 | 3 | 5 | Read×5 | 5.9 | answered |
| 2 | code-repeated-inspections | lasso-v4 | yes | 2794 | 0 | 748 | 2 | 1 | lasso×1 | 4.4 | answered |
| 2 | code-stale-reference * | lasso-v4 | yes | 1754 | 0 | 325 | 2 | 1 | lasso×1 | 3.8 | answered |
| 2 | code-stale-reference * | direct | **no** | 2572 | 0 | 537 | 3 | 3 | Glob×1 Grep×1 Read×1 | 5.8 | answered |
| 2 | code-modified-on-disk | direct | yes | 1027 | 0 | 82 | 2 | 1 | Read×1 | 2.3 | answered |
| 2 | code-modified-on-disk | lasso-v4 | yes | 1394 | 0 | 112 | 2 | 1 | lasso×1 | 2.1 | answered |
| 2 | doc-short-file | lasso-v4 | yes | 1340 | 0 | 87 | 2 | 1 | lasso×1 | 2.1 | answered |
| 2 | doc-short-file | direct | yes | 1028 | 0 | 72 | 2 | 1 | Read×1 | 2.0 | answered |
| 2 | doc-long-fact | direct | yes | 6109 | 1152 | 394 | 3 | 6 | Grep×5 Read×1 | 4.5 | answered |
| 2 | doc-long-fact | lasso-v4 | yes | 1521 | 0 | 135 | 2 | 1 | lasso×1 | 2.6 | answered |
| 2 | doc-large-table | lasso-v4 | yes | 1387 | 0 | 126 | 2 | 1 | lasso×1 | 2.0 | answered |
| 2 | doc-large-table | direct | yes | 1134 | 0 | 140 | 2 | 2 | Grep×2 | 2.5 | answered |
| 2 | doc-identifier | direct | yes | 1338 | 0 | 216 | 2 | 4 | Grep×4 | 2.9 | answered |
| 2 | doc-identifier | lasso-v4 | yes | 1366 | 0 | 102 | 2 | 1 | lasso×1 | 2.1 | answered |
| 2 | doc-ambiguous-sources | lasso-v4 | yes | 1446 | 0 | 145 | 2 | 1 | lasso×1 | 2.7 | answered |
| 2 | doc-ambiguous-sources | direct | yes | 8227 | 0 | 400 | 3 | 5 | Grep×2 Read×3 | 3.9 | answered |
| 2 | doc-related-facts | direct | yes | 2407 | 0 | 199 | 2 | 2 | Grep×2 | 2.7 | answered |
| 2 | doc-related-facts | lasso-v4 | yes | 1455 | 0 | 115 | 2 | 1 | lasso×1 | 2.3 | answered |
| 2 | doc-missing | lasso-v4 | yes | 8638 | 1536 | 459 | 4 | 6 | lasso×1 Grep×2 Read×3 | 5.6 | answered |
| 2 | doc-missing | direct | yes | 13730 | 8064 | 652 | 5 | 11 | Grep×9 Read×2 | 7.1 | answered |
| 2 | doc-history * | direct | **no** | 10274 | 4992 | 625 | 4 | 6 | Grep×5 Glob×1 | 6.4 | answered |
| 2 | doc-history * | lasso-v4 | yes | 1637 | 0 | 189 | 2 | 1 | lasso×1 | 2.6 | answered |
| 2 | doc-multi-batch | lasso-v4 | yes | 1944 | 0 | 240 | 2 | 1 | lasso×1 | 3.1 | answered |
| 2 | doc-multi-batch | direct | **no** | 49784 | 33664 | 1188 | 7 | 13 | Grep×11 Read×2 | 11.2 | answered |

\* capability task: needs history direct tools cannot reach.

