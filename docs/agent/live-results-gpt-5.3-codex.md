# Lasso agent benchmark: live model runs

Generated 2026-10-27T21:54:07.412Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 2 run(s); spent $1.689 of a $2.4 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.3-codex

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 31/32 | 219,830 | 208,038 | 19,968 | 11,792 | 2,806 | 90 | 96 | $0.4977 | 219 s |
| lasso | 32/32 | 237,676 | 224,870 | 72,576 | 12,806 | 3,031 | 93 | 102 | $0.4585 | 216.9 s |
| lasso-first | 30/32 | 247,818 | 234,000 | 99,840 | 13,818 | 3,833 | 108 | 93 | $0.4457 | 252.4 s |

- **lasso**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **-8.1%** (code -40.9%, docs -1%); per-task ratio min 0.56, median 1.58, max 3.57; more tokens than direct on 28 of 32. Used Lasso on 1 of 32 tasks, also needing file tools on 0 of those (Read ×47, Glob ×21, Grep ×33, lasso_inspect ×1).
- **lasso-first**: S = 1 − ΣT/ΣT_direct over 32 paired tasks = **-12.7%** (code -35.7%, docs -7.8%); per-task ratio min 0.13, median 1.66, max 32.43; more tokens than direct on 25 of 32. Used Lasso on 26 of 32 tasks, also needing file tools on 12 of those (Read ×14, lasso_inspect ×26, Glob ×11, lasso_suggest ×27, Grep ×15).
- First-call input (instructions + tool definitions + request), median: direct 424, lasso 784, lasso-first 807 tokens. Lasso's definitions and instructions cost **360 tokens per call** in this model's tokenizer (offline estimate: 838).
- Capability tasks (not in S): code-stale-reference run 1 lasso-first wrong; code-stale-reference run 1 direct wrong; code-stale-reference run 1 lasso wrong; doc-history run 1 lasso correct; doc-history run 1 lasso-first wrong; doc-history run 1 direct wrong; code-stale-reference run 2 lasso wrong; code-stale-reference run 2 direct wrong; code-stale-reference run 2 lasso-first wrong; doc-history run 2 lasso wrong; doc-history run 2 lasso-first wrong; doc-history run 2 direct wrong.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | code-range-known | lasso | yes | 2123 | 0 | 324 | 2 | 1 | Read×1 | 5.2 | answered |
| 1 | code-range-known | lasso-first | yes | 2032 | 0 | 192 | 2 | 1 | Read×1 | 3.8 | answered |
| 1 | code-range-known | direct | yes | 1274 | 0 | 196 | 2 | 1 | Read×1 | 3.5 | answered |
| 1 | code-duplicate-named | lasso-first | yes | 5073 | 2176 | 334 | 4 | 3 | lasso_inspect×3 | 7.0 | answered |
| 1 | code-duplicate-named | direct | **no** | 1791 | 0 | 321 | 3 | 2 | Read×1 Glob×1 | 7.5 | answered |
| 1 | code-duplicate-named | lasso | yes | 4231 | 0 | 456 | 4 | 3 | Read×2 Glob×1 | 9.3 | answered |
| 1 | code-duplicate-ambiguous | lasso-first | yes | 1906 | 0 | 187 | 2 | 1 | Glob×1 | 4.1 | answered |
| 1 | code-duplicate-ambiguous | direct | yes | 1057 | 0 | 156 | 2 | 1 | Glob×1 | 3.4 | answered |
| 1 | code-duplicate-ambiguous | lasso | yes | 1811 | 0 | 164 | 2 | 1 | Glob×1 | 3.3 | answered |
| 1 | code-function-lookup | lasso | yes | 4737 | 0 | 387 | 3 | 2 | Grep×1 Read×1 | 6.3 | answered |
| 1 | code-function-lookup | direct | yes | 3003 | 0 | 348 | 3 | 2 | Grep×1 Read×1 | 7.4 | answered |
| 1 | code-function-lookup | lasso-first | yes | 3882 | 0 | 612 | 3 | 2 | lasso_suggest×1 lasso_inspect×1 | 10.7 | answered |
| 1 | code-multi-function | lasso | yes | 8650 | 1280 | 1188 | 3 | 5 | Grep×1 Glob×1 Read×3 | 13.6 | answered |
| 1 | code-multi-function | direct | yes | 7405 | 0 | 1080 | 3 | 5 | Grep×1 Glob×1 Read×3 | 12.5 | answered |
| 1 | code-multi-function | lasso-first | yes | 3749 | 0 | 1022 | 2 | 1 | lasso_inspect×1 | 10.4 | answered |
| 1 | code-config-key | lasso | yes | 1784 | 0 | 139 | 2 | 1 | Grep×1 | 3.3 | answered |
| 1 | code-config-key | lasso-first | yes | 4404 | 1536 | 208 | 3 | 2 | lasso_suggest×1 Grep×1 | 5.6 | answered |
| 1 | code-config-key | direct | yes | 1065 | 0 | 143 | 2 | 1 | Grep×1 | 4.4 | answered |
| 1 | code-repeated-inspections | lasso | yes | 3735 | 0 | 1015 | 2 | 5 | Read×5 | 11.1 | answered |
| 1 | code-repeated-inspections | lasso-first | yes | 3624 | 0 | 910 | 2 | 5 | Read×5 | 10.0 | answered |
| 1 | code-repeated-inspections | direct | yes | 2841 | 0 | 905 | 2 | 5 | Read×5 | 9.2 | answered |
| 1 | code-stale-reference * | lasso-first | **no** | 8424 | 3200 | 638 | 4 | 3 | lasso_inspect×3 | 11.7 | answered |
| 1 | code-stale-reference * | direct | **no** | 2868 | 0 | 524 | 3 | 2 | Read×1 Grep×1 | 8.9 | answered |
| 1 | code-stale-reference * | lasso | **no** | 5510 | 1280 | 661 | 4 | 3 | lasso_inspect×2 lasso_suggest×1 | 11.6 | answered |
| 1 | code-modified-on-disk | lasso-first | **no** | 1930 | 0 | 134 | 2 | 1 | lasso_inspect×1 | 3.3 | answered |
| 1 | code-modified-on-disk | direct | yes | 1079 | 0 | 125 | 2 | 1 | Read×1 | 3.2 | answered |
| 1 | code-modified-on-disk | lasso | yes | 1755 | 0 | 91 | 2 | 1 | Read×1 | 2.5 | answered |
| 1 | doc-short-file | lasso | yes | 1734 | 0 | 67 | 2 | 1 | Read×1 | 2.4 | answered |
| 1 | doc-short-file | direct | yes | 1014 | 0 | 67 | 2 | 1 | Read×1 | 2.4 | answered |
| 1 | doc-short-file | lasso-first | yes | 5634 | 1024 | 288 | 5 | 4 | lasso_inspect×4 | 7.6 | answered |
| 1 | doc-long-fact | lasso | yes | 43343 | 27008 | 472 | 5 | 5 | Glob×1 Grep×3 Read×1 | 9.8 | answered |
| 1 | doc-long-fact | lasso-first | yes | 3892 | 1152 | 230 | 3 | 2 | lasso_suggest×1 lasso_inspect×1 | 5.9 | answered |
| 1 | doc-long-fact | direct | yes | 20997 | 13312 | 457 | 5 | 5 | Grep×2 Glob×1 Read×2 | 9.6 | answered |
| 1 | doc-large-table | lasso | yes | 1798 | 0 | 145 | 2 | 1 | Grep×1 | 3.6 | answered |
| 1 | doc-large-table | lasso-first | yes | 4891 | 1024 | 393 | 4 | 5 | lasso_suggest×1 Glob×1 Grep×2 Read×1 | 8.4 | answered |
| 1 | doc-large-table | direct | yes | 2299 | 0 | 251 | 3 | 4 | Glob×1 Grep×1 Read×2 | 6.3 | answered |
| 1 | doc-identifier | lasso-first | yes | 4202 | 0 | 278 | 4 | 4 | lasso_suggest×1 Glob×1 Grep×2 | 7.1 | answered |
| 1 | doc-identifier | direct | yes | 1101 | 0 | 149 | 2 | 1 | Grep×1 | 3.7 | answered |
| 1 | doc-identifier | lasso | yes | 1815 | 0 | 136 | 2 | 1 | Grep×1 | 3.1 | answered |
| 1 | doc-ambiguous-sources | lasso-first | yes | 2943 | 0 | 253 | 2 | 1 | lasso_suggest×1 | 4.7 | answered |
| 1 | doc-ambiguous-sources | direct | yes | 14827 | 0 | 498 | 3 | 5 | Glob×1 Grep×1 Read×3 | 8.4 | answered |
| 1 | doc-ambiguous-sources | lasso | yes | 16891 | 1408 | 417 | 3 | 5 | Grep×1 Glob×1 Read×3 | 7.8 | answered |
| 1 | doc-related-facts | lasso | yes | 3864 | 0 | 239 | 3 | 3 | Glob×1 Grep×1 Read×1 | 5.8 | answered |
| 1 | doc-related-facts | direct | yes | 2799 | 0 | 259 | 3 | 3 | Grep×1 Glob×1 Read×1 | 5.7 | answered |
| 1 | doc-related-facts | lasso-first | yes | 17318 | 10880 | 483 | 6 | 5 | lasso_suggest×2 lasso_inspect×1 Glob×1 Read×1 | 10.9 | answered |
| 1 | doc-missing | lasso | yes | 11653 | 1280 | 469 | 5 | 6 | Grep×2 Glob×4 | 10.6 | answered |
| 1 | doc-missing | direct | yes | 17032 | 0 | 617 | 5 | 6 | Grep×3 Read×3 | 12.9 | answered |
| 1 | doc-missing | lasso-first | yes | 14368 | 8448 | 660 | 6 | 7 | lasso_suggest×3 lasso_inspect×3 Grep×1 | 13.5 | answered |
| 1 | doc-history * | lasso | yes | 76951 | 57472 | 908 | 7 | 9 | Glob×1 Grep×2 Read×4 lasso_suggest×1 lasso_inspect×1 | 17.8 | answered |
| 1 | doc-history * | lasso-first | **no** | 50818 | 38528 | 1221 | 11 | 13 | lasso_suggest×3 lasso_inspect×2 Glob×2 Read×5 Grep×1 | 25.0 | answered |
| 1 | doc-history * | direct | **no** | 13490 | 8320 | 686 | 5 | 5 | Grep×3 Glob×1 Read×1 | 12.8 | answered |
| 1 | doc-multi-batch | lasso | yes | 7842 | 1792 | 534 | 3 | 8 | Grep×1 Glob×1 Read×6 | 8.7 | answered |
| 1 | doc-multi-batch | lasso-first | yes | 14477 | 6656 | 738 | 4 | 3 | lasso_suggest×2 lasso_inspect×1 | 13.1 | answered |
| 1 | doc-multi-batch | direct | yes | 6254 | 1408 | 551 | 3 | 6 | Grep×1 Glob×1 Read×4 | 9.3 | answered |
| 2 | code-range-known | lasso-first | yes | 2026 | 0 | 189 | 2 | 1 | Read×1 | 4.2 | answered |
| 2 | code-range-known | direct | yes | 1272 | 0 | 195 | 2 | 1 | Read×1 | 3.4 | answered |
| 2 | code-range-known | lasso | yes | 2091 | 0 | 293 | 2 | 1 | Read×1 | 4.2 | answered |
| 2 | code-duplicate-named | lasso | yes | 4113 | 0 | 414 | 4 | 3 | Read×2 Glob×1 | 7.9 | answered |
| 2 | code-duplicate-named | direct | yes | 2661 | 0 | 407 | 4 | 3 | Read×2 Glob×1 | 7.5 | answered |
| 2 | code-duplicate-named | lasso-first | yes | 4414 | 0 | 428 | 4 | 3 | lasso_inspect×2 Glob×1 | 8.5 | answered |
| 2 | code-duplicate-ambiguous | lasso | yes | 1806 | 0 | 161 | 2 | 1 | Glob×1 | 3.6 | answered |
| 2 | code-duplicate-ambiguous | direct | yes | 1070 | 0 | 151 | 2 | 1 | Glob×1 | 3.8 | answered |
| 2 | code-duplicate-ambiguous | lasso-first | yes | 1846 | 0 | 156 | 2 | 1 | Glob×1 | 3.4 | answered |
| 2 | code-function-lookup | lasso | yes | 4116 | 0 | 375 | 3 | 2 | Grep×1 Read×1 | 6.3 | answered |
| 2 | code-function-lookup | lasso-first | yes | 4411 | 1280 | 424 | 3 | 3 | lasso_suggest×1 Glob×1 lasso_inspect×1 | 7.9 | answered |
| 2 | code-function-lookup | direct | yes | 3039 | 0 | 365 | 3 | 2 | Grep×1 Read×1 | 5.8 | answered |
| 2 | code-multi-function | lasso | yes | 7003 | 0 | 1153 | 3 | 6 | Grep×3 Read×3 | 12.0 | answered |
| 2 | code-multi-function | lasso-first | yes | 3800 | 0 | 1063 | 2 | 1 | lasso_inspect×1 | 11.3 | answered |
| 2 | code-multi-function | direct | yes | 6554 | 0 | 1055 | 3 | 4 | Grep×1 Read×3 | 11.6 | answered |
| 2 | code-config-key | lasso-first | yes | 4471 | 1536 | 238 | 3 | 2 | lasso_suggest×1 Grep×1 | 5.8 | answered |
| 2 | code-config-key | direct | yes | 1057 | 0 | 142 | 2 | 1 | Grep×1 | 3.3 | answered |
| 2 | code-config-key | lasso | yes | 1792 | 0 | 150 | 2 | 1 | Grep×1 | 3.3 | answered |
| 2 | code-repeated-inspections | lasso-first | yes | 3578 | 0 | 921 | 2 | 1 | lasso_inspect×1 | 9.8 | answered |
| 2 | code-repeated-inspections | direct | yes | 2856 | 0 | 915 | 2 | 5 | Read×5 | 9.0 | answered |
| 2 | code-repeated-inspections | lasso | yes | 3543 | 0 | 934 | 2 | 1 | lasso_inspect×1 | 9.7 | answered |
| 2 | code-stale-reference * | lasso | **no** | 7318 | 2176 | 527 | 4 | 3 | lasso_inspect×3 | 10.7 | answered |
| 2 | code-stale-reference * | direct | **no** | 1532 | 0 | 393 | 2 | 1 | Read×1 | 6.1 | answered |
| 2 | code-stale-reference * | lasso-first | **no** | 12043 | 6656 | 602 | 5 | 4 | lasso_inspect×3 Grep×1 | 11.8 | answered |
| 2 | code-modified-on-disk | lasso | yes | 1798 | 0 | 126 | 2 | 1 | Read×1 | 3.4 | answered |
| 2 | code-modified-on-disk | direct | yes | 1079 | 0 | 128 | 2 | 1 | Read×1 | 4.7 | answered |
| 2 | code-modified-on-disk | lasso-first | **no** | 1921 | 0 | 127 | 2 | 1 | lasso_inspect×1 | 3.2 | answered |
| 2 | doc-short-file | lasso | yes | 1733 | 0 | 66 | 2 | 1 | Read×1 | 2.5 | answered |
| 2 | doc-short-file | lasso-first | yes | 1820 | 0 | 87 | 2 | 1 | Read×1 | 2.5 | answered |
| 2 | doc-short-file | direct | yes | 1014 | 0 | 67 | 2 | 1 | Read×1 | 2.6 | answered |
| 2 | doc-long-fact | lasso | yes | 9896 | 2304 | 331 | 3 | 3 | Grep×2 Glob×1 | 6.4 | answered |
| 2 | doc-long-fact | lasso-first | yes | 3766 | 1152 | 226 | 3 | 2 | lasso_suggest×1 Glob×1 | 5.9 | answered |
| 2 | doc-long-fact | direct | yes | 2772 | 0 | 214 | 3 | 2 | Grep×1 Glob×1 | 5.6 | answered |
| 2 | doc-large-table | lasso-first | yes | 56524 | 26496 | 361 | 5 | 5 | lasso_suggest×1 Glob×1 Grep×2 Read×1 | 9.0 | answered |
| 2 | doc-large-table | direct | yes | 1743 | 0 | 151 | 3 | 2 | Grep×1 Read×1 | 4.7 | answered |
| 2 | doc-large-table | lasso | yes | 2854 | 0 | 169 | 3 | 2 | Grep×1 Read×1 | 4.5 | answered |
| 2 | doc-identifier | lasso-first | yes | 4093 | 0 | 194 | 3 | 2 | lasso_suggest×1 lasso_inspect×1 | 5.1 | answered |
| 2 | doc-identifier | direct | yes | 1083 | 0 | 131 | 2 | 1 | Grep×1 | 3.0 | answered |
| 2 | doc-identifier | lasso | yes | 1808 | 0 | 134 | 2 | 1 | Grep×1 | 3.2 | answered |
| 2 | doc-ambiguous-sources | lasso | yes | 15429 | 0 | 311 | 3 | 4 | Glob×1 Read×3 | 8.1 | answered |
| 2 | doc-ambiguous-sources | direct | yes | 20191 | 0 | 386 | 3 | 5 | Glob×1 Grep×1 Read×3 | 7.1 | answered |
| 2 | doc-ambiguous-sources | lasso-first | yes | 2707 | 0 | 264 | 2 | 1 | lasso_suggest×1 | 4.9 | answered |
| 2 | doc-related-facts | lasso | yes | 4078 | 0 | 362 | 3 | 4 | Grep×3 Read×1 | 6.6 | answered |
| 2 | doc-related-facts | direct | yes | 3392 | 0 | 233 | 3 | 3 | Glob×1 Grep×1 Read×1 | 4.7 | answered |
| 2 | doc-related-facts | lasso-first | yes | 10207 | 3456 | 317 | 5 | 5 | lasso_suggest×2 Glob×2 Read×1 | 8.1 | answered |
| 2 | doc-missing | lasso | yes | 41498 | 28416 | 697 | 6 | 7 | Glob×1 Grep×4 Read×2 | 13.9 | answered |
| 2 | doc-missing | lasso-first | yes | 34355 | 26496 | 1199 | 10 | 13 | lasso_suggest×3 lasso_inspect×2 Grep×6 Read×2 | 24.1 | answered |
| 2 | doc-missing | direct | yes | 73509 | 0 | 568 | 5 | 9 | Glob×1 Grep×3 Read×5 | 13.2 | answered |
| 2 | doc-history * | lasso | **no** | 10447 | 4480 | 587 | 4 | 5 | Grep×1 Glob×2 Read×2 | 10.9 | answered |
| 2 | doc-history * | lasso-first | **no** | 44296 | 28032 | 1069 | 9 | 10 | lasso_suggest×3 lasso_inspect×3 Read×2 Glob×1 Grep×1 | 20.8 | answered |
| 2 | doc-history * | direct | **no** | 13895 | 8320 | 629 | 6 | 8 | Grep×2 Glob×4 Read×2 | 12.5 | answered |
| 2 | doc-multi-batch | lasso-first | yes | 13554 | 6528 | 702 | 4 | 4 | lasso_suggest×3 lasso_inspect×1 | 12.7 | answered |
| 2 | doc-multi-batch | direct | yes | 10700 | 5248 | 561 | 4 | 6 | Grep×2 Glob×1 Read×3 | 19.6 | answered |
| 2 | doc-multi-batch | lasso | yes | 16352 | 9088 | 887 | 6 | 15 | Grep×4 Glob×5 Read×6 | 15.1 | answered |

\* capability task: needs history direct tools cannot reach.

