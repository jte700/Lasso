# Lasso agent benchmark: live model runs

Generated 2026-10-31T06:29:10.421Z by `node scripts/agent-benchmark-live.mjs`. Models gpt-5.4-mini; families documents (sets heldout2); reasoning effort low; 1 run(s); spent $0.234 of a $0.36 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), whether read at full price, from cache or written to it; output includes reasoning. Claude runs use automatic prompt caching, as hosts do; OpenAI caches by itself. The model chose its own steps.

## gpt-5.4-mini: documents/heldout2

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 8/18 | 90,547 | 84,302 | 13,952 | 0 | 6,245 | 1,335 | 57 | 67 | $0.0819 | 76.2 s |
| lasso | 11/18 | 123,507 | 118,175 | 37,120 | 0 | 5,332 | 1,774 | 47 | 35 | $0.0876 | 58.7 s |
| lasso-v5 | 9/18 | 68,535 | 63,949 | 6,272 | 0 | 4,586 | 1,625 | 40 | 22 | $0.0644 | 50.7 s |

- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **-36.4%**; per-task ratio min 0.51, median 1, max 7.29; more tokens on 10 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 5.
- **lasso-v5** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **24.3%**; per-task ratio min 0.45, median 0.64, max 3.32; more tokens on 4 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 1.

## By kind of file

Tasks grouped by the files their answer is in. Each arm: correct answers, then tokens. Savings are 1 − ΣT_lasso / ΣT_other over the tasks both arms ran.

| Model | Kind of file | Tasks | direct | lasso | upload | Lasso vs direct | Lasso vs upload |
|---|---|---|---|---|---|---|---|
| gpt-5.4-mini | Excel | 1 | 1/1, 13,443 | 1/1, 20,900 | – | -55.5% | – |
| gpt-5.4-mini | PDF | 10 | 4/10, 46,570 | 6/10, 52,613 | – | -13% | – |
| gpt-5.4-mini | mixed (PDF + Excel) | 1 | 0/1, 5,435 | 0/1, 4,107 | – | 24.4% | – |
| gpt-5.4-mini | mixed (Word + PDF) | 5 | 2/5, 22,000 | 3/5, 23,283 | – | -5.8% | – |
| gpt-5.4-mini | mixed (notes + PDF) | 1 | 1/1, 3,099 | 1/1, 22,604 | – | -629.4% | – |

| Run | Model | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | lasso | yes | 3302 | 0 | 369 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | lasso-v5 | yes | 3325 | 0 | 431 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | direct | yes | 6474 | 0 | 592 | 3 | 3 | Glob×1 Grep×1 Read×1 | 4.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | lasso-v5 | yes | 5170 | 0 | 418 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | direct | **no** | 6846 | 0 | 426 | 3 | 4 | Grep×2 Read×2 | 3.9 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | lasso | **no** | 7960 | 1280 | 298 | 3 | 2 | lasso×1 Read×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | lasso-v5 | **no** | 2915 | 0 | 299 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | direct | **no** | 6535 | 0 | 274 | 3 | 3 | Grep×1 Glob×1 Read×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | lasso | **no** | 6100 | 1920 | 352 | 3 | 2 | lasso×2 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | lasso | **no** | 3886 | 0 | 243 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | direct | **no** | 3294 | 1024 | 258 | 3 | 3 | Grep×2 Read×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | lasso-v5 | **no** | 2691 | 0 | 231 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | lasso | yes | 2706 | 0 | 314 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | direct | yes | 2788 | 0 | 349 | 2 | 2 | Grep×2 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | lasso-v5 | **no** | 2505 | 0 | 153 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | lasso | yes | 3557 | 0 | 272 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | lasso-v5 | yes | 2549 | 0 | 204 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | direct | yes | 4099 | 1280 | 296 | 3 | 3 | Grep×1 Glob×1 Read×1 | 12.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | lasso | yes | 7805 | 2560 | 345 | 3 | 2 | lasso×1 Read×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | lasso-v5 | **no** | 8157 | 1408 | 265 | 3 | 2 | lasso×1 Read×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | direct | **no** | 2458 | 0 | 196 | 3 | 3 | Grep×1 Glob×1 Read×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | lasso-v5 | yes | 4754 | 1536 | 267 | 3 | 2 | lasso×2 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | direct | yes | 3099 | 0 | 238 | 3 | 3 | Glob×1 Grep×1 Read×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | lasso | yes | 22604 | 14208 | 454 | 5 | 6 | lasso×1 Grep×2 Read×2 Glob×1 | 5.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | lasso-v5 | **no** | 4091 | 0 | 257 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | direct | **no** | 5435 | 1024 | 477 | 4 | 5 | Grep×3 Read×2 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | lasso | **no** | 4107 | 0 | 264 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | lasso | yes | 20900 | 13184 | 556 | 5 | 6 | lasso×2 Grep×2 Glob×1 Read×1 | 5.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | direct | yes | 13443 | 5632 | 459 | 4 | 7 | Grep×3 Read×4 | 5.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | lasso-v5 | yes | 6595 | 1664 | 318 | 3 | 2 | lasso×2 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | lasso | yes | 3476 | 0 | 186 | 2 | 1 | lasso×1 | 2.2 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | lasso-v5 | yes | 2738 | 0 | 218 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | direct | yes | 2949 | 0 | 232 | 3 | 3 | Grep×1 Glob×1 Read×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | lasso | **no** | 2758 | 0 | 237 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | lasso-v5 | **no** | 2446 | 0 | 181 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | direct | **no** | 4320 | 0 | 350 | 3 | 3 | Grep×2 Read×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | lasso-v5 | **no** | 3647 | 0 | 276 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | direct | **no** | 3379 | 0 | 322 | 3 | 4 | Grep×1 Glob×1 Read×2 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | lasso | **no** | 4802 | 0 | 213 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | lasso-v5 | **no** | 2603 | 0 | 216 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | direct | yes | 4091 | 1024 | 357 | 3 | 4 | Grep×2 Read×2 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | lasso | yes | 4111 | 0 | 210 | 2 | 1 | lasso×1 | 2.3 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | lasso | yes | 4975 | 0 | 305 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | direct | **no** | 6458 | 0 | 424 | 3 | 4 | Grep×2 Read×2 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | lasso-v5 | yes | 3072 | 0 | 284 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | lasso | **no** | 2271 | 0 | 124 | 2 | 1 | lasso×1 | 1.9 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | direct | **no** | 3824 | 1152 | 216 | 3 | 3 | Grep×2 Read×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | lasso-v5 | **no** | 2204 | 0 | 114 | 2 | 1 | lasso×1 | 1.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | lasso | yes | 7601 | 2048 | 232 | 3 | 2 | lasso×2 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | lasso-v5 | yes | 6467 | 1664 | 237 | 3 | 2 | lasso×2 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | direct | yes | 5389 | 1280 | 330 | 4 | 4 | Grep×3 Read×1 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | lasso | yes | 10586 | 1920 | 358 | 3 | 4 | lasso×1 Grep×1 Read×2 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | lasso-v5 | yes | 2606 | 0 | 217 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | direct | **no** | 5666 | 1536 | 449 | 4 | 6 | Grep×5 Read×1 | 4.4 | answered |

\* capability task: needs history direct tools cannot reach; not in the comparisons.
A task whose conversation reached $0.05 was stopped there (stop "cost-cap") and counts as wrong.

