# Lasso agent benchmark: live model runs

Generated 2026-10-31T06:26:00.484Z by `node scripts/agent-benchmark-live.mjs`. Models gpt-5.4-mini; families documents (sets heldout3); reasoning effort low; 1 run(s); spent $0.238 of a $0.4 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), whether read at full price, from cache or written to it; output includes reasoning. Claude runs use automatic prompt caching, as hosts do; OpenAI caches by itself. The model chose its own steps.

## gpt-5.4-mini: documents/heldout3

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 9/18 | 95,249 | 88,749 | 21,120 | 0 | 6,500 | 1,343 | 62 | 77 | $0.0816 | 75.1 s |
| upload | 14/18 | 60,520 | 57,206 | 43,264 | 0 | 3,314 | 833 | 18 | 0 | $0.0286 | 28.5 s |
| lasso-v5 | 12/18 | 69,386 | 64,385 | 9,472 | 0 | 5,001 | 1,573 | 43 | 27 | $0.0644 | 56.4 s |
| lasso | 11/18 | 67,781 | 63,019 | 8,064 | 0 | 4,762 | 1,576 | 40 | 23 | $0.0633 | 51.9 s |

- **upload** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **36.5%**; per-task ratio min 0.12, median 0.61, max 1.3; more tokens on 5 of 18.
- **lasso-v5** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **27.2%**; per-task ratio min 0.27, median 0.59, max 2.01; more tokens on 4 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 4.
- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **28.8%**; per-task ratio min 0.27, median 0.61, max 1.45; more tokens on 5 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 3.
- **lasso-v5** vs uploading the files: 12/18 correct against 14/18; tokens 69,386 against 60,520 (S = -14.6%).
- **lasso** vs uploading the files: 11/18 correct against 14/18; tokens 67,781 against 60,520 (S = -12%).

## By kind of file

Tasks grouped by the files their answer is in. Each arm: correct answers, then tokens. Savings are 1 − ΣT_lasso / ΣT_other over the tasks both arms ran.

| Model | Kind of file | Tasks | direct | lasso | upload | Lasso vs direct | Lasso vs upload |
|---|---|---|---|---|---|---|---|
| gpt-5.4-mini | Excel | 2 | 1/2, 6,328 | 2/2, 4,118 | 2/2, 832 | 34.9% | -395% |
| gpt-5.4-mini | PDF | 9 | 3/9, 53,725 | 3/9, 26,725 | 6/9, 33,004 | 50.3% | 19% |
| gpt-5.4-mini | mixed (Word + PDF) | 2 | 0/2, 6,138 | 1/2, 6,630 | 1/2, 6,727 | -8% | 1.4% |
| gpt-5.4-mini | mixed (Word + notes + PDF + Excel) | 2 | 2/2, 16,426 | 2/2, 16,171 | 2/2, 12,741 | 1.6% | -26.9% |
| gpt-5.4-mini | mixed (notes + PDF) | 1 | 1/1, 5,281 | 1/1, 7,682 | 1/1, 5,912 | -45.5% | -29.9% |
| gpt-5.4-mini | notes | 2 | 2/2, 7,351 | 2/2, 6,455 | 2/2, 1,304 | 12.2% | -395% |

