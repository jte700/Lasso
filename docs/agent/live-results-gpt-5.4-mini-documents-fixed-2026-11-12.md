# Lasso agent benchmark: live model runs

Generated 2026-11-12T21:03:24.658Z by `node scripts/agent-benchmark-live.mjs`. Models gpt-5.4-mini; families documents (sets heldout2, heldout3); reasoning effort low; 1 run(s); spent $0.295 of a $0.45 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), whether read at full price, from cache or written to it; output includes reasoning. Claude runs use automatic prompt caching, as hosts do; OpenAI caches by itself. The model chose its own steps.

## gpt-5.4-mini: documents/heldout2

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 9/18 | 117,422 | 110,752 | 33,152 | 0 | 6,670 | 1,544 | 62 | 75 | $0.0907 | 93.4 s |
| lasso | 9/18 | 93,468 | 88,069 | 30,080 | 0 | 5,399 | 1,722 | 48 | 34 | $0.0700 | 77.2 s |

- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **20.4%**; per-task ratio min 0.2, median 0.56, max 4.89; more tokens on 4 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 4.

## gpt-5.4-mini: documents/heldout3

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 11/18 | 96,247 | 90,071 | 22,272 | 0 | 6,176 | 1,334 | 58 | 66 | $0.0803 | 91.4 s |
| lasso | 10/18 | 51,216 | 46,697 | 2,048 | 0 | 4,519 | 1,412 | 40 | 24 | $0.0540 | 65.3 s |

- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **46.8%**; per-task ratio min 0.25, median 0.51, max 1.58; more tokens on 3 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 4.

## By kind of file

Tasks grouped by the files their answer is in. Each arm: correct answers, then tokens. Savings are 1 − ΣT_lasso / ΣT_other over the tasks both arms ran.

| Model | Kind of file | Tasks | direct | lasso | upload | Lasso vs direct | Lasso vs upload |
|---|---|---|---|---|---|---|---|
| gpt-5.4-mini | Excel | 3 | 3/3, 24,154 | 3/3, 23,237 | – | 3.8% | – |
| gpt-5.4-mini | PDF | 19 | 9/19, 112,138 | 6/19, 60,564 | – | 46% | – |
| gpt-5.4-mini | mixed (PDF + Excel) | 1 | 0/1, 6,244 | 0/1, 9,836 | – | -57.5% | – |
| gpt-5.4-mini | mixed (Word + PDF) | 7 | 3/7, 38,197 | 4/7, 18,176 | – | 52.4% | – |
| gpt-5.4-mini | mixed (Word + notes + PDF + Excel) | 2 | 2/2, 19,096 | 2/2, 9,079 | – | 52.5% | – |
| gpt-5.4-mini | mixed (notes + PDF) | 2 | 1/2, 8,261 | 2/2, 17,817 | – | -115.7% | – |
| gpt-5.4-mini | notes | 2 | 2/2, 5,579 | 2/2, 5,975 | – | -7.1% | – |

