# Lasso agent benchmark: live model runs

Generated 2026-11-12T20:33:31.410Z by `node scripts/agent-benchmark-live.mjs`. Models gpt-5.4-mini; families lookup, scale, geometry, writing, documents (sets heldout2, heldout3); reasoning effort low; 1 run(s); spent $1.168 of a $1.6 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), whether read at full price, from cache or written to it; output includes reasoning. Claude runs use automatic prompt caching, as hosts do; OpenAI caches by itself. The model chose its own steps.

## gpt-5.4-mini: lookup

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 15/16 | 76,175 | 70,367 | 25,984 | 0 | 5,808 | 738 | 44 | 56 | $0.0614 | 72.1 s |
| lasso-before | 16/16 | 32,459 | 28,071 | 0 | 0 | 4,388 | 898 | 34 | 19 | $0.0408 | 54.9 s |
| lasso | 16/16 | 30,481 | 26,365 | 0 | 0 | 4,116 | 730 | 33 | 17 | $0.0383 | 51.8 s |

- **lasso-before** vs direct tools: S = 1 − ΣT/ΣT_direct over 16 paired tasks = **57.4%**; per-task ratio min 0.12, median 0.84, max 2.35; more tokens on 6 of 16. Used Lasso on 16 of 16 tasks, also needing file tools on 2.
- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 16 paired tasks = **60%**; per-task ratio min 0.11, median 0.84, max 1.44; more tokens on 6 of 16. Used Lasso on 16 of 16 tasks, also needing file tools on 0.

## gpt-5.4-mini: scale

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 4/7 | 1,428,336 | 1,424,986 | 1,187,712 | 0 | 3,350 | 1,603 | 44 | 39 | $0.2821 | 64.3 s |
| lasso-before | 7/7 | 28,659 | 27,608 | 0 | 0 | 1,051 | 273 | 15 | 8 | $0.0254 | 20.2 s |
| lasso | 7/7 | 28,323 | 27,393 | 0 | 0 | 930 | 220 | 15 | 8 | $0.0247 | 20.3 s |

- **lasso-before** vs direct tools: S = 1 − ΣT/ΣT_direct over 7 paired tasks = **98%**; per-task ratio min 0, median 0.03, max 0.56; more tokens on 0 of 7. Used Lasso on 7 of 7 tasks, also needing file tools on 1.
- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 7 paired tasks = **98%**; per-task ratio min 0, median 0.03, max 0.56; more tokens on 0 of 7. Used Lasso on 7 of 7 tasks, also needing file tools on 1.

## gpt-5.4-mini: geometry

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 5/5 | 30,686 | 28,651 | 5,120 | 0 | 2,035 | 739 | 16 | 20 | $0.0272 | 25.3 s |
| lasso-before | 5/5 | 11,651 | 10,644 | 1,280 | 0 | 1,007 | 322 | 12 | 8 | $0.0117 | 18.3 s |
| lasso | 5/5 | 9,301 | 8,430 | 0 | 0 | 871 | 239 | 11 | 6 | $0.0102 | 16.3 s |

- **lasso-before** vs direct tools: S = 1 − ΣT/ΣT_direct over 5 paired tasks = **62%**; per-task ratio min 0.16, median 0.38, max 0.71; more tokens on 0 of 5. Used Lasso on 5 of 5 tasks, also needing file tools on 1.
- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 5 paired tasks = **69.7%**; per-task ratio min 0.17, median 0.38, max 0.4; more tokens on 0 of 5. Used Lasso on 5 of 5 tasks, also needing file tools on 1.

## gpt-5.4-mini: writing

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 9/12 | 199,841 | 191,916 | 107,392 | 0 | 7,925 | 2,809 | 48 | 86 | $0.1071 | 86.9 s |
| lasso-before | 7/12 | 33,524 | 29,390 | 2,432 | 0 | 4,134 | 1,823 | 29 | 19 | $0.0390 | 49.5 s |
| lasso | 10/12 | 31,856 | 28,247 | 2,304 | 0 | 3,609 | 1,307 | 29 | 19 | $0.0359 | 48 s |

