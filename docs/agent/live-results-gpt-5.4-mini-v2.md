# Lasso agent benchmark: live model runs

Generated 2026-10-27T22:29:34.171Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 2 run(s); spent $0.795 of a $0.9 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.4-mini

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 29/32 | 146,404 | 134,678 | 45,184 | 11,726 | 1,687 | 88 | 112 | $0.1233 | 132 s |
| lasso-v1 | 29/32 | 254,409 | 241,756 | 106,112 | 12,653 | 1,690 | 105 | 138 | $0.1666 | 151.6 s |
| lasso-v2 | 27/32 | 377,873 | 360,231 | 210,432 | 17,642 | 3,059 | 131 | 179 | $0.2075 | 206.7 s |
| lasso-v2-first | 26/32 | 322,924 | 305,591 | 176,000 | 17,333 | 3,204 | 152 | 148 | $0.1884 | 221.7 s |

- **lasso-v1**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **-73.8%** (code -105.5%, docs -60.7%); per-task ratio min 0.89, median 1.63, max 14.06; more tokens than direct on 30 of 32. Used Lasso on 0 of 32 tasks, also needing file tools on 0 of those (Read ×54, Glob ×18, Grep ×66).
- **lasso-v2**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **-158.1%** (code -61.1%, docs -198.1%); per-task ratio min 0.96, median 1.81, max 19.97; more tokens than direct on 30 of 32. Used Lasso on 20 of 32 tasks, also needing file tools on 15 of those (Read ×48, Glob ×12, Grep ×51, lasso_search ×56, lasso_read ×9, lasso_cite ×3).
- **lasso-v2-first**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **-120.6%** (code -106.9%, docs -126.2%); per-task ratio min 0.47, median 2.09, max 4.32; more tokens than direct on 29 of 32. Used Lasso on 23 of 32 tasks, also needing file tools on 16 of those (Read ×25, Glob ×6, lasso_search ×70, Grep ×25, lasso_read ×18, lasso_cite ×4).
- First-call input (instructions + tool definitions + request), median: direct 424, lasso-v1 784, lasso-v2 871, lasso-v2-first 894 tokens; so each Lasso version adds lasso-v1 +360, lasso-v2 +447, lasso-v2-first +470 tokens per call.
- Capability tasks (not in S): code-stale-reference run 1 lasso-v1 wrong; code-stale-reference run 1 lasso-v2 correct; code-stale-reference run 1 lasso-v2-first correct; code-stale-reference run 1 direct wrong; doc-history run 1 lasso-v2-first wrong; doc-history run 1 direct wrong; doc-history run 1 lasso-v2 wrong; doc-history run 1 lasso-v1 wrong; code-stale-reference run 2 lasso-v1 correct; code-stale-reference run 2 lasso-v2-first correct; code-stale-reference run 2 lasso-v2 correct; code-stale-reference run 2 direct wrong; doc-history run 2 lasso-v2-first wrong; doc-history run 2 lasso-v2 wrong; doc-history run 2 direct wrong; doc-history run 2 lasso-v1 wrong.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | code-range-known | lasso-v2-first | yes | 2190 | 0 | 183 | 2 | 1 | Read×1 | 3.3 | answered |
| 1 | code-range-known | lasso-v2 | yes | 2198 | 0 | 231 | 2 | 1 | Read×1 | 2.8 | answered |
| 1 | code-range-known | direct | yes | 1265 | 0 | 198 | 2 | 1 | Read×1 | 2.7 | answered |
| 1 | code-range-known | lasso-v1 | yes | 1970 | 0 | 183 | 2 | 1 | Read×1 | 2.7 | answered |
| 1 | code-duplicate-named | lasso-v1 | **no** | 3976 | 0 | 283 | 4 | 4 | Read×2 Glob×2 | 4.6 | answered |
| 1 | code-duplicate-named | direct | **no** | 2373 | 0 | 237 | 4 | 3 | Read×2 Glob×1 | 4.5 | answered |
| 1 | code-duplicate-named | lasso-v2-first | **no** | 3199 | 0 | 219 | 3 | 2 | Glob×1 Read×1 | 3.6 | answered |
| 1 | code-duplicate-named | lasso-v2 | **no** | 4192 | 0 | 258 | 4 | 3 | Read×2 Glob×1 | 4.3 | answered |
| 1 | code-duplicate-ambiguous | lasso-v2 | yes | 1917 | 0 | 118 | 2 | 1 | Glob×1 | 2.5 | answered |
| 1 | code-duplicate-ambiguous | direct | yes | 1051 | 0 | 136 | 2 | 1 | Glob×1 | 2.5 | answered |
| 1 | code-duplicate-ambiguous | lasso-v1 | yes | 1759 | 0 | 134 | 2 | 1 | Glob×1 | 2.5 | answered |
| 1 | code-duplicate-ambiguous | lasso-v2-first | yes | 2200 | 0 | 178 | 2 | 2 | Glob×1 lasso_search×1 | 2.5 | answered |
| 1 | code-function-lookup | lasso-v2 | yes | 4619 | 0 | 399 | 3 | 3 | Grep×2 Read×1 | 4.6 | answered |
| 1 | code-function-lookup | lasso-v2-first | yes | 3664 | 0 | 380 | 3 | 3 | lasso_search×1 Grep×1 lasso_read×1 | 4.5 | answered |
| 1 | code-function-lookup | lasso-v1 | yes | 20836 | 12160 | 544 | 5 | 6 | Grep×3 Glob×1 Read×2 | 8.5 | answered |
| 1 | code-function-lookup | direct | yes | 3318 | 0 | 403 | 3 | 3 | Grep×2 Read×1 | 4.7 | answered |
| 1 | code-multi-function | lasso-v2-first | yes | 20097 | 11648 | 1733 | 9 | 11 | lasso_search×5 Grep×4 lasso_read×2 | 18.7 | answered |
| 1 | code-multi-function | direct | yes | 9932 | 3584 | 1186 | 4 | 7 | Grep×3 Read×4 | 10.2 | answered |
| 1 | code-multi-function | lasso-v2 | yes | 9777 | 1024 | 1250 | 3 | 6 | lasso_search×2 Grep×1 Read×3 | 8.2 | answered |
| 1 | code-multi-function | lasso-v1 | yes | 17995 | 10496 | 1466 | 7 | 12 | Grep×6 Read×6 | 12.2 | answered |
| 1 | code-config-key | lasso-v1 | yes | 2200 | 0 | 155 | 2 | 2 | Grep×1 Glob×1 | 2.5 | answered |
| 1 | code-config-key | direct | yes | 1203 | 0 | 166 | 2 | 2 | Grep×2 | 2.5 | answered |
| 1 | code-config-key | lasso-v2-first | yes | 3417 | 1024 | 239 | 3 | 3 | lasso_search×1 Grep×1 Read×1 | 3.4 | answered |
| 1 | code-config-key | lasso-v2 | yes | 2067 | 0 | 169 | 2 | 2 | Grep×1 lasso_search×1 | 2.4 | answered |
| 1 | code-repeated-inspections | lasso-v1 | yes | 4501 | 0 | 851 | 3 | 5 | Read×5 | 5.8 | answered |
| 1 | code-repeated-inspections | lasso-v2 | yes | 3716 | 0 | 894 | 2 | 5 | Read×5 | 5.5 | answered |
| 1 | code-repeated-inspections | direct | yes | 3392 | 0 | 822 | 3 | 5 | Read×5 | 6.1 | answered |
| 1 | code-repeated-inspections | lasso-v2-first | **no** | 9455 | 5248 | 837 | 6 | 5 | Read×5 | 10.1 | answered |
| 1 | code-stale-reference * | lasso-v1 | **no** | 5665 | 1024 | 543 | 5 | 4 | lasso_inspect×1 Glob×1 lasso_suggest×1 Read×1 | 7.2 | answered |
| 1 | code-stale-reference * | lasso-v2 | yes | 2362 | 0 | 315 | 2 | 1 | lasso_read×1 | 3.2 | answered |
| 1 | code-stale-reference * | lasso-v2-first | yes | 2375 | 0 | 293 | 2 | 1 | lasso_read×1 | 3.0 | answered |
| 1 | code-stale-reference * | direct | **no** | 4641 | 1024 | 564 | 4 | 5 | Grep×4 Read×1 | 6.0 | answered |
| 1 | code-modified-on-disk | lasso-v2 | yes | 2026 | 0 | 132 | 2 | 1 | lasso_read×1 | 2.5 | answered |
| 1 | code-modified-on-disk | direct | yes | 1017 | 0 | 72 | 2 | 1 | Read×1 | 1.9 | answered |
| 1 | code-modified-on-disk | lasso-v2-first | yes | 1965 | 0 | 81 | 2 | 1 | Read×1 | 2.2 | answered |
| 1 | code-modified-on-disk | lasso-v1 | yes | 1745 | 0 | 83 | 2 | 1 | Read×1 | 2.3 | answered |
| 1 | doc-short-file | lasso-v1 | yes | 1738 | 0 | 62 | 2 | 1 | Read×1 | 2.1 | answered |
| 1 | doc-short-file | direct | yes | 1035 | 0 | 79 | 2 | 1 | Read×1 | 1.9 | answered |
| 1 | doc-short-file | lasso-v2-first | yes | 3566 | 0 | 214 | 3 | 3 | lasso_search×1 Glob×1 Grep×1 | 3.9 | answered |
| 1 | doc-short-file | lasso-v2 | yes | 1926 | 0 | 69 | 2 | 1 | Read×1 | 2.0 | answered |
| 1 | doc-long-fact | lasso-v2 | yes | 5633 | 2048 | 241 | 3 | 2 | lasso_search×1 lasso_read×1 | 3.8 | answered |
| 1 | doc-long-fact | direct | yes | 5284 | 1792 | 430 | 3 | 6 | Grep×6 | 4.4 | answered |
| 1 | doc-long-fact | lasso-v1 | yes | 7330 | 3328 | 413 | 4 | 5 | Grep×4 Glob×1 | 5.5 | answered |
| 1 | doc-long-fact | lasso-v2-first | yes | 4514 | 1280 | 318 | 3 | 3 | lasso_search×2 Grep×1 | 4.0 | answered |
| 1 | doc-large-table | lasso-v1 | yes | 2008 | 0 | 164 | 2 | 3 | Grep×1 Glob×2 | 2.1 | answered |
| 1 | doc-large-table | lasso-v2 | yes | 2104 | 0 | 172 | 2 | 2 | lasso_search×1 Grep×1 | 2.5 | answered |
| 1 | doc-large-table | lasso-v2-first | yes | 2414 | 0 | 133 | 2 | 1 | lasso_search×1 | 2.5 | answered |
| 1 | doc-large-table | direct | yes | 1245 | 0 | 146 | 2 | 2 | Grep×2 | 2.4 | answered |
| 1 | doc-identifier | lasso-v2-first | yes | 4972 | 0 | 351 | 4 | 3 | lasso_search×2 lasso_cite×1 | 4.9 | answered |
| 1 | doc-identifier | lasso-v2 | yes | 6266 | 2944 | 354 | 4 | 3 | lasso_search×1 lasso_cite×2 | 10.7 | answered |
| 1 | doc-identifier | direct | yes | 1665 | 0 | 255 | 2 | 4 | Grep×4 | 3.1 | answered |
| 1 | doc-identifier | lasso-v1 | yes | 1996 | 0 | 206 | 2 | 3 | Grep×3 | 2.6 | answered |
| 1 | doc-ambiguous-sources | lasso-v1 | yes | 3633 | 0 | 243 | 2 | 2 | Grep×1 Glob×1 | 3.4 | answered |
| 1 | doc-ambiguous-sources | direct | yes | 2798 | 0 | 255 | 2 | 2 | Grep×2 | 3.0 | answered |
| 1 | doc-ambiguous-sources | lasso-v2-first | yes | 2518 | 0 | 308 | 2 | 2 | lasso_search×1 Grep×1 | 3.3 | answered |
| 1 | doc-ambiguous-sources | lasso-v2 | **no** | 5684 | 2432 | 446 | 4 | 6 | lasso_search×2 Grep×1 Glob×1 lasso_read×2 | 5.9 | answered |
| 1 | doc-related-facts | lasso-v2 | yes | 17318 | 8832 | 878 | 8 | 8 | lasso_search×5 lasso_read×1 Read×2 | 11.4 | answered |
| 1 | doc-related-facts | direct | yes | 2417 | 0 | 202 | 2 | 2 | Grep×2 | 3.3 | answered |
| 1 | doc-related-facts | lasso-v1 | yes | 3878 | 0 | 240 | 3 | 4 | Grep×1 Glob×2 Read×1 | 4.1 | answered |
| 1 | doc-related-facts | lasso-v2-first | yes | 7353 | 2816 | 452 | 5 | 4 | lasso_search×3 lasso_read×1 | 6.4 | answered |
| 1 | doc-missing | lasso-v1 | yes | 42642 | 28160 | 746 | 7 | 11 | Grep×6 Glob×1 Read×4 | 9.7 | answered |
| 1 | doc-missing | lasso-v2 | yes | 42024 | 26112 | 1164 | 9 | 16 | lasso_search×3 Grep×6 lasso_read×1 Read×5 Glob×1 | 14.5 | answered |
| 1 | doc-missing | lasso-v2-first | yes | 12106 | 6528 | 841 | 7 | 10 | lasso_search×4 Grep×6 | 10.4 | answered |
| 1 | doc-missing | direct | yes | 25944 | 17408 | 696 | 6 | 8 | Grep×6 Glob×1 Read×1 | 9.2 | answered |
| 1 | doc-history * | lasso-v2-first | **no** | 77226 | 51328 | 1552 | 10 | 15 | lasso_search×4 Grep×6 Glob×2 lasso_read×2 Read×1 | 17.3 | answered |
| 1 | doc-history * | direct | **no** | 9068 | 5376 | 667 | 5 | 6 | Grep×6 | 7.7 | answered |
| 1 | doc-history * | lasso-v2 | **no** | 19034 | 10752 | 1072 | 6 | 10 | lasso_search×4 Grep×4 lasso_read×1 Read×1 | 10.8 | answered |
| 1 | doc-history * | lasso-v1 | **no** | 16776 | 9728 | 496 | 4 | 5 | Grep×1 Glob×2 Read×2 | 5.4 | answered |
| 1 | doc-multi-batch | lasso-v1 | yes | 17656 | 5120 | 893 | 5 | 15 | Grep×9 Glob×1 Read×5 | 8.3 | answered |
| 1 | doc-multi-batch | lasso-v2-first | **no** | 56785 | 46208 | 1922 | 14 | 18 | lasso_search×12 Grep×2 Read×1 lasso_read×3 | 22.8 | turns |
| 1 | doc-multi-batch | direct | yes | 17549 | 4608 | 707 | 4 | 10 | Grep×5 Glob×1 Read×4 | 7.1 | answered |
| 1 | doc-multi-batch | lasso-v2 | **no** | 91964 | 76288 | 2092 | 13 | 27 | lasso_search×8 Grep×11 Glob×3 Read×5 | 23.1 | answered |
| 2 | code-range-known | lasso-v2-first | yes | 2207 | 0 | 201 | 2 | 1 | Read×1 | 3.0 | answered |
| 2 | code-range-known | direct | yes | 1250 | 0 | 183 | 2 | 1 | Read×1 | 2.5 | answered |
| 2 | code-range-known | lasso-v2 | yes | 2146 | 0 | 185 | 2 | 1 | Read×1 | 2.5 | answered |
| 2 | code-range-known | lasso-v1 | yes | 1980 | 0 | 193 | 2 | 1 | Read×1 | 2.7 | answered |
| 2 | code-duplicate-named | lasso-v1 | **no** | 2844 | 0 | 219 | 3 | 2 | Glob×1 Read×1 | 3.6 | answered |
| 2 | code-duplicate-named | direct | **no** | 2407 | 0 | 253 | 4 | 3 | Read×2 Glob×1 | 4.5 | answered |
| 2 | code-duplicate-named | lasso-v2-first | **no** | 4341 | 0 | 277 | 4 | 3 | Read×2 Glob×1 | 4.5 | answered |
| 2 | code-duplicate-named | lasso-v2 | **no** | 4168 | 0 | 238 | 4 | 3 | Read×2 Glob×1 | 4.7 | answered |
| 2 | code-duplicate-ambiguous | lasso-v1 | yes | 1766 | 0 | 136 | 2 | 1 | Glob×1 | 2.5 | answered |
| 2 | code-duplicate-ambiguous | direct | yes | 1056 | 0 | 141 | 2 | 1 | Glob×1 | 2.2 | answered |
| 2 | code-duplicate-ambiguous | lasso-v2 | yes | 1914 | 0 | 115 | 2 | 1 | Glob×1 | 2.5 | answered |
| 2 | code-duplicate-ambiguous | lasso-v2-first | yes | 1961 | 0 | 116 | 2 | 1 | Glob×1 | 2.1 | answered |
| 2 | code-function-lookup | lasso-v1 | yes | 4328 | 0 | 369 | 3 | 3 | Grep×2 Read×1 | 4.9 | answered |
| 2 | code-function-lookup | lasso-v2-first | yes | 5034 | 1152 | 426 | 4 | 3 | lasso_search×2 lasso_read×1 | 5.2 | answered |
| 2 | code-function-lookup | lasso-v2 | yes | 4298 | 1024 | 493 | 3 | 4 | Grep×3 Read×1 | 5.0 | answered |
| 2 | code-function-lookup | direct | yes | 2661 | 0 | 394 | 3 | 3 | Grep×2 Read×1 | 4.2 | answered |
| 2 | code-multi-function | lasso-v2-first | **no** | 15000 | 8448 | 1254 | 8 | 11 | lasso_search×4 lasso_read×3 Grep×3 Read×1 | 12.3 | answered |
| 2 | code-multi-function | lasso-v2 | yes | 11204 | 5376 | 1379 | 5 | 9 | lasso_search×1 Grep×4 Read×4 | 9.4 | answered |
| 2 | code-multi-function | direct | yes | 6092 | 0 | 1159 | 3 | 6 | Grep×3 Read×3 | 7.6 | answered |
| 2 | code-multi-function | lasso-v1 | yes | 9185 | 0 | 1158 | 3 | 6 | Grep×3 Read×3 | 7.7 | answered |
| 2 | code-config-key | lasso-v2-first | yes | 2251 | 0 | 200 | 2 | 2 | lasso_search×1 Grep×1 | 2.5 | answered |
| 2 | code-config-key | direct | yes | 1140 | 0 | 157 | 2 | 2 | Grep×2 | 2.4 | answered |
| 2 | code-config-key | lasso-v1 | yes | 2196 | 0 | 151 | 2 | 2 | Grep×1 Glob×1 | 2.6 | answered |
| 2 | code-config-key | lasso-v2 | yes | 3299 | 0 | 226 | 3 | 3 | lasso_search×1 Grep×1 Read×1 | 4.1 | answered |
| 2 | code-repeated-inspections | lasso-v2 | **no** | 9300 | 5248 | 830 | 6 | 5 | Read×5 | 8.7 | answered |
| 2 | code-repeated-inspections | direct | **no** | 3543 | 0 | 973 | 3 | 5 | Read×5 | 6.7 | answered |
| 2 | code-repeated-inspections | lasso-v1 | **no** | 8793 | 3968 | 860 | 6 | 5 | Read×5 | 9.0 | answered |
| 2 | code-repeated-inspections | lasso-v2-first | yes | 9442 | 5248 | 829 | 6 | 5 | Read×5 | 8.8 | answered |
| 2 | code-stale-reference * | lasso-v1 | yes | 3813 | 1024 | 395 | 3 | 2 | lasso_inspect×2 | 4.3 | answered |
| 2 | code-stale-reference * | lasso-v2-first | yes | 2405 | 0 | 325 | 2 | 1 | lasso_read×1 | 3.7 | answered |
| 2 | code-stale-reference * | lasso-v2 | yes | 2424 | 0 | 351 | 2 | 1 | lasso_read×1 | 3.9 | answered |
| 2 | code-stale-reference * | direct | **no** | 3695 | 0 | 613 | 4 | 4 | Grep×3 Read×1 | 6.9 | answered |
| 2 | code-modified-on-disk | lasso-v2-first | yes | 1964 | 0 | 81 | 2 | 1 | Read×1 | 1.9 | answered |
| 2 | code-modified-on-disk | direct | yes | 1027 | 0 | 82 | 2 | 1 | Read×1 | 2.2 | answered |
| 2 | code-modified-on-disk | lasso-v2 | yes | 1993 | 0 | 106 | 2 | 1 | lasso_read×1 | 2.1 | answered |
| 2 | code-modified-on-disk | lasso-v1 | yes | 1743 | 0 | 81 | 2 | 1 | Read×1 | 2.1 | answered |
| 2 | doc-short-file | lasso-v1 | yes | 1740 | 0 | 64 | 2 | 1 | Read×1 | 1.9 | answered |
| 2 | doc-short-file | lasso-v2-first | yes | 4281 | 0 | 185 | 4 | 3 | lasso_search×1 Glob×1 Read×1 | 4.3 | answered |
| 2 | doc-short-file | direct | yes | 1030 | 0 | 74 | 2 | 1 | Read×1 | 2.3 | answered |
| 2 | doc-short-file | lasso-v2 | yes | 1912 | 0 | 62 | 2 | 1 | Read×1 | 1.7 | answered |
| 2 | doc-long-fact | lasso-v2 | yes | 33801 | 17024 | 699 | 6 | 8 | lasso_search×3 Grep×4 Read×1 | 8.3 | answered |
| 2 | doc-long-fact | direct | yes | 1693 | 0 | 211 | 2 | 3 | Grep×3 | 2.6 | answered |
| 2 | doc-long-fact | lasso-v1 | yes | 23803 | 14592 | 400 | 5 | 6 | Grep×5 Read×1 | 6.1 | answered |
| 2 | doc-long-fact | lasso-v2-first | yes | 4291 | 0 | 258 | 2 | 2 | lasso_search×1 Grep×1 | 4.0 | answered |
| 2 | doc-large-table | lasso-v1 | yes | 1978 | 0 | 156 | 2 | 2 | Grep×2 | 2.8 | answered |
| 2 | doc-large-table | lasso-v2-first | yes | 6635 | 1536 | 291 | 4 | 3 | lasso_search×1 lasso_cite×2 | 4.9 | answered |
| 2 | doc-large-table | lasso-v2 | yes | 2205 | 0 | 183 | 2 | 2 | lasso_search×1 Grep×1 | 2.8 | answered |
| 2 | doc-large-table | direct | yes | 2187 | 0 | 189 | 3 | 3 | Grep×2 Read×1 | 3.3 | answered |
| 2 | doc-identifier | lasso-v2-first | yes | 5049 | 1152 | 413 | 4 | 3 | lasso_search×2 lasso_cite×1 | 5.4 | answered |
| 2 | doc-identifier | direct | yes | 1169 | 0 | 158 | 2 | 2 | Grep×2 | 2.7 | answered |
| 2 | doc-identifier | lasso-v2 | yes | 4977 | 1664 | 335 | 3 | 2 | lasso_search×1 lasso_cite×1 | 4.7 | answered |
| 2 | doc-identifier | lasso-v1 | yes | 2039 | 0 | 173 | 2 | 2 | Grep×2 | 2.6 | answered |
| 2 | doc-ambiguous-sources | lasso-v1 | yes | 3633 | 0 | 387 | 3 | 5 | Grep×3 Read×2 | 4.1 | answered |
| 2 | doc-ambiguous-sources | lasso-v2-first | **no** | 14779 | 8704 | 827 | 8 | 7 | lasso_search×5 lasso_read×1 Read×1 | 10.7 | answered |
| 2 | doc-ambiguous-sources | direct | yes | 4104 | 0 | 343 | 2 | 2 | Grep×2 | 3.1 | answered |
| 2 | doc-ambiguous-sources | lasso-v2 | yes | 3937 | 1024 | 451 | 3 | 4 | lasso_search×1 Grep×1 Read×2 | 4.5 | answered |
| 2 | doc-related-facts | lasso-v1 | yes | 5427 | 1152 | 243 | 4 | 4 | Grep×2 Glob×1 Read×1 | 4.4 | answered |
| 2 | doc-related-facts | direct | yes | 2352 | 0 | 184 | 2 | 2 | Grep×2 | 2.4 | answered |
| 2 | doc-related-facts | lasso-v2 | yes | 7905 | 3968 | 417 | 4 | 4 | lasso_search×2 Grep×1 Read×1 | 5.3 | answered |
| 2 | doc-related-facts | lasso-v2-first | yes | 7180 | 2048 | 461 | 4 | 5 | lasso_search×3 lasso_read×2 | 5.5 | answered |
| 2 | doc-missing | lasso-v1 | yes | 26474 | 15872 | 692 | 6 | 11 | Grep×8 Read×3 | 8.6 | answered |
| 2 | doc-missing | lasso-v2-first | yes | 47681 | 36736 | 1174 | 12 | 11 | lasso_search×6 Grep×2 lasso_read×3 | 17.2 | answered |
| 2 | doc-missing | lasso-v2 | yes | 25300 | 12800 | 1277 | 9 | 16 | lasso_search×8 Grep×5 Glob×1 lasso_read×2 | 14.5 | answered |
| 2 | doc-missing | direct | yes | 18809 | 11776 | 512 | 5 | 9 | Grep×7 Glob×1 Read×1 | 7.4 | answered |
| 2 | doc-history * | lasso-v2-first | **no** | 9136 | 3328 | 446 | 3 | 4 | lasso_search×1 Grep×1 lasso_read×2 | 5.1 | answered |
| 2 | doc-history * | lasso-v2 | **no** | 12644 | 7552 | 714 | 5 | 6 | lasso_search×2 lasso_read×2 Grep×2 | 8.4 | answered |
| 2 | doc-history * | direct | **no** | 5043 | 1664 | 337 | 3 | 4 | Grep×1 Glob×1 Read×2 | 4.3 | answered |
| 2 | doc-history * | lasso-v1 | **no** | 8339 | 1280 | 340 | 3 | 5 | Grep×1 Glob×1 Read×3 | 4.3 | answered |
| 2 | doc-multi-batch | lasso-v1 | yes | 20617 | 11264 | 705 | 4 | 10 | Grep×3 Glob×1 Read×6 | 7.3 | answered |
| 2 | doc-multi-batch | lasso-v2-first | yes | 50413 | 36224 | 1951 | 14 | 15 | lasso_search×10 lasso_read×1 Grep×1 Read×3 | 23.3 | answered |
| 2 | doc-multi-batch | direct | yes | 14396 | 6016 | 723 | 4 | 10 | Grep×4 Glob×1 Read×5 | 6.6 | answered |
| 2 | doc-multi-batch | lasso-v2 | yes | 56083 | 42624 | 1779 | 10 | 28 | lasso_search×14 Glob×2 Read×4 Grep×8 | 19.2 | answered |

\* capability task: needs history direct tools cannot reach.

