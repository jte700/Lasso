# Lasso agent benchmark: live model runs

Generated 2026-10-27T22:46:27.112Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 2 run(s); spent $0.340 of a $0.4 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.4-mini

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 27/31 | 204,934 | 192,489 | 91,008 | 12,445 | 2,428 | 92 | 114 | $0.1389 | 140.6 s |
| lasso-v3 | 28/31 | 177,998 | 165,738 | 71,808 | 12,260 | 2,221 | 106 | 92 | $0.1310 | 153.1 s |

- **lasso-v3**: S = 1 − ΣT/ΣT_direct over 31 paired tasks = **13.1%** (code -97.8%, docs 39.3%); per-task ratio min 0.19, median 1.73, max 4.92; more tokens than direct on 26 of 31. Used Lasso on 23 of 32 tasks, also needing file tools on 8 of those (Read ×21, Glob ×3, lasso_search ×43, lasso_read ×22, Grep ×14).
- First-call input (instructions + tool definitions + request), median: direct 424, lasso-v3 807 tokens; so each Lasso version adds lasso-v3 +383 tokens per call.
- Capability tasks (not in S): code-stale-reference run 1 lasso-v3 correct; code-stale-reference run 1 direct wrong; doc-history run 1 direct wrong; doc-history run 1 lasso-v3 wrong; code-stale-reference run 2 lasso-v3 correct; code-stale-reference run 2 direct wrong; doc-history run 2 direct wrong; doc-history run 2 lasso-v3 correct.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | code-range-known | direct | yes | 1252 | 0 | 185 | 2 | 1 | Read×1 | 2.7 | answered |
| 1 | code-range-known | lasso-v3 | yes | 2078 | 0 | 234 | 2 | 1 | Read×1 | 2.6 | answered |
| 1 | code-duplicate-named | lasso-v3 | yes | 2954 | 0 | 237 | 3 | 2 | Glob×1 Read×1 | 3.5 | answered |
| 1 | code-duplicate-named | direct | **no** | 2386 | 0 | 256 | 4 | 3 | Read×2 Glob×1 | 4.1 | answered |
| 1 | code-duplicate-ambiguous | direct | yes | 1076 | 0 | 156 | 2 | 1 | Glob×1 | 2.9 | answered |
| 1 | code-duplicate-ambiguous | lasso-v3 | yes | 1842 | 0 | 137 | 2 | 1 | Glob×1 | 2.4 | answered |
| 1 | code-function-lookup | lasso-v3 | yes | 5051 | 1152 | 417 | 4 | 3 | lasso_search×1 lasso_read×2 | 5.7 | answered |
| 1 | code-function-lookup | direct | yes | 3327 | 0 | 375 | 3 | 3 | Grep×2 Read×1 | 4.5 | answered |
| 1 | code-multi-function | direct | yes | 6198 | 0 | 1169 | 3 | 6 | Grep×3 Read×3 | 7.1 | answered |
| 1 | code-multi-function | lasso-v3 | yes | 11204 | 5632 | 1339 | 6 | 7 | lasso_search×2 Grep×3 lasso_read×2 | 10.5 | answered |
| 1 | code-config-key | lasso-v3 | yes | 1951 | 0 | 142 | 2 | 1 | lasso_search×1 | 2.4 | answered |
| 1 | code-config-key | direct | yes | 1131 | 0 | 154 | 2 | 2 | Grep×2 | 2.8 | answered |
| 1 | code-repeated-inspections | direct | yes | 2825 | 0 | 905 | 2 | 5 | Read×5 | 5.4 | answered |
| 1 | code-repeated-inspections | lasso-v3 | **no** | 8987 | 3968 | 901 | 6 | 5 | Read×5 | 8.9 | answered |
| 1 | code-stale-reference * | lasso-v3 | yes | 2245 | 0 | 310 | 2 | 1 | lasso_read×1 | 3.1 | answered |
| 1 | code-stale-reference * | direct | **no** | 2654 | 0 | 560 | 3 | 3 | Glob×1 Grep×1 Read×1 | 5.2 | answered |
| 1 | code-modified-on-disk | direct | yes | 1029 | 0 | 84 | 2 | 1 | Read×1 | 2.0 | answered |
| 1 | code-modified-on-disk | lasso-v3 | yes | 1857 | 0 | 96 | 2 | 1 | lasso_read×1 | 2.1 | answered |
| 1 | doc-short-file | lasso-v3 | yes | 1794 | 0 | 67 | 2 | 1 | Read×1 | 1.9 | answered |
| 1 | doc-short-file | direct | yes | 1031 | 0 | 75 | 2 | 1 | Read×1 | 1.7 | answered |
| 1 | doc-long-fact | direct | yes | 1731 | 0 | 194 | 2 | 3 | Grep×2 Glob×1 | 2.8 | answered |
| 1 | doc-long-fact | lasso-v3 | yes | 8521 | 3456 | 278 | 3 | 3 | lasso_search×1 Grep×1 lasso_read×1 | 5.1 | answered |
| 1 | doc-large-table | lasso-v3 | yes | 2032 | 0 | 146 | 2 | 1 | lasso_search×1 | 2.5 | answered |
| 1 | doc-large-table | direct | yes | 1239 | 0 | 140 | 2 | 2 | Grep×2 | 2.3 | answered |
| 1 | doc-identifier | direct | yes | 1168 | 0 | 157 | 2 | 2 | Grep×2 | 2.5 | answered |
| 1 | doc-identifier | lasso-v3 | yes | 2194 | 0 | 169 | 2 | 1 | lasso_search×1 | 2.4 | answered |
| 1 | doc-ambiguous-sources | lasso-v3 | yes | 7489 | 3712 | 545 | 5 | 6 | lasso_search×2 lasso_read×2 Read×2 | 6.8 | answered |
| 1 | doc-ambiguous-sources | direct | **no** | 3123 | 1024 | 214 | 3 | 3 | Grep×2 Read×1 | 3.3 | answered |
| 1 | doc-related-facts | direct | yes | 2328 | 0 | 293 | 2 | 3 | Grep×3 | 3.0 | answered |
| 1 | doc-related-facts | lasso-v3 | yes | 5058 | 1664 | 226 | 3 | 2 | lasso_search×1 lasso_read×1 | 3.7 | answered |
| 1 | doc-missing | lasso-v3 | yes | 9873 | 4736 | 467 | 4 | 4 | lasso_search×2 lasso_read×2 | 6.1 | answered |
| 1 | doc-missing | direct | yes | 31664 | 17664 | 664 | 6 | 11 | Grep×6 Read×4 Glob×1 | 8.4 | answered |
| 1 | doc-history * | direct | **no** | 9585 | 4992 | 700 | 4 | 9 | Grep×7 Glob×2 | 7.4 | answered |
| 1 | doc-history * | lasso-v3 | **no** | 6527 | 2304 | 356 | 3 | 3 | lasso_search×1 lasso_read×2 | 4.6 | answered |
| 1 | doc-multi-batch | lasso-v3 | yes | 40076 | 29696 | 1682 | 10 | 15 | lasso_search×9 lasso_read×3 Grep×2 Read×1 | 17.4 | answered |
| 1 | doc-multi-batch | direct | **no** | 65010 | 39552 | 2236 | 10 | 18 | Grep×10 Glob×1 Read×7 | 21.6 | answered |
| 2 | code-range-known | direct | yes | 1250 | 0 | 183 | 2 | 1 | Read×1 | 2.8 | answered |
| 2 | code-range-known | lasso-v3 | yes | 2021 | 0 | 187 | 2 | 1 | Read×1 | 2.3 | answered |
| 2 | code-duplicate-named | lasso-v3 | **no** | 3962 | 0 | 275 | 4 | 3 | Read×2 Glob×1 | 4.9 | answered |
| 2 | code-duplicate-named | direct | yes | 2431 | 0 | 267 | 4 | 3 | Read×2 Glob×1 | 4.3 | answered |
| 2 | code-duplicate-ambiguous | direct | yes | 1058 | 0 | 143 | 2 | 1 | Glob×1 | 2.5 | answered |
| 2 | code-duplicate-ambiguous | lasso-v3 | yes | 1980 | 0 | 173 | 2 | 1 | lasso_search×1 | 3.0 | answered |
| 2 | code-function-lookup | lasso-v3 | yes | 6795 | 2304 | 473 | 5 | 4 | lasso_search×1 lasso_read×2 Read×1 | 6.8 | answered |
| 2 | code-function-lookup | direct | yes | 3680 | 0 | 441 | 3 | 3 | Grep×2 Read×1 | 5.6 | answered |
| 2 | code-multi-function | direct | yes | 5793 | 0 | 1150 | 3 | 6 | Grep×3 Read×3 | 7.3 | answered |
| 2 | code-multi-function | lasso-v3 | yes | 13952 | 7936 | 1299 | 6 | 7 | lasso_search×2 Grep×3 lasso_read×2 | 10.3 | answered |
| 2 | code-config-key | lasso-v3 | yes | 1998 | 0 | 177 | 2 | 2 | lasso_search×1 Grep×1 | 3.0 | answered |
| 2 | code-config-key | direct | yes | 1157 | 0 | 164 | 2 | 2 | Grep×2 | 3.0 | answered |
| 2 | code-repeated-inspections | direct | yes | 3472 | 0 | 902 | 3 | 5 | Read×5 | 5.9 | answered |
| 2 | code-repeated-inspections | lasso-v3 | **no** | 8920 | 3968 | 824 | 6 | 5 | Read×5 | 8.8 | answered |
| 2 | code-stale-reference * | lasso-v3 | yes | 5382 | 1152 | 624 | 4 | 4 | lasso_search×2 lasso_read×2 | 7.2 | answered |
| 2 | code-stale-reference * | direct | **no** | 2629 | 0 | 637 | 3 | 3 | Grep×2 Read×1 | 6.5 | answered |
| 2 | code-modified-on-disk | direct | yes | 1028 | 0 | 83 | 2 | 1 | Read×1 | 2.0 | answered |
| 2 | code-modified-on-disk | lasso-v3 | yes | 1788 | 0 | 80 | 2 | 1 | Read×1 | 2.2 | answered |
| 2 | doc-short-file | lasso-v3 | yes | 1960 | 0 | 102 | 2 | 1 | lasso_search×1 | 1.9 | answered |
| 2 | doc-short-file | direct | yes | 1018 | 0 | 62 | 2 | 1 | Read×1 | 2.3 | answered |
| 2 | doc-long-fact | direct | yes | 6053 | 2432 | 242 | 3 | 4 | Grep×3 Read×1 | 3.8 | answered |
| 2 | doc-long-fact | lasso-v3 | yes | 2505 | 0 | 189 | 2 | 1 | lasso_search×1 | 2.7 | answered |
| 2 | doc-large-table | lasso-v3 | yes | 2326 | 0 | 135 | 2 | 1 | lasso_search×1 | 2.9 | answered |
| 2 | doc-large-table | direct | yes | 1428 | 0 | 227 | 2 | 4 | Grep×4 | 2.9 | answered |
| 2 | doc-identifier | direct | yes | 1383 | 0 | 241 | 2 | 4 | Grep×4 | 3.0 | answered |
| 2 | doc-identifier | lasso-v3 | yes | 3444 | 0 | 163 | 3 | 2 | lasso_search×1 lasso_read×1 | 3.2 | answered |
| 2 | doc-ambiguous-sources | lasso-v3 | yes | 3141 | 0 | 318 | 2 | 1 | lasso_search×1 | 6.2 | answered |
| 2 | doc-ambiguous-sources | direct | **no** | 9649 | 4096 | 254 | 3 | 2 | Grep×1 Read×1 | 3.6 | answered |
| 2 | doc-related-facts | direct | yes | 3236 | 0 | 217 | 3 | 3 | Grep×2 Read×1 | 3.6 | answered |
| 2 | doc-related-facts | lasso-v3 | yes | 3477 | 1024 | 219 | 3 | 2 | lasso_search×1 lasso_read×1 | 3.7 | answered |
| 2 | doc-missing | lasso-v3 | yes | 6768 | 2560 | 563 | 5 | 6 | lasso_search×2 Grep×4 | 7.3 | answered |
| 2 | doc-missing | direct | yes | 35780 | 26240 | 612 | 7 | 9 | Grep×7 Glob×1 Read×1 | 10.9 | answered |
| 2 | doc-history * | direct | **no** | 11629 | 5632 | 617 | 4 | 8 | Grep×5 Read×2 Glob×1 | 6.6 | answered |
| 2 | doc-history * | lasso-v3 | yes | 3704 | 1024 | 284 | 3 | 2 | lasso_search×1 lasso_read×1 | 4.1 | answered |
| 2 | doc-multi-batch | lasso-v3 | yes | 76567 | 59648 | 1664 | 9 | 11 | lasso_search×9 lasso_read×2 | 18.3 | answered |

\* capability task: needs history direct tools cannot reach.