| Run | Model | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | upload | **no** | 5578 | 0 | 456 | 1 | 0 |  | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | lasso-v5 | yes | 7979 | 1536 | 410 | 3 | 2 | lasso×1 Read×1 | 4.9 | answered |
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | direct | **no** | 5501 | 0 | 407 | 3 | 3 | Grep×2 Read×1 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout3/library-of-things-report-findings | lasso | **no** | 2770 | 0 | 383 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | lasso | yes | 7682 | 1664 | 487 | 3 | 2 | lasso×1 Read×1 | 4.9 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | direct | yes | 5281 | 0 | 557 | 3 | 4 | Grep×3 Read×1 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | upload | yes | 5912 | 4992 | 468 | 1 | 0 |  | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-report-findings | lasso-v5 | yes | 3041 | 0 | 407 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | lasso-v5 | **no** | 4248 | 0 | 372 | 3 | 2 | lasso×2 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | direct | **no** | 2576 | 0 | 362 | 3 | 4 | Grep×3 Read×1 | 3.9 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | lasso | **no** | 3332 | 0 | 320 | 3 | 2 | lasso×1 Read×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout3/library-briefing-findings | upload | **no** | 3356 | 1920 | 206 | 1 | 0 |  | 1.4 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | lasso-v5 | yes | 3426 | 0 | 426 | 3 | 2 | lasso×1 Read×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | upload | yes | 803 | 0 | 380 | 1 | 0 |  | 2.0 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | lasso | yes | 2363 | 0 | 388 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-board-meeting-findings | direct | yes | 3535 | 0 | 546 | 4 | 5 | Grep×3 Glob×1 Read×1 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | upload | **no** | 2902 | 1920 | 99 | 1 | 0 |  | 1.1 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | direct | **no** | 4015 | 0 | 335 | 3 | 5 | Grep×3 Read×2 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | lasso-v5 | **no** | 2202 | 0 | 147 | 2 | 1 | lasso×1 | 2.0 | answered |
| 1 | gpt-5.4-mini | heldout3/library-household-savings | lasso | **no** | 2277 | 0 | 172 | 2 | 1 | lasso×1 | 2.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | lasso | **no** | 4659 | 0 | 259 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | direct | **no** | 3908 | 1024 | 326 | 3 | 3 | Grep×1 Glob×1 Read×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | upload | yes | 2589 | 0 | 169 | 1 | 0 |  | 1.1 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-indoor-warmth | lasso-v5 | **no** | 3642 | 0 | 283 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | lasso | **no** | 2678 | 0 | 160 | 2 | 1 | lasso×1 | 2.0 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | lasso-v5 | **no** | 6826 | 3072 | 323 | 4 | 4 | lasso×1 Glob×1 Grep×1 Read×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | direct | **no** | 5869 | 0 | 274 | 3 | 4 | Grep×2 Read×2 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-carbon-avoided | upload | yes | 5259 | 4992 | 140 | 1 | 0 |  | 1.2 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | lasso | yes | 3298 | 0 | 237 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | lasso-v5 | yes | 7164 | 2304 | 409 | 3 | 2 | lasso×2 | 4.0 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | upload | yes | 3371 | 2944 | 228 | 1 | 0 |  | 1.8 | answered |
| 1 | gpt-5.4-mini | heldout3/library-damage-rate | direct | **no** | 3562 | 1152 | 260 | 3 | 3 | Grep×1 Glob×1 Read×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | lasso-v5 | **no** | 2407 | 0 | 177 | 2 | 1 | lasso×1 | 2.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | direct | **no** | 4049 | 1152 | 312 | 3 | 5 | Grep×5 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | upload | **no** | 5247 | 4992 | 118 | 1 | 0 |  | 1.3 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-bill-fall | lasso | **no** | 2479 | 0 | 221 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | lasso | **no** | 2925 | 0 | 169 | 2 | 1 | lasso×1 | 2.0 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | direct | **no** | 6498 | 2688 | 376 | 5 | 5 | Grep×3 Read×2 | 5.2 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | upload | yes | 3065 | 2688 | 260 | 1 | 0 |  | 1.9 | answered |
| 1 | gpt-5.4-mini | heldout3/library-loan-growth | lasso-v5 | **no** | 2336 | 0 | 233 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | lasso-v5 | yes | 3283 | 0 | 284 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | direct | yes | 9675 | 4352 | 438 | 5 | 5 | Grep×2 Glob×1 Read×2 | 6.6 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | lasso | yes | 3227 | 0 | 342 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout3/repeat-borrowing-comparison | upload | yes | 2962 | 2688 | 154 | 1 | 0 |  | 1.4 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | lasso | yes | 3291 | 0 | 164 | 2 | 1 | lasso×1 | 2.2 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | lasso-v5 | yes | 2577 | 0 | 130 | 2 | 1 | lasso×1 | 2.2 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | upload | yes | 2857 | 2688 | 55 | 1 | 0 |  | 1.1 | answered |
| 1 | gpt-5.4-mini | heldout3/most-borrowed-item | direct | yes | 5337 | 0 | 195 | 3 | 3 | Grep×2 Read×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | upload | yes | 501 | 0 | 81 | 1 | 0 |  | 0.9 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | lasso-v5 | yes | 3142 | 0 | 215 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | direct | yes | 3816 | 1152 | 278 | 3 | 4 | Grep×3 Read×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout3/survey-to-installation-wait | lasso | yes | 4092 | 0 | 185 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | lasso | yes | 2419 | 0 | 190 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | direct | yes | 8873 | 4608 | 537 | 5 | 8 | Grep×6 Read×2 | 5.9 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | upload | yes | 2545 | 2304 | 123 | 1 | 0 |  | 1.1 | answered |
| 1 | gpt-5.4-mini | heldout3/solid-wall-bill-change | lasso-v5 | yes | 2395 | 0 | 204 | 2 | 1 | lasso×1 | 2.2 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | lasso-v5 | yes | 1760 | 0 | 104 | 2 | 1 | lasso×1 | 1.9 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | direct | yes | 3276 | 1024 | 223 | 3 | 3 | Grep×2 Read×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | lasso | yes | 1813 | 0 | 115 | 2 | 1 | lasso×1 | 2.1 | answered |
| 1 | gpt-5.4-mini | heldout3/north-shore-installations | upload | yes | 384 | 0 | 50 | 1 | 0 |  | 0.8 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | lasso | yes | 2305 | 0 | 252 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | lasso-v5 | yes | 1916 | 0 | 232 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | upload | yes | 448 | 0 | 103 | 1 | 0 |  | 1.0 | answered |
| 1 | gpt-5.4-mini | heldout3/south-shore-surveyed-not-installed | direct | **no** | 3052 | 0 | 308 | 3 | 4 | Grep×3 Read×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | upload | yes | 6379 | 4992 | 123 | 1 | 0 |  | 1.1 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | direct | yes | 5925 | 0 | 271 | 3 | 3 | Glob×1 Grep×1 Read×1 | 3.3 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | lasso-v5 | yes | 2785 | 0 | 245 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout3/library-effect-on-shops | lasso | yes | 1875 | 0 | 228 | 2 | 1 | lasso×1 | 2.3 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | lasso | yes | 14296 | 6400 | 490 | 4 | 4 | lasso×2 Grep×2 | 6.1 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | upload | yes | 6362 | 6144 | 101 | 1 | 0 |  | 1.4 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | direct | yes | 10501 | 3968 | 495 | 4 | 6 | Grep×4 Read×2 | 5.5 | answered |
| 1 | gpt-5.4-mini | heldout3/heat-pump-house-prices | lasso-v5 | yes | 8257 | 2560 | 400 | 3 | 3 | lasso×1 Read×1 Grep×1 | 5.1 | answered |

\* capability task: needs history direct tools cannot reach; not in the comparisons.
A task whose conversation reached $0.05 was stopped there (stop "cost-cap") and counts as wrong.

