# Lasso agent benchmark: live model runs

Generated 2026-10-27T21:38:51.766Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 2 run(s); spent $0.634 of a $1.8 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.4-mini

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 29/32 | 193,743 | 181,196 | 75,904 | 12,547 | 1,771 | 93 | 121 | $0.1411 | 136.3 s |
| lasso | 28/32 | 792,509 | 779,364 | 592,128 | 13,145 | 2,227 | 105 | 133 | $0.2440 | 158.8 s |
| lasso-first | 29/32 | 267,717 | 253,411 | 120,576 | 14,306 | 2,009 | 112 | 142 | $0.1730 | 181.1 s |

- **lasso**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **-309.1%** (code -74.1%, docs -364%); per-task ratio min 0.26, median 1.64, max 30.6; more tokens than direct on 29 of 32. Used Lasso on 1 of 32 tasks, also needing file tools on 1 of those (Read ×52, Glob ×9, Grep ×71, lasso_suggest ×1).
- **lasso-first**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **-38.2%** (code -98.8%, docs -24%); per-task ratio min 0.16, median 1.6, max 18.46; more tokens than direct on 26 of 32. Used Lasso on 10 of 32 tasks, also needing file tools on 10 of those (Read ×41, Glob ×5, Grep ×62, lasso_suggest ×29, lasso_inspect ×5).
- First-call input (instructions + tool definitions + request), median: direct 424, lasso 784, lasso-first 807 tokens. Lasso's definitions and instructions cost **360 tokens per call** in this model's tokenizer (offline estimate: 838).
- Capability tasks (not in S): code-stale-reference run 1 lasso-first correct; code-stale-reference run 1 direct wrong; code-stale-reference run 1 lasso correct; doc-history run 1 lasso wrong; doc-history run 1 lasso-first wrong; doc-history run 1 direct wrong; code-stale-reference run 2 lasso wrong; code-stale-reference run 2 direct wrong; code-stale-reference run 2 lasso-first wrong; doc-history run 2 lasso wrong; doc-history run 2 lasso-first wrong; doc-history run 2 direct wrong.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | code-range-known | lasso | yes | 1974 | 0 | 188 | 2 | 1 | Read×1 | 2.7 | answered |
| 1 | code-range-known | lasso-first | yes | 2012 | 0 | 176 | 2 | 1 | Read×1 | 2.8 | answered |
| 1 | code-range-known | direct | yes | 1296 | 0 | 228 | 2 | 1 | Read×1 | 2.8 | answered |
| 1 | code-duplicate-named | lasso-first | **no** | 2921 | 0 | 223 | 3 | 2 | Glob×1 Read×1 | 3.6 | answered |
| 1 | code-duplicate-named | direct | **no** | 2414 | 0 | 270 | 4 | 3 | Read×2 Glob×1 | 4.4 | answered |
| 1 | code-duplicate-named | lasso | **no** | 3855 | 0 | 250 | 4 | 3 | Read×2 Glob×1 | 4.4 | answered |
| 1 | code-duplicate-ambiguous | lasso-first | yes | 1811 | 0 | 135 | 2 | 1 | Glob×1 | 2.1 | answered |
| 1 | code-duplicate-ambiguous | direct | yes | 1069 | 0 | 146 | 2 | 1 | Glob×1 | 2.2 | answered |
| 1 | code-duplicate-ambiguous | lasso | yes | 1764 | 0 | 129 | 2 | 1 | Glob×1 | 2.5 | answered |
| 1 | code-function-lookup | lasso | yes | 3731 | 0 | 374 | 3 | 3 | Grep×2 Read×1 | 4.8 | answered |
| 1 | code-function-lookup | direct | yes | 2676 | 0 | 399 | 3 | 3 | Grep×2 Read×1 | 4.2 | answered |
| 1 | code-function-lookup | lasso-first | yes | 3817 | 0 | 383 | 3 | 3 | Grep×2 Read×1 | 4.5 | answered |
| 1 | code-multi-function | lasso | yes | 11643 | 6144 | 1276 | 5 | 7 | Grep×2 Read×5 | 11.3 | answered |
| 1 | code-multi-function | direct | yes | 4958 | 0 | 1165 | 3 | 6 | Grep×3 Read×3 | 7.4 | answered |
| 1 | code-multi-function | lasso-first | **no** | 18497 | 9856 | 1509 | 7 | 9 | lasso_suggest×3 Grep×1 Read×1 lasso_inspect×4 | 12.8 | answered |
| 1 | code-config-key | lasso | yes | 1927 | 0 | 169 | 2 | 2 | Grep×2 | 2.2 | answered |
| 1 | code-config-key | lasso-first | yes | 1918 | 0 | 165 | 2 | 2 | Grep×2 | 2.5 | answered |
| 1 | code-config-key | direct | yes | 1149 | 0 | 164 | 2 | 2 | Grep×2 | 2.6 | answered |
| 1 | code-repeated-inspections | lasso | yes | 4533 | 0 | 883 | 3 | 5 | Read×5 | 6.3 | answered |
| 1 | code-repeated-inspections | lasso-first | yes | 8937 | 3968 | 866 | 6 | 5 | Read×5 | 8.8 | answered |
| 1 | code-repeated-inspections | direct | **no** | 3579 | 0 | 1009 | 3 | 5 | Read×5 | 6.6 | answered |
| 1 | code-stale-reference * | lasso-first | yes | 3916 | 1024 | 451 | 3 | 2 | lasso_inspect×2 | 5.3 | answered |
| 1 | code-stale-reference * | direct | **no** | 3414 | 0 | 496 | 4 | 3 | Glob×1 Read×1 Grep×1 | 5.8 | answered |
| 1 | code-stale-reference * | lasso | yes | 2239 | 0 | 335 | 2 | 1 | lasso_inspect×1 | 3.4 | answered |
| 1 | code-modified-on-disk | lasso-first | yes | 1785 | 0 | 78 | 2 | 1 | Read×1 | 2.0 | answered |
| 1 | code-modified-on-disk | direct | yes | 1021 | 0 | 81 | 2 | 1 | Read×1 | 1.9 | answered |
| 1 | code-modified-on-disk | lasso | yes | 1741 | 0 | 81 | 2 | 1 | Read×1 | 2.1 | answered |
| 1 | doc-short-file | lasso | yes | 1738 | 0 | 62 | 2 | 1 | Read×1 | 2.8 | answered |
| 1 | doc-short-file | direct | yes | 1029 | 0 | 73 | 2 | 1 | Read×1 | 2.1 | answered |
| 1 | doc-short-file | lasso-first | yes | 1783 | 0 | 62 | 2 | 1 | Read×1 | 1.9 | answered |
| 1 | doc-long-fact | lasso | yes | 3903 | 0 | 203 | 2 | 3 | Grep×3 | 2.5 | answered |
| 1 | doc-long-fact | lasso-first | yes | 2451 | 0 | 205 | 2 | 3 | Grep×3 | 2.7 | answered |
| 1 | doc-long-fact | direct | yes | 15097 | 7680 | 547 | 5 | 8 | Grep×6 Glob×1 Read×1 | 7.3 | answered |
| 1 | doc-large-table | lasso | yes | 3053 | 0 | 202 | 3 | 4 | Grep×1 Glob×2 Read×1 | 3.7 | answered |
| 1 | doc-large-table | lasso-first | yes | 6026 | 2176 | 413 | 5 | 6 | lasso_suggest×2 Grep×4 | 6.6 | answered |
| 1 | doc-large-table | direct | yes | 1258 | 0 | 204 | 2 | 3 | Grep×3 | 3.2 | answered |
| 1 | doc-identifier | lasso-first | yes | 21242 | 10880 | 679 | 7 | 10 | lasso_suggest×5 Grep×4 Read×1 | 11.9 | answered |
| 1 | doc-identifier | direct | yes | 1151 | 0 | 149 | 2 | 2 | Grep×1 Glob×1 | 2.2 | answered |
| 1 | doc-identifier | lasso | yes | 1980 | 0 | 171 | 2 | 2 | Grep×2 | 2.6 | answered |
| 1 | doc-ambiguous-sources | lasso-first | yes | 7004 | 2304 | 362 | 3 | 4 | lasso_suggest×1 Grep×1 Read×2 | 4.2 | answered |
| 1 | doc-ambiguous-sources | direct | yes | 2741 | 0 | 346 | 2 | 3 | Grep×3 | 3.1 | answered |
| 1 | doc-ambiguous-sources | lasso | **no** | 3480 | 0 | 286 | 2 | 2 | Grep×2 | 3.4 | answered |
| 1 | doc-related-facts | lasso | yes | 4385 | 1408 | 223 | 3 | 3 | Grep×2 Read×1 | 3.6 | answered |
| 1 | doc-related-facts | direct | yes | 4233 | 0 | 291 | 4 | 5 | Grep×3 Glob×1 Read×1 | 4.5 | answered |
| 1 | doc-related-facts | lasso-first | yes | 3050 | 0 | 252 | 2 | 2 | lasso_suggest×1 Grep×1 | 3.3 | answered |
| 1 | doc-missing | lasso | yes | 27042 | 18304 | 626 | 7 | 11 | Grep×5 Read×5 Glob×1 | 9.3 | answered |
| 1 | doc-missing | direct | yes | 23654 | 12160 | 565 | 5 | 7 | Grep×6 Read×1 | 7.3 | answered |
| 1 | doc-missing | lasso-first | yes | 19952 | 8832 | 629 | 6 | 7 | lasso_suggest×3 lasso_inspect×1 Grep×3 | 8.6 | answered |
| 1 | doc-history * | lasso | **no** | 15155 | 9856 | 848 | 6 | 7 | Grep×3 Glob×1 lasso_inspect×2 Read×1 | 9.6 | answered |
| 1 | doc-history * | lasso-first | **no** | 32530 | 22656 | 1070 | 11 | 12 | lasso_suggest×5 lasso_inspect×3 Grep×2 Read×2 | 15.1 | answered |
| 1 | doc-history * | direct | **no** | 14712 | 8832 | 900 | 5 | 12 | Grep×10 Glob×2 | 8.8 | answered |
| 1 | doc-multi-batch | lasso | **no** | 54159 | 40192 | 1642 | 8 | 16 | Grep×9 Glob×1 Read×6 | 15.7 | answered |
| 1 | doc-multi-batch | lasso-first | yes | 42756 | 28032 | 1022 | 7 | 14 | lasso_suggest×2 Grep×4 Read×8 | 11.1 | answered |
| 1 | doc-multi-batch | direct | yes | 35372 | 24576 | 929 | 6 | 12 | Grep×8 Glob×1 Read×3 | 8.9 | answered |
| 2 | code-range-known | lasso-first | yes | 2004 | 0 | 171 | 2 | 1 | Read×1 | 2.9 | answered |
| 2 | code-range-known | direct | yes | 1259 | 0 | 193 | 2 | 1 | Read×1 | 2.7 | answered |
| 2 | code-range-known | lasso | yes | 1984 | 0 | 197 | 2 | 1 | Read×1 | 2.6 | answered |
| 2 | code-duplicate-named | lasso | yes | 2805 | 0 | 178 | 3 | 2 | Glob×1 Read×1 | 3.3 | answered |
| 2 | code-duplicate-named | direct | **no** | 2376 | 0 | 238 | 4 | 3 | Read×2 Glob×1 | 4.7 | answered |
| 2 | code-duplicate-named | lasso-first | **no** | 2927 | 0 | 225 | 3 | 2 | Glob×1 Read×1 | 3.7 | answered |
| 2 | code-duplicate-ambiguous | lasso | yes | 1777 | 0 | 142 | 2 | 1 | Glob×1 | 2.4 | answered |
| 2 | code-duplicate-ambiguous | direct | yes | 1055 | 0 | 145 | 2 | 1 | Glob×1 | 2.3 | answered |
| 2 | code-duplicate-ambiguous | lasso-first | yes | 1928 | 0 | 174 | 2 | 2 | Glob×1 Grep×1 | 2.2 | answered |
| 2 | code-function-lookup | lasso | yes | 4347 | 0 | 377 | 3 | 3 | Grep×2 Read×1 | 4.2 | answered |
| 2 | code-function-lookup | lasso-first | yes | 4426 | 0 | 387 | 3 | 3 | Grep×2 Read×1 | 4.0 | answered |
| 2 | code-function-lookup | direct | yes | 3319 | 0 | 555 | 3 | 3 | Grep×2 Read×1 | 5.9 | answered |
| 2 | code-multi-function | lasso | yes | 9165 | 0 | 1146 | 3 | 6 | Grep×3 Read×3 | 7.0 | answered |
| 2 | code-multi-function | lasso-first | yes | 11690 | 4480 | 1458 | 5 | 10 | Grep×6 Read×4 | 11.2 | answered |
| 2 | code-multi-function | direct | yes | 4927 | 0 | 1177 | 3 | 6 | Grep×3 Read×3 | 7.5 | answered |
| 2 | code-config-key | lasso-first | yes | 1917 | 0 | 162 | 2 | 2 | Grep×2 | 2.3 | answered |
| 2 | code-config-key | direct | yes | 1139 | 0 | 157 | 2 | 2 | Grep×2 | 2.6 | answered |
| 2 | code-config-key | lasso | yes | 2174 | 0 | 137 | 2 | 2 | Grep×1 Glob×1 | 2.1 | answered |
| 2 | code-repeated-inspections | lasso-first | yes | 4606 | 0 | 879 | 3 | 5 | Read×5 | 6.3 | answered |
| 2 | code-repeated-inspections | direct | yes | 3456 | 0 | 886 | 3 | 5 | Read×5 | 6.3 | answered |
| 2 | code-repeated-inspections | lasso | yes | 8760 | 3968 | 827 | 6 | 5 | Read×5 | 9.1 | answered |
| 2 | code-stale-reference * | lasso | **no** | 4062 | 0 | 697 | 3 | 2 | lasso_inspect×2 | 5.7 | answered |
| 2 | code-stale-reference * | direct | **no** | 2583 | 0 | 382 | 3 | 3 | Glob×1 Grep×1 Read×1 | 4.4 | answered |
| 2 | code-stale-reference * | lasso-first | **no** | 5646 | 2304 | 586 | 4 | 3 | lasso_inspect×3 | 7.0 | answered |
| 2 | code-modified-on-disk | lasso | yes | 1757 | 0 | 89 | 2 | 1 | Read×1 | 2.3 | answered |
| 2 | code-modified-on-disk | direct | yes | 1029 | 0 | 84 | 2 | 1 | Read×1 | 1.8 | answered |
| 2 | code-modified-on-disk | lasso-first | yes | 1795 | 0 | 85 | 2 | 1 | Read×1 | 1.9 | answered |
| 2 | doc-short-file | lasso | yes | 1740 | 0 | 64 | 2 | 1 | Read×1 | 1.8 | answered |
| 2 | doc-short-file | lasso-first | yes | 1799 | 0 | 77 | 2 | 1 | Read×1 | 2.0 | answered |
| 2 | doc-short-file | direct | yes | 1032 | 0 | 76 | 2 | 1 | Read×1 | 1.8 | answered |
| 2 | doc-long-fact | lasso | yes | 6861 | 2176 | 409 | 3 | 6 | Grep×6 | 4.4 | answered |
| 2 | doc-long-fact | lasso-first | yes | 7702 | 0 | 405 | 3 | 6 | Grep×6 | 15.0 | answered |
| 2 | doc-long-fact | direct | yes | 12028 | 3200 | 411 | 3 | 6 | Grep×5 Read×1 | 4.5 | answered |
| 2 | doc-large-table | lasso-first | yes | 2011 | 0 | 194 | 2 | 3 | Grep×3 | 2.5 | answered |
| 2 | doc-large-table | direct | yes | 1173 | 0 | 150 | 2 | 2 | Grep×2 | 2.3 | answered |
| 2 | doc-large-table | lasso | yes | 1964 | 0 | 194 | 2 | 3 | Grep×3 | 2.5 | answered |
| 2 | doc-identifier | lasso-first | yes | 1991 | 0 | 148 | 2 | 2 | Grep×2 | 2.7 | answered |
| 2 | doc-identifier | direct | yes | 1245 | 0 | 158 | 2 | 2 | Grep×2 | 2.3 | answered |
| 2 | doc-identifier | lasso | yes | 2001 | 0 | 209 | 2 | 3 | Grep×3 | 2.5 | answered |
| 2 | doc-ambiguous-sources | lasso | **no** | 4770 | 1408 | 352 | 3 | 4 | Grep×2 Read×2 | 8.0 | answered |
| 2 | doc-ambiguous-sources | direct | yes | 2514 | 0 | 229 | 2 | 2 | Grep×1 Glob×1 | 2.8 | answered |
| 2 | doc-ambiguous-sources | lasso-first | yes | 3114 | 0 | 344 | 2 | 2 | lasso_suggest×1 Grep×1 | 3.7 | answered |
| 2 | doc-related-facts | lasso | yes | 5678 | 0 | 279 | 3 | 4 | Grep×3 Read×1 | 3.8 | answered |
| 2 | doc-related-facts | direct | yes | 3455 | 0 | 224 | 2 | 3 | Grep×3 | 3.3 | answered |
| 2 | doc-related-facts | lasso-first | yes | 2739 | 0 | 222 | 2 | 3 | Grep×3 | 2.9 | answered |
| 2 | doc-missing | lasso | yes | 19220 | 11648 | 526 | 5 | 8 | Grep×7 Read×1 | 7.7 | answered |
| 2 | doc-missing | lasso-first | yes | 17421 | 9984 | 641 | 5 | 8 | lasso_suggest×3 Grep×3 Read×2 | 9.9 | answered |
| 2 | doc-missing | direct | yes | 31869 | 17536 | 643 | 6 | 11 | Grep×5 Glob×3 Read×3 | 8.8 | answered |
| 2 | doc-history * | lasso | **no** | 7183 | 2048 | 340 | 3 | 4 | Grep×1 Glob×1 Read×2 | 4.3 | answered |
| 2 | doc-history * | lasso-first | **no** | 6960 | 1920 | 712 | 3 | 8 | lasso_suggest×2 Grep×3 Glob×1 Read×2 | 7.9 | answered |
| 2 | doc-history * | direct | **no** | 20177 | 11008 | 560 | 4 | 6 | Grep×3 Glob×1 Read×2 | 6.6 | answered |
| 2 | doc-multi-batch | lasso-first | yes | 53685 | 40064 | 1575 | 11 | 20 | lasso_suggest×8 Glob×1 Grep×8 Read×3 | 18.6 | answered |
| 2 | doc-multi-batch | direct | yes | 19170 | 10752 | 655 | 4 | 9 | Grep×4 Glob×1 Read×4 | 6.3 | answered |
| 2 | doc-multi-batch | lasso | yes | 586598 | 506880 | 1254 | 10 | 18 | lasso_suggest×1 Grep×11 Read×6 | 14.9 | answered |

\* capability task: needs history direct tools cannot reach.