- **lasso-before** vs direct tools: S = 1 − ΣT/ΣT_direct over 12 paired tasks = **83.2%**; per-task ratio min 0.03, median 0.78, max 1.37; more tokens on 4 of 12. Used Lasso on 12 of 12 tasks, also needing file tools on 2.
- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 12 paired tasks = **84.1%**; per-task ratio min 0.03, median 0.75, max 1.59; more tokens on 4 of 12. Used Lasso on 12 of 12 tasks, also needing file tools on 3.

## gpt-5.4-mini: documents/heldout2

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 8/18 | 115,120 | 108,559 | 21,760 | 0 | 6,561 | 1,535 | 60 | 72 | $0.0963 | 94 s |
| lasso-before | 9/18 | 85,949 | 80,525 | 15,488 | 0 | 5,424 | 1,906 | 43 | 28 | $0.0743 | 73.5 s |
| lasso | 11/18 | 115,141 | 110,237 | 48,384 | 0 | 4,904 | 1,495 | 46 | 30 | $0.0721 | 73.5 s |

- **lasso-before** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **25.3%**; per-task ratio min 0.36, median 0.69, max 2.33; more tokens on 2 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 2.
- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **0%**; per-task ratio min 0.22, median 0.54, max 7.42; more tokens on 3 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 3.

## gpt-5.4-mini: documents/heldout3

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 11/18 | 84,952 | 78,508 | 15,872 | 0 | 6,444 | 1,364 | 58 | 72 | $0.0772 | 87.6 s |
| lasso-before | 11/18 | 61,054 | 56,116 | 6,912 | 0 | 4,938 | 1,504 | 42 | 25 | $0.0596 | 69.5 s |
| lasso | 12/18 | 70,132 | 65,055 | 7,296 | 0 | 5,077 | 1,404 | 43 | 29 | $0.0667 | 70 s |

- **lasso-before** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **28.1%**; per-task ratio min 0.3, median 0.57, max 2.59; more tokens on 5 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 2.
- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **17.4%**; per-task ratio min 0.31, median 0.68, max 3.4; more tokens on 6 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 5.

## By kind of file

Tasks grouped by the files their answer is in. Each arm: correct answers, then tokens. Savings are 1 − ΣT_lasso / ΣT_other over the tasks both arms ran.

| Model | Kind of file | Tasks | direct | lasso | upload | Lasso vs direct | Lasso vs upload |
|---|---|---|---|---|---|---|---|
| gpt-5.4-mini | 3D model | 8 | 6/8, 204,271 | 7/8, 16,578 | – | 91.9% | – |
| gpt-5.4-mini | Excel | 11 | 7/11, 1,369,100 | 10/11, 73,821 | – | 94.6% | – |
| gpt-5.4-mini | PDF | 24 | 12/24, 202,466 | 14/24, 108,282 | – | 46.5% | – |
| gpt-5.4-mini | Word | 2 | 2/2, 4,908 | 2/2, 4,415 | – | 10% | – |
| gpt-5.4-mini | mixed (PDF + Excel) | 2 | 1/2, 16,672 | 1/2, 7,213 | – | 56.7% | – |
| gpt-5.4-mini | mixed (Word + PDF) | 7 | 3/7, 35,947 | 5/7, 20,162 | – | 43.9% | – |
| gpt-5.4-mini | mixed (Word + notes + PDF + Excel) | 2 | 2/2, 12,149 | 2/2, 10,386 | – | 14.5% | – |
| gpt-5.4-mini | mixed (notes + PDF) | 2 | 2/2, 8,380 | 2/2, 7,963 | – | 5% | – |
| gpt-5.4-mini | notes | 2 | 2/2, 5,042 | 2/2, 5,933 | – | -17.7% | – |

