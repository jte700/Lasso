# Lasso agent benchmark: live model runs

Generated 2026-10-27T22:37:32.490Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 2 run(s); spent $0.335 of a $0.45 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.4-mini

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 28/32 | 166,918 | 155,079 | 61,824 | 11,839 | 1,514 | 94 | 115 | $0.1279 | 140.9 s |
| lasso-v2 | 28/32 | 290,524 | 275,310 | 151,296 | 15,214 | 2,779 | 120 | 134 | $0.1728 | 180.2 s |

- **lasso-v2**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **-74.1%** (code -63.5%, docs -77.3%); per-task ratio min 0.56, median 1.88, max 7.01; more tokens than direct on 30 of 32. Used Lasso on 22 of 32 tasks, also needing file tools on 17 of those (Read ×28, Glob ×7, Grep ×29, lasso_search ×44, lasso_read ×22, lasso_cite ×4).
- First-call input (instructions + tool definitions + request), median: direct 424, lasso-v2 871 tokens; so each Lasso version adds lasso-v2 +447 tokens per call.
- Capability tasks (not in S): code-stale-reference run 1 lasso-v2 correct; code-stale-reference run 1 direct wrong; doc-history run 1 direct wrong; doc-history run 1 lasso-v2 correct; code-stale-reference run 2 lasso-v2 correct; code-stale-reference run 2 direct wrong; doc-history run 2 direct wrong; doc-history run 2 lasso-v2 wrong.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | code-range-known | direct | yes | 1261 | 0 | 194 | 2 | 1 | Read×1 | 3.9 | answered |
| 1 | code-range-known | lasso-v2 | yes | 2134 | 0 | 173 | 2 | 1 | Read×1 | 2.5 | answered |
| 1 | code-duplicate-named | lasso-v2 | **no** | 4246 | 0 | 264 | 4 | 3 | Read×2 Glob×1 | 4.8 | answered |
| 1 | code-duplicate-named | direct | **no** | 1748 | 0 | 215 | 3 | 2 | Glob×1 Read×1 | 3.1 | answered |
| 1 | code-duplicate-ambiguous | direct | yes | 1051 | 0 | 139 | 2 | 1 | Glob×1 | 3.2 | answered |
| 1 | code-duplicate-ambiguous | lasso-v2 | yes | 1959 | 0 | 144 | 2 | 1 | Glob×1 | 2.5 | answered |
| 1 | code-function-lookup | lasso-v2 | yes | 5325 | 2176 | 439 | 4 | 4 | Grep×1 lasso_search×1 lasso_read×2 | 6.6 | answered |
| 1 | code-function-lookup | direct | yes | 2648 | 0 | 373 | 3 | 3 | Grep×2 Read×1 | 3.9 | answered |
| 1 | code-multi-function | direct | yes | 5764 | 0 | 1133 | 3 | 6 | Grep×3 Read×3 | 7.5 | answered |
| 1 | code-multi-function | lasso-v2 | **no** | 11240 | 6400 | 940 | 6 | 7 | lasso_search×2 Grep×2 lasso_read×1 Read×2 | 9.0 | answered |
| 1 | code-config-key | lasso-v2 | yes | 2100 | 0 | 161 | 2 | 2 | Grep×1 lasso_search×1 | 2.3 | answered |
| 1 | code-config-key | direct | yes | 1146 | 0 | 165 | 2 | 2 | Grep×2 | 2.6 | answered |
| 1 | code-repeated-inspections | direct | **no** | 3516 | 0 | 946 | 3 | 5 | Read×5 | 7.0 | answered |
| 1 | code-repeated-inspections | lasso-v2 | yes | 3748 | 0 | 913 | 2 | 5 | Read×5 | 5.4 | answered |
| 1 | code-stale-reference * | lasso-v2 | yes | 2339 | 0 | 298 | 2 | 1 | lasso_read×1 | 3.3 | answered |
| 1 | code-stale-reference * | direct | **no** | 2300 | 0 | 361 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.0 | answered |
| 1 | code-modified-on-disk | direct | yes | 1017 | 0 | 77 | 2 | 1 | Read×1 | 2.1 | answered |
| 1 | code-modified-on-disk | lasso-v2 | yes | 1982 | 0 | 95 | 2 | 1 | lasso_read×1 | 2.3 | answered |
| 1 | doc-short-file | lasso-v2 | yes | 3261 | 0 | 187 | 3 | 2 | lasso_search×1 Read×1 | 3.4 | answered |
| 1 | doc-short-file | direct | yes | 1031 | 0 | 75 | 2 | 1 | Read×1 | 4.0 | answered |
| 1 | doc-long-fact | direct | yes | 4329 | 1536 | 294 | 3 | 4 | Grep×4 | 4.0 | answered |
| 1 | doc-long-fact | lasso-v2 | yes | 5933 | 2176 | 270 | 3 | 3 | lasso_search×1 Grep×1 lasso_read×1 | 3.9 | answered |
| 1 | doc-large-table | lasso-v2 | yes | 7980 | 3072 | 346 | 5 | 5 | lasso_search×2 Grep×2 Read×1 | 5.8 | answered |
| 1 | doc-large-table | direct | yes | 1138 | 0 | 144 | 2 | 2 | Grep×2 | 2.4 | answered |
| 1 | doc-identifier | direct | yes | 1178 | 0 | 163 | 2 | 2 | Grep×2 | 2.4 | answered |
| 1 | doc-identifier | lasso-v2 | yes | 4794 | 0 | 250 | 3 | 2 | lasso_search×1 lasso_cite×1 | 3.6 | answered |
| 1 | doc-ambiguous-sources | lasso-v2 | **no** | 7705 | 2560 | 400 | 5 | 4 | lasso_search×2 lasso_read×1 Read×1 | 7.5 | answered |
| 1 | doc-ambiguous-sources | direct | yes | 3779 | 0 | 280 | 2 | 3 | Grep×3 | 3.1 | answered |
| 1 | doc-related-facts | direct | yes | 4803 | 1664 | 276 | 3 | 4 | Grep×3 Read×1 | 4.0 | answered |
| 1 | doc-related-facts | lasso-v2 | yes | 5370 | 2304 | 361 | 4 | 3 | lasso_search×2 lasso_read×1 | 5.1 | answered |
| 1 | doc-missing | lasso-v2 | yes | 27845 | 16768 | 758 | 6 | 10 | lasso_search×4 Grep×2 lasso_read×4 | 9.2 | answered |
| 1 | doc-missing | direct | yes | 13131 | 9216 | 619 | 7 | 7 | Grep×7 | 10.2 | answered |
| 1 | doc-history * | direct | **no** | 4360 | 1408 | 436 | 3 | 6 | Grep×5 Glob×1 | 4.9 | answered |
| 1 | doc-history * | lasso-v2 | yes | 7503 | 0 | 408 | 3 | 4 | lasso_search×1 Grep×1 lasso_read×1 Read×1 | 4.8 | answered |
| 1 | doc-multi-batch | lasso-v2 | yes | 52919 | 37760 | 1778 | 10 | 14 | lasso_search×9 Glob×1 Read×3 lasso_cite×1 | 19.6 | answered |
| 1 | doc-multi-batch | direct | yes | 19126 | 10624 | 710 | 4 | 10 | Grep×3 Glob×1 Read×6 | 6.7 | answered |
| 2 | code-range-known | direct | yes | 1273 | 0 | 206 | 2 | 1 | Read×1 | 3.0 | answered |
| 2 | code-range-known | lasso-v2 | yes | 2146 | 1024 | 185 | 2 | 1 | Read×1 | 2.5 | answered |
| 2 | code-duplicate-named | lasso-v2 | **no** | 4207 | 0 | 266 | 4 | 3 | Read×2 Glob×1 | 4.1 | answered |
| 2 | code-duplicate-named | direct | **no** | 2424 | 0 | 273 | 4 | 3 | Read×2 Glob×1 | 4.3 | answered |
| 2 | code-duplicate-ambiguous | direct | yes | 1033 | 0 | 121 | 2 | 1 | Glob×1 | 2.3 | answered |
| 2 | code-duplicate-ambiguous | lasso-v2 | yes | 1951 | 0 | 134 | 2 | 1 | Glob×1 | 2.6 | answered |
| 2 | code-function-lookup | lasso-v2 | yes | 3662 | 0 | 358 | 3 | 3 | Grep×1 lasso_search×1 lasso_read×1 | 4.0 | answered |
| 2 | code-function-lookup | direct | yes | 2607 | 0 | 345 | 3 | 3 | Grep×2 Read×1 | 3.8 | answered |
| 2 | code-multi-function | direct | yes | 4868 | 0 | 1128 | 3 | 6 | Grep×3 Read×3 | 7.1 | answered |
| 2 | code-multi-function | lasso-v2 | yes | 10336 | 4736 | 1340 | 5 | 7 | lasso_search×2 Grep×3 lasso_read×2 | 9.9 | answered |
| 2 | code-config-key | lasso-v2 | yes | 4359 | 1408 | 221 | 3 | 3 | Grep×1 lasso_search×1 lasso_read×1 | 3.7 | answered |
| 2 | code-config-key | direct | yes | 1642 | 0 | 159 | 3 | 2 | Grep×1 Read×1 | 3.1 | answered |
| 2 | code-repeated-inspections | direct | **no** | 6778 | 1152 | 1005 | 6 | 5 | Read×5 | 11.7 | answered |
| 2 | code-repeated-inspections | lasso-v2 | yes | 3773 | 0 | 923 | 2 | 5 | Read×5 | 5.3 | answered |
| 2 | code-stale-reference * | lasso-v2 | yes | 2331 | 0 | 289 | 2 | 1 | lasso_read×1 | 3.2 | answered |
| 2 | code-stale-reference * | direct | **no** | 1505 | 0 | 395 | 2 | 1 | Read×1 | 3.7 | answered |
| 2 | code-modified-on-disk | direct | yes | 1027 | 0 | 82 | 2 | 1 | Read×1 | 1.8 | answered |
| 2 | code-modified-on-disk | lasso-v2 | yes | 1927 | 0 | 87 | 2 | 1 | Read×1 | 2.5 | answered |
| 2 | doc-short-file | lasso-v2 | yes | 1916 | 0 | 64 | 2 | 1 | Read×1 | 2.6 | answered |
| 2 | doc-short-file | direct | yes | 1042 | 0 | 86 | 2 | 1 | Read×1 | 2.1 | answered |
| 2 | doc-long-fact | direct | yes | 7216 | 2048 | 433 | 4 | 6 | Grep×6 | 5.9 | answered |
| 2 | doc-long-fact | lasso-v2 | yes | 5715 | 2048 | 255 | 3 | 3 | lasso_search×1 Grep×1 lasso_read×1 | 3.9 | answered |
| 2 | doc-large-table | lasso-v2 | yes | 2184 | 0 | 163 | 2 | 2 | lasso_search×1 Grep×1 | 2.4 | answered |
| 2 | doc-large-table | direct | yes | 1721 | 0 | 151 | 2 | 2 | Grep×2 | 2.5 | answered |
| 2 | doc-identifier | direct | yes | 1308 | 0 | 165 | 2 | 2 | Grep×2 | 2.4 | answered |
| 2 | doc-identifier | lasso-v2 | yes | 4458 | 1280 | 204 | 3 | 2 | lasso_search×1 lasso_read×1 | 3.6 | answered |
| 2 | doc-ambiguous-sources | lasso-v2 | yes | 2632 | 0 | 284 | 2 | 2 | lasso_search×1 Grep×1 | 3.4 | answered |
| 2 | doc-ambiguous-sources | direct | yes | 2408 | 0 | 278 | 2 | 2 | Grep×2 | 2.9 | answered |
| 2 | doc-related-facts | direct | yes | 1931 | 0 | 212 | 2 | 3 | Grep×3 | 2.6 | answered |
| 2 | doc-related-facts | lasso-v2 | yes | 7045 | 3328 | 473 | 4 | 3 | lasso_search×1 lasso_cite×2 | 5.3 | answered |
| 2 | doc-missing | lasso-v2 | yes | 45001 | 33920 | 1237 | 9 | 16 | lasso_search×4 Grep×6 Glob×2 lasso_read×4 | 14.3 | answered |
| 2 | doc-missing | direct | yes | 43976 | 24832 | 727 | 6 | 14 | Grep×6 Glob×3 Read×5 | 9.0 | answered |
| 2 | doc-history * | direct | **no** | 4655 | 1536 | 572 | 3 | 4 | Grep×3 Glob×1 | 5.6 | answered |
| 2 | doc-history * | lasso-v2 | **no** | 11460 | 6016 | 658 | 5 | 6 | lasso_search×3 lasso_read×1 Grep×2 | 8.1 | answered |
| 2 | doc-multi-batch | lasso-v2 | yes | 40671 | 30336 | 1541 | 9 | 14 | lasso_search×5 Grep×6 lasso_read×1 Read×2 | 16.8 | answered |
| 2 | doc-multi-batch | direct | yes | 18998 | 10752 | 665 | 4 | 9 | Grep×3 Glob×1 Read×5 | 6.2 | answered |

\* capability task: needs history direct tools cannot reach.