| Run | Model | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | direct | yes | 6367 | 0 | 443 | 3 | 3 | Glob×1 Grep×1 Read×1 | 5.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | lasso | yes | 3412 | 0 | 362 | 2 | 1 | lasso×1 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | lasso | **no** | 4311 | 0 | 370 | 2 | 1 | lasso×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | direct | **no** | 9060 | 1920 | 352 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | direct | **no** | 3047 | 0 | 282 | 2 | 2 | Grep×2 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | lasso | **no** | 2590 | 0 | 260 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | lasso | **no** | 3110 | 0 | 245 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | direct | **no** | 3787 | 1152 | 367 | 3 | 3 | Grep×2 Read×1 | 5.2 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | direct | **no** | 3217 | 1024 | 189 | 3 | 3 | Glob×1 Grep×1 Read×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | lasso | **no** | 2344 | 0 | 144 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | lasso | yes | 2444 | 0 | 259 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | direct | yes | 5843 | 1920 | 383 | 4 | 4 | Grep×3 Read×1 | 5.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | direct | **no** | 3359 | 1024 | 282 | 3 | 3 | Grep×2 Read×1 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | lasso | **no** | 7341 | 1280 | 234 | 3 | 2 | lasso×1 Read×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | lasso | yes | 14957 | 9344 | 499 | 6 | 6 | lasso×2 Grep×2 Read×2 | 9.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | direct | yes | 3060 | 0 | 233 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | direct | **no** | 6244 | 2688 | 589 | 5 | 6 | Grep×4 Read×2 | 7.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | lasso | **no** | 9836 | 5120 | 483 | 4 | 4 | lasso×1 Glob×1 Grep×1 Read×1 | 6.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | lasso | yes | 19166 | 12800 | 664 | 6 | 7 | lasso×1 Grep×4 Glob×1 Read×1 | 9.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | direct | yes | 16570 | 10496 | 647 | 6 | 9 | Grep×3 Glob×3 Read×3 | 8.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | direct | yes | 11508 | 4736 | 310 | 4 | 4 | Grep×2 Read×2 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | lasso | yes | 2662 | 0 | 193 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | lasso | **no** | 3588 | 0 | 191 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | direct | **no** | 6738 | 1664 | 472 | 4 | 5 | Grep×2 Read×3 | 5.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | direct | **no** | 6866 | 0 | 406 | 3 | 5 | Grep×2 Read×3 | 5.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | lasso | **no** | 2431 | 0 | 227 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | lasso | yes | 2611 | 0 | 324 | 2 | 1 | lasso×1 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | direct | yes | 3235 | 0 | 290 | 3 | 3 | Grep×2 Read×1 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | direct | yes | 5776 | 0 | 362 | 3 | 3 | Grep×2 Read×1 | 4.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | lasso | **no** | 3025 | 0 | 282 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | lasso | yes | 2531 | 0 | 267 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | direct | **no** | 4555 | 1664 | 269 | 3 | 4 | Grep×3 Read×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | direct | yes | 6296 | 0 | 300 | 3 | 5 | Grep×3 Read×2 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | lasso | yes | 4749 | 1536 | 226 | 3 | 2 | lasso×2 | 4.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | lasso | yes | 2360 | 0 | 169 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | direct | yes | 11894 | 4864 | 494 | 4 | 7 | Grep×5 Read×2 | 6.7 | answered |
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | direct | yes | 5642 | 0 | 495 | 3 | 3 | Grep×2 Read×1 | 5.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | lasso | **no** | 2560 | 0 | 360 | 2 | 1 | lasso×1 | 4.4 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | lasso | yes | 2860 | 0 | 402 | 2 | 1 | lasso×1 | 3.9 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | direct | **no** | 5201 | 0 | 495 | 3 | 3 | Grep×2 Read×1 | 5.8 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | direct | **no** | 2434 | 0 | 319 | 3 | 3 | Grep×2 Read×1 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | lasso | **no** | 3058 | 0 | 274 | 3 | 2 | lasso×1 Read×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | lasso | yes | 3249 | 0 | 340 | 3 | 2 | lasso×1 Read×1 | 4.4 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | direct | yes | 3854 | 0 | 566 | 4 | 4 | Grep×2 Glob×1 Read×1 | 7.0 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | direct | **no** | 5781 | 2432 | 355 | 4 | 5 | Grep×2 Glob×1 Read×2 | 7.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | lasso | **no** | 2072 | 0 | 130 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | lasso | **no** | 2419 | 0 | 205 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | direct | yes | 6872 | 1152 | 345 | 3 | 4 | Grep×2 Read×2 | 5.0 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | direct | **no** | 3794 | 0 | 298 | 3 | 5 | Grep×2 Read×3 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | lasso | **no** | 2170 | 0 | 141 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | lasso | **no** | 1584 | 0 | 135 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | direct | **no** | 3498 | 1024 | 196 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | direct | **no** | 4032 | 1280 | 253 | 3 | 4 | Grep×3 Read×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | lasso | yes | 2384 | 0 | 300 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | lasso | **no** | 2549 | 0 | 172 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | direct | **no** | 10141 | 3968 | 396 | 4 | 4 | Grep×2 Read×2 | 5.6 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | direct | yes | 5120 | 0 | 334 | 3 | 3 | Grep×2 Read×1 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | lasso | **no** | 5207 | 0 | 415 | 3 | 3 | lasso×1 Read×1 Grep×1 | 5.0 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | lasso | yes | 2956 | 0 | 149 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | direct | yes | 3303 | 1024 | 191 | 3 | 3 | Grep×2 Read×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | direct | yes | 1725 | 0 | 249 | 2 | 2 | Grep×2 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | lasso | yes | 2726 | 0 | 235 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | lasso | yes | 2272 | 0 | 209 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | direct | yes | 8170 | 1920 | 352 | 3 | 4 | Grep×4 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | direct | yes | 3294 | 1024 | 225 | 3 | 3 | Grep×2 Read×1 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | lasso | yes | 2182 | 0 | 185 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | lasso | yes | 1889 | 0 | 190 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | direct | yes | 4290 | 1536 | 307 | 3 | 3 | Grep×2 Read×1 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | direct | yes | 5895 | 0 | 321 | 3 | 4 | Grep×2 Read×2 | 5.2 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | lasso | yes | 2396 | 0 | 217 | 2 | 1 | lasso×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | lasso | yes | 6683 | 2048 | 460 | 3 | 3 | lasso×1 Grep×2 | 5.6 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | direct | yes | 13201 | 6912 | 479 | 5 | 6 | Grep×3 Glob×1 Read×2 | 7.3 | answered |

\* capability task: needs history direct tools cannot reach; not in the comparisons.

