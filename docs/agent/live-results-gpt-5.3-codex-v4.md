# Lasso agent benchmark: live model runs

Generated 2026-10-28T00:26:03.572Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 1 run(s); spent $0.369 of a $0.52 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.3-codex

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 13/15 | 127,293 | 121,689 | 51,200 | 5,604 | 1,301 | 42 | 47 | $0.2108 | 94.2 s |
| lasso-v4 | 15/15 | 29,777 | 25,647 | 1,536 | 4,130 | 723 | 31 | 16 | $0.1003 | 68.1 s |

- **lasso-v4**: S = 1 − ΣT/ΣT_direct over 15 paired tasks = **76.6%** (code -3.6%, docs 90.8%); per-task ratio min 0.03, median 1.02, max 1.34; more tokens than direct on 8 of 15. Used Lasso on 16 of 16 tasks, also needing file tools on 1 of those (lasso ×16, Grep ×1).
- First-call input (instructions + tool definitions + request), median: direct 424, lasso-v4 569 tokens; so each Lasso version adds lasso-v4 +145 tokens per call.
- Capability tasks (not in S): code-stale-reference run 1 lasso-v4 correct; code-stale-reference run 1 direct wrong; doc-history run 1 direct wrong; doc-history run 1 lasso-v4 correct.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | code-range-known | direct | yes | 1270 | 0 | 194 | 2 | 1 | Read×1 | 4.1 | answered |
| 1 | code-range-known | lasso-v4 | yes | 1574 | 0 | 210 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | code-duplicate-named | lasso-v4 | yes | 1614 | 0 | 296 | 2 | 1 | lasso×1 | 4.2 | answered |
| 1 | code-duplicate-named | direct | **no** | 1921 | 0 | 366 | 3 | 2 | Read×1 Glob×1 | 7.9 | answered |
| 1 | code-duplicate-ambiguous | direct | yes | 1069 | 0 | 155 | 2 | 1 | Glob×1 | 3.9 | answered |
| 1 | code-duplicate-ambiguous | lasso-v4 | yes | 1413 | 0 | 155 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | code-function-lookup | lasso-v4 | yes | 1702 | 0 | 290 | 2 | 1 | lasso×1 | 4.8 | answered |
| 1 | code-function-lookup | direct | yes | 3070 | 0 | 379 | 3 | 2 | Grep×1 Read×1 | 6.3 | answered |
| 1 | code-multi-function | direct | yes | 6889 | 0 | 1234 | 3 | 6 | Grep×3 Read×3 | 12.9 | answered |
| 1 | code-multi-function | lasso-v4 | yes | 7859 | 1536 | 1100 | 3 | 2 | lasso×1 Grep×1 | 12.4 | answered |
| 1 | code-config-key | lasso-v4 | yes | 1383 | 0 | 141 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | code-config-key | direct | yes | 1042 | 0 | 127 | 2 | 1 | Grep×1 | 3.6 | answered |
| 1 | code-repeated-inspections | direct | yes | 2878 | 0 | 927 | 2 | 5 | Read×5 | 9.4 | answered |
| 1 | code-repeated-inspections | lasso-v4 | yes | 2924 | 0 | 848 | 2 | 1 | lasso×1 | 8.8 | answered |
| 1 | code-stale-reference * | lasso-v4 | yes | 1685 | 0 | 250 | 2 | 1 | lasso×1 | 4.5 | answered |
| 1 | code-stale-reference * | direct | **no** | 2852 | 0 | 468 | 3 | 2 | Read×1 Grep×1 | 7.9 | answered |
| 1 | code-modified-on-disk | direct | yes | 1043 | 0 | 103 | 2 | 1 | Read×1 | 3.0 | answered |
| 1 | code-modified-on-disk | lasso-v4 | yes | 1398 | 0 | 119 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | doc-short-file | lasso-v4 | yes | 1349 | 0 | 94 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | doc-short-file | direct | yes | 1014 | 0 | 67 | 2 | 1 | Read×1 | 2.4 | answered |
| 1 | doc-long-fact | direct | **no** | 39610 | 24576 | 523 | 5 | 7 | Glob×4 Grep×2 Read×1 | 10.8 | answered |
| 1 | doc-long-fact | lasso-v4 | yes | 1384 | 0 | 113 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | doc-large-table | lasso-v4 | yes | 1327 | 0 | 90 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | doc-large-table | direct | yes | 2090 | 0 | 213 | 3 | 3 | Grep×1 Read×2 | 4.6 | answered |
| 1 | doc-identifier | direct | yes | 1116 | 0 | 162 | 2 | 1 | Grep×1 | 3.4 | answered |
| 1 | doc-identifier | lasso-v4 | yes | 1381 | 0 | 119 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | doc-ambiguous-sources | lasso-v4 | yes | 1459 | 0 | 165 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | doc-ambiguous-sources | direct | yes | 14647 | 0 | 414 | 3 | 5 | Glob×1 Grep×1 Read×3 | 6.9 | answered |
| 1 | doc-related-facts | direct | yes | 3380 | 0 | 228 | 3 | 3 | Glob×1 Grep×1 Read×1 | 5.1 | answered |
| 1 | doc-related-facts | lasso-v4 | yes | 1497 | 0 | 153 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | doc-missing | lasso-v4 | yes | 1513 | 0 | 237 | 2 | 1 | lasso×1 | 5.0 | answered |
| 1 | doc-missing | direct | yes | 46254 | 26624 | 512 | 5 | 8 | Grep×2 Glob×1 Read×5 | 10.0 | answered |
| 1 | doc-history * | direct | **no** | 14825 | 8704 | 694 | 5 | 8 | Grep×5 Glob×1 Read×2 | 12.4 | answered |
| 1 | doc-history * | lasso-v4 | yes | 1515 | 0 | 173 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | doc-multi-batch | lasso-v4 | yes | 1998 | 0 | 299 | 2 | 1 | lasso×1 | 5.1 | answered |

\* capability task: needs history direct tools cannot reach.