| Run | Model | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gpt-5.4-mini | code-range-known | lasso-before | yes | 2983 | 0 | 384 | 3 | 2 | lasso×1 Read×1 | 5.6 | answered |
| 1 | gpt-5.4-mini | code-range-known | lasso | yes | 1626 | 0 | 206 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | code-range-known | direct | yes | 1270 | 0 | 203 | 2 | 1 | Read×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | code-duplicate-named | lasso | yes | 1558 | 0 | 181 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | code-duplicate-named | direct | **no** | 1790 | 0 | 229 | 3 | 2 | Glob×1 Read×1 | 4.3 | answered |
| 1 | gpt-5.4-mini | code-duplicate-named | lasso-before | yes | 1596 | 0 | 210 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | code-duplicate-ambiguous | lasso | yes | 1483 | 0 | 141 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | code-duplicate-ambiguous | direct | yes | 1058 | 0 | 142 | 2 | 1 | Glob×1 | 3.7 | answered |
| 1 | gpt-5.4-mini | code-duplicate-ambiguous | lasso-before | yes | 1472 | 0 | 148 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | code-function-lookup | lasso-before | yes | 1768 | 0 | 271 | 2 | 1 | lasso×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | code-function-lookup | direct | yes | 3973 | 0 | 397 | 3 | 3 | Grep×2 Read×1 | 5.1 | answered |
| 1 | gpt-5.4-mini | code-function-lookup | lasso | yes | 1773 | 0 | 284 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | code-multi-function | lasso-before | yes | 3259 | 0 | 968 | 2 | 1 | lasso×1 | 6.1 | answered |
| 1 | gpt-5.4-mini | code-multi-function | direct | yes | 10339 | 3584 | 1223 | 4 | 7 | Grep×3 Read×4 | 9.8 | answered |
| 1 | gpt-5.4-mini | code-multi-function | lasso | yes | 3185 | 0 | 932 | 2 | 1 | lasso×1 | 6.0 | answered |
| 1 | gpt-5.4-mini | code-config-key | lasso-before | yes | 1418 | 0 | 108 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | code-config-key | lasso | yes | 1420 | 0 | 120 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | code-config-key | direct | yes | 1463 | 0 | 141 | 2 | 2 | Grep×1 Glob×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | code-repeated-inspections | lasso-before | yes | 2918 | 0 | 783 | 2 | 1 | lasso×1 | 5.2 | answered |
| 1 | gpt-5.4-mini | code-repeated-inspections | lasso | yes | 2914 | 0 | 819 | 2 | 1 | lasso×1 | 5.5 | answered |
| 1 | gpt-5.4-mini | code-repeated-inspections | direct | yes | 3473 | 0 | 903 | 3 | 5 | Read×5 | 7.2 | answered |
| 1 | gpt-5.4-mini | code-stale-reference * | lasso | yes | 1771 | 0 | 282 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | code-stale-reference * | direct | **no** | 3431 | 0 | 532 | 4 | 4 | Grep×2 Glob×1 Read×1 | 6.6 | answered |
| 1 | gpt-5.4-mini | code-stale-reference * | lasso-before | yes | 1871 | 0 | 363 | 2 | 1 | lasso×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | code-modified-on-disk | lasso | yes | 1478 | 0 | 126 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | code-modified-on-disk | direct | yes | 1029 | 0 | 83 | 2 | 1 | Read×1 | 2.2 | answered |
| 1 | gpt-5.4-mini | code-modified-on-disk | lasso-before | yes | 1475 | 0 | 118 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | doc-short-file | lasso-before | yes | 1437 | 0 | 94 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | doc-short-file | direct | yes | 1020 | 0 | 64 | 2 | 1 | Read×1 | 1.9 | answered |
| 1 | gpt-5.4-mini | doc-short-file | lasso | yes | 1421 | 0 | 94 | 2 | 1 | lasso×1 | 2.1 | answered |
| 1 | gpt-5.4-mini | doc-long-fact | lasso-before | yes | 1605 | 0 | 136 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | doc-long-fact | lasso | yes | 1593 | 0 | 157 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | doc-long-fact | direct | yes | 10288 | 5376 | 343 | 4 | 5 | Grep×5 | 5.9 | answered |
| 1 | gpt-5.4-mini | doc-large-table | lasso-before | yes | 1402 | 0 | 91 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | doc-large-table | lasso | yes | 1409 | 0 | 100 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | doc-large-table | direct | yes | 1162 | 0 | 143 | 2 | 2 | Grep×2 | 2.7 | answered |
| 1 | gpt-5.4-mini | doc-identifier | lasso | yes | 1397 | 0 | 92 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | doc-identifier | direct | yes | 1204 | 0 | 164 | 2 | 2 | Grep×2 | 3.0 | answered |
| 1 | gpt-5.4-mini | doc-identifier | lasso-before | yes | 1458 | 0 | 117 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | doc-ambiguous-sources | lasso | yes | 1560 | 0 | 189 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | doc-ambiguous-sources | direct | yes | 3815 | 0 | 293 | 2 | 3 | Grep×3 | 2.9 | answered |
| 1 | gpt-5.4-mini | doc-ambiguous-sources | lasso-before | yes | 1581 | 0 | 200 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | doc-related-facts | lasso-before | yes | 1559 | 0 | 132 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | doc-related-facts | direct | yes | 2130 | 0 | 176 | 2 | 2 | Grep×1 Glob×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | doc-related-facts | lasso | yes | 1525 | 0 | 133 | 2 | 1 | lasso×1 | 2.0 | answered |
| 1 | gpt-5.4-mini | doc-missing | lasso-before | yes | 4122 | 0 | 320 | 3 | 3 | lasso×1 Grep×2 | 4.6 | answered |
| 1 | gpt-5.4-mini | doc-missing | direct | yes | 11403 | 5632 | 537 | 4 | 9 | Grep×5 Glob×1 Read×3 | 6.8 | answered |
| 1 | gpt-5.4-mini | doc-missing | lasso | yes | 3923 | 0 | 266 | 3 | 2 | lasso×2 | 4.6 | answered |
| 1 | gpt-5.4-mini | doc-history * | lasso-before | yes | 1693 | 0 | 203 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | doc-history * | lasso | yes | 1671 | 0 | 178 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | doc-history * | direct | **no** | 6294 | 2176 | 301 | 3 | 4 | Grep×1 Glob×1 Read×2 | 4.2 | answered |
| 1 | gpt-5.4-mini | doc-multi-batch | lasso-before | yes | 2406 | 0 | 308 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | doc-multi-batch | lasso | yes | 2216 | 0 | 276 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | doc-multi-batch | direct | yes | 20758 | 11392 | 767 | 5 | 10 | Grep×4 Glob×1 Read×5 | 8.8 | answered |
| 1 | gpt-5.4-mini | scale/invoice-lookup | lasso-before | yes | 1584 | 0 | 153 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | scale/invoice-lookup | lasso | yes | 1507 | 0 | 116 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | scale/invoice-lookup | direct | yes | 58011 | 28544 | 163 | 3 | 2 | Read×1 Grep×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | scale/amount-total | lasso | yes | 1460 | 0 | 99 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | scale/amount-total | direct | **no** | 116897 | 86272 | 735 | 5 | 5 | Read×1 Grep×4 | 9.4 | answered |
| 1 | gpt-5.4-mini | scale/amount-total | lasso-before | yes | 1462 | 0 | 100 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | scale/west-total | lasso | yes | 1476 | 0 | 106 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | scale/west-total | direct | **no** | 543674 | 490112 | 868 | 14 | 14 | Glob×1 Read×13 | 19.6 | turns |
| 1 | gpt-5.4-mini | scale/west-total | lasso-before | yes | 1484 | 0 | 109 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | scale/largest-invoice | lasso-before | yes | 1541 | 0 | 139 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | scale/largest-invoice | direct | **no** | 623046 | 549504 | 1006 | 13 | 12 | Read×12 | 19.8 | answered |
| 1 | gpt-5.4-mini | scale/largest-invoice | lasso | yes | 1498 | 0 | 115 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | scale/warranty-reserve | lasso-before | yes | 1603 | 0 | 106 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | scale/warranty-reserve | direct | yes | 34365 | 16640 | 170 | 3 | 2 | Read×1 Grep×1 | 4.0 | answered |
| 1 | gpt-5.4-mini | scale/warranty-reserve | lasso | yes | 1589 | 0 | 117 | 2 | 1 | lasso×1 | 2.3 | answered |
| 1 | gpt-5.4-mini | scale/lowest-churn | lasso-before | yes | 1669 | 0 | 137 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | scale/lowest-churn | lasso | yes | 1625 | 0 | 126 | 2 | 1 | lasso×1 | 2.3 | answered |
| 1 | gpt-5.4-mini | scale/lowest-churn | direct | yes | 17994 | 0 | 176 | 3 | 2 | Glob×1 Read×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | scale/emissions-absent | lasso-before | yes | 19316 | 0 | 307 | 3 | 2 | lasso×1 Read×1 | 4.5 | answered |
| 1 | gpt-5.4-mini | scale/emissions-absent | lasso | yes | 19168 | 0 | 251 | 3 | 2 | lasso×1 Read×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | scale/emissions-absent | direct | yes | 34349 | 16640 | 232 | 3 | 2 | Read×1 Grep×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | geometry/fixture-pin-distance | lasso-before | yes | 1554 | 0 | 129 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | geometry/fixture-pin-distance | lasso | yes | 1577 | 0 | 162 | 2 | 1 | lasso×1 | 3.9 | answered |
| 1 | gpt-5.4-mini | geometry/fixture-pin-distance | direct | yes | 4854 | 0 | 345 | 3 | 3 | Grep×2 Read×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | geometry/flange-opposite-bolts | lasso | yes | 1547 | 0 | 130 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | geometry/flange-opposite-bolts | direct | yes | 4003 | 0 | 270 | 3 | 3 | Grep×2 Read×1 | 4.6 | answered |
| 1 | gpt-5.4-mini | geometry/flange-opposite-bolts | lasso-before | yes | 1523 | 0 | 109 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | geometry/flange-bolt-pose | lasso | yes | 1799 | 0 | 203 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | geometry/flange-bolt-pose | direct | yes | 10526 | 2816 | 595 | 3 | 4 | Grep×2 Read×2 | 6.0 | answered |
| 1 | gpt-5.4-mini | geometry/flange-bolt-pose | lasso-before | yes | 1729 | 0 | 240 | 2 | 1 | lasso×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-tilt | lasso-before | yes | 1586 | 0 | 127 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-tilt | direct | yes | 3906 | 1024 | 401 | 3 | 5 | Grep×3 Read×2 | 4.7 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-tilt | lasso | yes | 1577 | 0 | 126 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-position | lasso-before | yes | 5259 | 1280 | 402 | 4 | 4 | lasso×1 Grep×2 Read×1 | 6.1 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-position | direct | yes | 7397 | 1280 | 424 | 4 | 5 | Glob×1 Grep×3 Read×1 | 5.9 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-position | lasso | yes | 2801 | 0 | 250 | 3 | 2 | lasso×1 Grep×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | writing/q4-revenue-email | lasso-before | yes | 3598 | 0 | 509 | 3 | 2 | lasso×2 | 6.0 | answered |
| 1 | gpt-5.4-mini | writing/q4-revenue-email | lasso | yes | 4184 | 1152 | 405 | 3 | 2 | lasso×2 | 5.3 | answered |
| 1 | gpt-5.4-mini | writing/q4-revenue-email | direct | yes | 2630 | 0 | 348 | 3 | 3 | Grep×2 Read×1 | 4.3 | answered |
| 1 | gpt-5.4-mini | writing/top-months-newsletter | lasso | yes | 1661 | 0 | 206 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | writing/top-months-newsletter | direct | yes | 2271 | 0 | 289 | 3 | 3 | Glob×1 Grep×1 Read×1 | 4.6 | answered |
| 1 | gpt-5.4-mini | writing/top-months-newsletter | lasso-before | **no** | 2272 | 0 | 316 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | writing/quarterly-margin-email | lasso | yes | 5335 | 1152 | 724 | 4 | 5 | lasso×1 Grep×3 Read×1 | 8.1 | answered |
| 1 | gpt-5.4-mini | writing/quarterly-margin-email | direct | yes | 7155 | 2688 | 1101 | 5 | 6 | Grep×5 Read×1 | 10.5 | answered |
| 1 | gpt-5.4-mini | writing/quarterly-margin-email | lasso-before | yes | 4641 | 1280 | 630 | 3 | 3 | lasso×1 Read×1 Grep×1 | 6.5 | answered |
| 1 | gpt-5.4-mini | writing/annual-total-line | lasso-before | yes | 2168 | 0 | 164 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | writing/annual-total-line | direct | yes | 2318 | 0 | 299 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.0 | answered |
| 1 | gpt-5.4-mini | writing/annual-total-line | lasso | yes | 1855 | 0 | 134 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | writing/budget-note | lasso-before | **no** | 2148 | 0 | 291 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | writing/budget-note | direct | **no** | 2462 | 0 | 357 | 3 | 4 | Grep×1 Glob×1 Read×2 | 4.5 | answered |
| 1 | gpt-5.4-mini | writing/budget-note | lasso | **no** | 2042 | 0 | 231 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | writing/q1-outlook-sentence | lasso-before | yes | 1681 | 0 | 181 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | writing/q1-outlook-sentence | lasso | yes | 1760 | 0 | 195 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | writing/q1-outlook-sentence | direct | yes | 1528 | 0 | 316 | 2 | 4 | Grep×4 | 3.5 | answered |
| 1 | gpt-5.4-mini | writing/west-region-email | lasso-before | **no** | 3493 | 0 | 575 | 3 | 3 | lasso×1 Grep×2 | 6.1 | answered |
| 1 | gpt-5.4-mini | writing/west-region-email | lasso | yes | 3327 | 0 | 477 | 3 | 2 | lasso×1 Read×1 | 6.0 | answered |
| 1 | gpt-5.4-mini | writing/west-region-email | direct | yes | 2984 | 0 | 673 | 3 | 5 | Grep×4 Read×1 | 6.1 | answered |
| 1 | gpt-5.4-mini | writing/supplier-bullets | lasso | yes | 2554 | 0 | 231 | 3 | 2 | lasso×1 Read×1 | 4.0 | answered |
| 1 | gpt-5.4-mini | writing/supplier-bullets | direct | yes | 2261 | 0 | 348 | 3 | 4 | Grep×3 Read×1 | 5.4 | answered |
| 1 | gpt-5.4-mini | writing/supplier-bullets | lasso-before | **no** | 1763 | 0 | 237 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | writing/meeting-actions-email | lasso | yes | 1861 | 0 | 256 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | writing/meeting-actions-email | direct | yes | 2647 | 0 | 467 | 3 | 6 | Grep×5 Read×1 | 5.4 | answered |
| 1 | gpt-5.4-mini | writing/meeting-actions-email | lasso-before | yes | 1922 | 0 | 277 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | writing/bracket-spec | lasso-before | yes | 4567 | 1152 | 423 | 4 | 3 | lasso×3 | 5.7 | answered |
| 1 | gpt-5.4-mini | writing/bracket-spec | direct | yes | 15627 | 3456 | 1135 | 7 | 13 | Grep×9 Read×2 Glob×2 | 11.9 | answered |
| 1 | gpt-5.4-mini | writing/bracket-spec | lasso | yes | 1977 | 0 | 187 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | writing/assembly-parts-email | lasso-before | yes | 2186 | 0 | 232 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | writing/assembly-parts-email | lasso | yes | 2161 | 0 | 208 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | writing/assembly-parts-email | direct | **no** | 34590 | 16256 | 841 | 6 | 9 | Grep×5 Glob×1 Read×3 | 11.3 | answered |
| 1 | gpt-5.4-mini | writing/house-rooms-brochure | lasso-before | **no** | 3085 | 0 | 299 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | writing/house-rooms-brochure | lasso | **no** | 3139 | 0 | 355 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | writing/house-rooms-brochure | direct | **no** | 123368 | 84992 | 1751 | 7 | 26 | Grep×10 Glob×1 Read×15 | 15.2 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | lasso-before | yes | 5187 | 0 | 410 | 2 | 1 | lasso×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | lasso | yes | 3531 | 0 | 332 | 2 | 1 | lasso×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | direct | **no** | 6937 | 0 | 536 | 3 | 4 | Grep×2 Read×2 | 6.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | lasso | **no** | 3614 | 0 | 282 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | direct | **no** | 8472 | 2048 | 399 | 3 | 3 | Glob×1 Grep×1 Read×1 | 8.2 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | lasso-before | **no** | 4806 | 0 | 400 | 2 | 1 | lasso×1 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | lasso | **no** | 6432 | 2176 | 347 | 3 | 2 | lasso×1 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | direct | **no** | 7222 | 2688 | 359 | 3 | 3 | Grep×2 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | lasso-before | **no** | 3944 | 0 | 289 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | lasso-before | **no** | 2519 | 0 | 269 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | direct | yes | 7092 | 0 | 383 | 3 | 3 | Grep×2 Read×1 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | lasso | **no** | 2396 | 0 | 212 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | lasso-before | **no** | 2502 | 0 | 153 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | direct | yes | 4741 | 1152 | 419 | 4 | 4 | Grep×1 Glob×1 Read×2 | 5.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | lasso | yes | 2542 | 0 | 202 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | lasso-before | yes | 2968 | 0 | 237 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | lasso | yes | 2499 | 0 | 300 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | direct | yes | 5351 | 1536 | 500 | 4 | 6 | Grep×5 Read×1 | 6.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | lasso-before | **no** | 2293 | 0 | 204 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | lasso | **no** | 5144 | 1280 | 261 | 3 | 2 | lasso×1 Read×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | direct | **no** | 3078 | 0 | 229 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | lasso | yes | 5109 | 1408 | 248 | 3 | 2 | lasso×2 | 5.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | direct | yes | 2249 | 0 | 225 | 3 | 3 | Grep×1 Glob×1 Read×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | lasso-before | yes | 5238 | 1536 | 282 | 3 | 2 | lasso×2 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | lasso | **no** | 3029 | 0 | 228 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | direct | **no** | 14042 | 9216 | 628 | 7 | 8 | Grep×3 Glob×2 Read×3 | 10.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | lasso-before | **no** | 13946 | 8320 | 561 | 5 | 5 | lasso×2 Grep×2 Read×1 | 8.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | lasso-before | **no** | 6050 | 1664 | 300 | 3 | 2 | lasso×2 | 5.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | direct | yes | 7152 | 0 | 347 | 3 | 5 | Glob×1 Grep×1 Read×3 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | lasso | yes | 53076 | 41984 | 641 | 8 | 9 | lasso×1 Grep×2 Read×2 Glob×4 | 11.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | lasso-before | yes | 2581 | 0 | 195 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | lasso | yes | 2516 | 0 | 169 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | direct | yes | 6673 | 0 | 316 | 3 | 5 | Grep×1 Glob×2 Read×2 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | lasso-before | **no** | 4326 | 0 | 302 | 2 | 1 | lasso×1 | 3.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | lasso | **no** | 3728 | 0 | 239 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | direct | **no** | 6454 | 0 | 334 | 3 | 3 | Grep×2 Read×1 | 4.9 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | lasso | **no** | 4158 | 0 | 365 | 2 | 1 | lasso×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | direct | **no** | 6307 | 0 | 407 | 3 | 4 | Grep×2 Read×2 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | lasso-before | **no** | 5003 | 0 | 388 | 2 | 1 | lasso×1 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | lasso | yes | 3326 | 0 | 254 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | direct | **no** | 4006 | 1152 | 285 | 3 | 3 | Grep×2 Read×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | lasso-before | yes | 2841 | 0 | 220 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | lasso-before | yes | 3689 | 0 | 286 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | direct | **no** | 6383 | 0 | 373 | 3 | 4 | Grep×2 Read×2 | 5.0 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | lasso | yes | 3253 | 0 | 240 | 2 | 1 | lasso×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | lasso-before | yes | 3019 | 0 | 247 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | direct | **no** | 4403 | 1024 | 261 | 3 | 4 | Grep×3 Read×1 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | lasso | yes | 2449 | 0 | 177 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | lasso-before | yes | 7068 | 2304 | 235 | 3 | 2 | lasso×2 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | lasso | yes | 5735 | 1536 | 244 | 3 | 2 | lasso×2 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | direct | yes | 7541 | 2944 | 257 | 3 | 3 | Grep×2 Read×1 | 4.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | lasso-before | yes | 7969 | 1664 | 446 | 3 | 4 | lasso×1 Grep×1 Read×2 | 5.0 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | lasso | yes | 2604 | 0 | 163 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | direct | yes | 7017 | 0 | 303 | 3 | 4 | Grep×2 Read×2 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | lasso-before | **no** | 2677 | 0 | 338 | 2 | 1 | lasso×1 | 3.9 | answered |
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | lasso | **no** | 2550 | 0 | 346 | 2 | 1 | lasso×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | direct | **no** | 5101 | 1152 | 508 | 3 | 5 | Grep×2 Read×3 | 5.3 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | lasso | yes | 2854 | 0 | 415 | 2 | 1 | lasso×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | direct | yes | 6131 | 0 | 549 | 3 | 3 | Grep×2 Read×1 | 5.7 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | lasso-before | yes | 3028 | 0 | 400 | 2 | 1 | lasso×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | lasso | **no** | 3184 | 0 | 303 | 3 | 2 | lasso×1 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | direct | **no** | 2593 | 0 | 378 | 3 | 4 | Grep×3 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | lasso-before | **no** | 3557 | 0 | 410 | 3 | 2 | lasso×2 | 6.5 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | lasso-before | yes | 3465 | 0 | 477 | 3 | 2 | lasso×1 Read×1 | 5.5 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | direct | yes | 2680 | 0 | 471 | 3 | 3 | Grep×1 Glob×1 Read×1 | 5.1 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | lasso | yes | 2326 | 0 | 432 | 2 | 1 | lasso×1 | 4.9 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | lasso-before | **no** | 2224 | 0 | 159 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | direct | **no** | 3669 | 1152 | 290 | 3 | 4 | Grep×3 Read×1 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | lasso | **no** | 2712 | 0 | 156 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | lasso-before | yes | 3255 | 0 | 268 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | lasso | yes | 2758 | 0 | 272 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | direct | **no** | 3670 | 1152 | 227 | 3 | 3 | Grep×2 Read×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | lasso-before | **no** | 6193 | 2688 | 322 | 4 | 4 | lasso×1 Grep×2 Read×1 | 5.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | lasso | **no** | 10531 | 2560 | 441 | 5 | 6 | lasso×2 Grep×2 Read×2 | 7.3 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | direct | **no** | 3100 | 0 | 208 | 3 | 3 | Grep×2 Read×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | lasso | yes | 2372 | 0 | 319 | 2 | 1 | lasso×1 | 3.7 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | direct | yes | 6123 | 0 | 406 | 3 | 5 | Grep×3 Read×2 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | lasso-before | **no** | 2749 | 0 | 354 | 2 | 1 | lasso×1 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | lasso | **no** | 2330 | 0 | 199 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | direct | **no** | 6406 | 3072 | 288 | 4 | 4 | Grep×3 Read×1 | 5.7 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | lasso-before | **no** | 2467 | 0 | 189 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | lasso-before | **no** | 2373 | 0 | 163 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | direct | **no** | 5918 | 0 | 290 | 3 | 4 | Grep×2 Read×2 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | lasso | **no** | 2373 | 0 | 184 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | lasso-before | yes | 2895 | 0 | 272 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | lasso | yes | 7889 | 1536 | 400 | 3 | 3 | lasso×1 Read×2 | 5.3 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | direct | yes | 4495 | 1408 | 412 | 3 | 4 | Grep×2 Read×2 | 4.9 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | lasso-before | yes | 3247 | 0 | 145 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | lasso | yes | 7818 | 1536 | 224 | 3 | 2 | lasso×1 Read×1 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | direct | yes | 6209 | 0 | 277 | 3 | 5 | Grep×1 Glob×1 Read×3 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | lasso | yes | 3607 | 0 | 187 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | direct | yes | 2362 | 0 | 211 | 2 | 2 | Grep×2 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | lasso-before | yes | 6123 | 1792 | 263 | 3 | 2 | lasso×2 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | lasso | yes | 2531 | 0 | 249 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | direct | yes | 8232 | 3200 | 514 | 5 | 7 | Grep×4 Glob×1 Read×2 | 7.2 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | lasso-before | yes | 2452 | 0 | 208 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | lasso-before | yes | 1834 | 0 | 166 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | direct | yes | 3229 | 1024 | 198 | 3 | 3 | Grep×2 Read×1 | 3.7 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | lasso | yes | 1949 | 0 | 134 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | lasso-before | yes | 1924 | 0 | 243 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | direct | yes | 2885 | 0 | 277 | 3 | 3 | Grep×2 Read×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | lasso | yes | 1962 | 0 | 263 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | lasso-before | yes | 2546 | 0 | 250 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | lasso | yes | 2526 | 0 | 235 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | direct | yes | 5745 | 1152 | 415 | 4 | 5 | Grep×4 Read×1 | 6.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | lasso-before | yes | 8045 | 2432 | 311 | 3 | 2 | lasso×2 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | lasso | yes | 7860 | 1664 | 318 | 3 | 3 | lasso×1 Read×2 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | direct | yes | 6404 | 2560 | 525 | 4 | 5 | Grep×2 Glob×1 Read×2 | 6.4 | answered |

\* capability task: needs history direct tools cannot reach; not in the comparisons.

