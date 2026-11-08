# Lasso agent benchmark: live model runs

Generated 2026-10-30T18:45:40.805Z by `node scripts/agent-benchmark-live.mjs`. Models gpt-5.4-mini; families geometry, scale, writing, documents (sets heldout, heldout2); reasoning effort low; 1 run(s); spent $1.014 of a $3.5 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), whether read at full price, from cache or written to it; output includes reasoning. Claude runs use automatic prompt caching, as hosts do; OpenAI caches by itself. The model chose its own steps.

## gpt-5.4-mini: geometry

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 5/5 | 72,765 | 70,507 | 39,680 | 0 | 2,258 | 837 | 18 | 22 | $0.0363 | 31.5 s |
| lasso | 5/5 | 11,947 | 9,992 | 1,024 | 0 | 1,955 | 1,242 | 12 | 8 | $0.0156 | 24.1 s |
| upload | 5/5 | 54,362 | 53,518 | 52,608 | 0 | 844 | 444 | 5 | 0 | $0.0084 | 7.9 s |

- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 5 paired tasks = **83.6%**; per-task ratio min 0.03, median 0.49, max 1.07; more tokens on 1 of 5. Used Lasso on 5 of 5 tasks, also needing file tools on 1.
- **upload** vs direct tools: S = 1 − ΣT/ΣT_direct over 5 paired tasks = **25.3%**; per-task ratio min 0.23, median 1.99, max 8.06; more tokens on 3 of 5.
- **lasso** vs uploading the files: 5/5 correct against 5/5; tokens 11,947 against 54,362 (S = 78%).

## gpt-5.4-mini: scale

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 5/7 | 438,732 | 435,981 | 247,168 | 0 | 2,751 | 1,690 | 23 | 18 | $0.1725 | 38.3 s |
| lasso | 7/7 | 16,856 | 15,763 | 0 | 0 | 1,093 | 319 | 15 | 9 | $0.0167 | 20.3 s |
| upload | 5/7 | 607,810 | 606,564 | 449,280 | 0 | 1,246 | 892 | 7 | 0 | $0.1573 | 15.7 s |

- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 7 paired tasks = **96.2%**; per-task ratio min 0.01, median 0.03, max 0.22; more tokens on 0 of 7. Used Lasso on 7 of 7 tasks, also needing file tools on 1.
- **upload** vs direct tools: S = 1 − ΣT/ΣT_direct over 7 paired tasks = **-38.5%**; per-task ratio min 0.4, median 1.06, max 2.44; more tokens on 4 of 7.
- **lasso** vs uploading the files: 7/7 correct against 5/7; tokens 16,856 against 607,810 (S = 97.2%).

## gpt-5.4-mini: writing

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 7/12 | 199,402 | 190,801 | 82,048 | 0 | 8,601 | 2,787 | 56 | 93 | $0.1264 | 97 s |
| lasso | 8/12 | 47,627 | 42,917 | 14,464 | 0 | 4,710 | 2,088 | 34 | 26 | $0.0436 | 57.8 s |
| upload | 10/11 | 21,563 | 18,328 | 15,360 | 0 | 3,235 | 1,707 | 11 | 0 | $0.0179 | 26.6 s |

- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 12 paired tasks = **76.1%**; per-task ratio min 0.03, median 0.55, max 1.52; more tokens on 3 of 12. Used Lasso on 12 of 12 tasks, also needing file tools on 5.
- **upload** vs direct tools: S = 1 − ΣT/ΣT_direct over 11 paired tasks = **83.3%**; per-task ratio min 0.07, median 0.15, max 0.22; more tokens on 0 of 11.
- **lasso** vs uploading the files: 8/11 correct against 10/11; tokens 44,587 against 21,563 (S = -106.8%).

## gpt-5.4-mini: documents/heldout

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 10/16 | 93,317 | 86,916 | 12,416 | 0 | 6,401 | 1,275 | 50 | 61 | $0.0856 | 80.1 s |
| lasso | 12/16 | 97,332 | 90,653 | 21,760 | 0 | 6,679 | 2,044 | 49 | 42 | $0.0834 | 82.7 s |
| upload | 12/16 | 65,954 | 61,837 | 46,976 | 0 | 4,117 | 1,132 | 16 | 0 | $0.0332 | 39.4 s |

- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 16 paired tasks = **-4.3%**; per-task ratio min 0.26, median 0.93, max 4; more tokens on 7 of 16. Used Lasso on 16 of 16 tasks, also needing file tools on 10.
- **upload** vs direct tools: S = 1 − ΣT/ΣT_direct over 16 paired tasks = **29.3%**; per-task ratio min 0.23, median 0.57, max 1.64; more tokens on 5 of 16.
- **lasso** vs uploading the files: 12/16 correct against 12/16; tokens 97,332 against 65,954 (S = -47.6%).

## gpt-5.4-mini: documents/heldout2

| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 8/18 | 111,912 | 105,082 | 27,136 | 0 | 6,830 | 1,441 | 64 | 78 | $0.0912 | 100.3 s |
| lasso | 7/18 | 147,842 | 141,499 | 56,704 | 0 | 6,343 | 2,065 | 61 | 50 | $0.0964 | 94.4 s |
| upload | 11/18 | 63,088 | 59,703 | 44,672 | 0 | 3,385 | 880 | 18 | 0 | $0.0299 | 33.8 s |

- **lasso** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **-32.1%**; per-task ratio min 0.25, median 1.02, max 7.01; more tokens on 10 of 18. Used Lasso on 18 of 18 tasks, also needing file tools on 10.
- **upload** vs direct tools: S = 1 − ΣT/ΣT_direct over 18 paired tasks = **43.6%**; per-task ratio min 0.03, median 0.6, max 1.62; more tokens on 3 of 18.
- **lasso** vs uploading the files: 7/18 correct against 11/18; tokens 147,842 against 63,088 (S = -134.3%).

## By kind of file

Tasks grouped by the files their answer is in. Each arm: correct answers, then tokens. Savings are 1 − ΣT_lasso / ΣT_other over the tasks both arms ran.

| Model | Kind of file | Tasks | direct | lasso | upload | Lasso vs direct | Lasso vs upload |
|---|---|---|---|---|---|---|---|
| gpt-5.4-mini | 3D model | 8 | 6/8, 238,202 | 7/8, 32,269 | 7/7, 71,166 | 86.5% | 58.9% |
| gpt-5.4-mini | Excel | 11 | 6/11, 413,201 | 11/11, 47,606 | 6/11, 570,597 | 88.5% | 91.7% |
| gpt-5.4-mini | PDF | 24 | 13/24, 189,975 | 14/24, 139,248 | 18/24, 116,174 | 26.7% | -19.9% |
| gpt-5.4-mini | Word | 2 | 2/2, 4,884 | 1/2, 4,459 | 2/2, 799 | 8.7% | -458.1% |
| gpt-5.4-mini | mixed (PDF + Excel) | 2 | 1/2, 12,527 | 0/2, 22,751 | 1/2, 4,585 | -81.6% | -396.2% |
| gpt-5.4-mini | mixed (Word + PDF) | 9 | 5/9, 48,242 | 4/9, 50,935 | 7/9, 42,496 | -5.6% | -19.9% |
| gpt-5.4-mini | mixed (notes + PDF) | 2 | 2/2, 9,097 | 2/2, 24,336 | 2/2, 6,960 | -167.5% | -249.7% |

| Run | Model | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gpt-5.4-mini | geometry/fixture-pin-distance | lasso | yes | 1493 | 0 | 106 | 2 | 1 | lasso×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | geometry/fixture-pin-distance | upload | yes | 8936 | 8576 | 177 | 1 | 0 |  | 2.3 | answered |
| 1 | gpt-5.4-mini | geometry/fixture-pin-distance | direct | yes | 3045 | 0 | 312 | 3 | 3 | Glob×1 Grep×1 Read×1 | 4.8 | answered |
| 1 | gpt-5.4-mini | geometry/flange-opposite-bolts | upload | yes | 11284 | 11008 | 100 | 1 | 0 |  | 1.3 | answered |
| 1 | gpt-5.4-mini | geometry/flange-opposite-bolts | direct | yes | 1400 | 0 | 161 | 2 | 1 | Grep×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | geometry/flange-opposite-bolts | lasso | yes | 1498 | 0 | 106 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | geometry/flange-bolt-pose | upload | yes | 11476 | 11008 | 275 | 1 | 0 |  | 1.9 | answered |
| 1 | gpt-5.4-mini | geometry/flange-bolt-pose | direct | yes | 13476 | 4608 | 557 | 3 | 2 | Grep×2 | 6.7 | answered |
| 1 | gpt-5.4-mini | geometry/flange-bolt-pose | lasso | yes | 2629 | 0 | 1168 | 2 | 1 | lasso×1 | 8.1 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-tilt | lasso | yes | 1575 | 0 | 130 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-tilt | direct | yes | 49169 | 33792 | 689 | 6 | 8 | Grep×5 Read×3 | 9.8 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-tilt | upload | yes | 11354 | 11008 | 167 | 1 | 0 |  | 1.4 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-position | lasso | yes | 4752 | 1024 | 445 | 4 | 4 | lasso×2 Grep×2 | 6.5 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-position | direct | yes | 5675 | 1280 | 539 | 4 | 8 | Glob×2 Grep×5 Read×1 | 7.3 | answered |
| 1 | gpt-5.4-mini | geometry/flange-sensor-position | upload | yes | 11312 | 11008 | 125 | 1 | 0 |  | 1.1 | answered |
| 1 | gpt-5.4-mini | scale/invoice-lookup | lasso | yes | 1526 | 0 | 121 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | scale/invoice-lookup | upload | yes | 141484 | 0 | 99 | 1 | 0 |  | 1.9 | answered |
| 1 | gpt-5.4-mini | scale/invoice-lookup | direct | yes | 58015 | 28544 | 168 | 3 | 2 | Read×1 Grep×1 | 4.4 | answered |
| 1 | gpt-5.4-mini | scale/amount-total | upload | **no** | 141711 | 141184 | 339 | 1 | 0 |  | 3.9 | answered |
| 1 | gpt-5.4-mini | scale/amount-total | direct | **no** | 60195 | 28544 | 758 | 3 | 3 | Read×2 Grep×1 | 7.1 | answered |
| 1 | gpt-5.4-mini | scale/amount-total | lasso | yes | 1449 | 0 | 107 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | scale/west-total | upload | **no** | 141658 | 141184 | 285 | 1 | 0 |  | 3.5 | answered |
| 1 | gpt-5.4-mini | scale/west-total | direct | **no** | 133507 | 86400 | 906 | 5 | 5 | Read×2 Grep×3 | 10.9 | answered |
| 1 | gpt-5.4-mini | scale/west-total | lasso | yes | 1495 | 0 | 126 | 2 | 1 | lasso×1 | 2.3 | answered |
| 1 | gpt-5.4-mini | scale/largest-invoice | lasso | yes | 1504 | 0 | 133 | 2 | 1 | lasso×1 | 2.5 | answered |
| 1 | gpt-5.4-mini | scale/largest-invoice | direct | yes | 117930 | 87040 | 453 | 5 | 4 | Read×1 Grep×3 | 7.2 | answered |
| 1 | gpt-5.4-mini | scale/largest-invoice | upload | yes | 141603 | 141184 | 228 | 1 | 0 |  | 2.4 | answered |
| 1 | gpt-5.4-mini | scale/warranty-reserve | lasso | yes | 1605 | 0 | 125 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | scale/warranty-reserve | direct | yes | 17374 | 0 | 123 | 2 | 1 | Read×1 | 2.3 | answered |
| 1 | gpt-5.4-mini | scale/warranty-reserve | upload | yes | 13775 | 0 | 88 | 1 | 0 |  | 1.3 | answered |
| 1 | gpt-5.4-mini | scale/lowest-churn | lasso | yes | 1636 | 0 | 125 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | scale/lowest-churn | upload | yes | 13842 | 13568 | 150 | 1 | 0 |  | 1.7 | answered |
| 1 | gpt-5.4-mini | scale/lowest-churn | direct | yes | 17418 | 0 | 156 | 2 | 1 | Read×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | scale/emissions-absent | lasso | yes | 7641 | 0 | 356 | 3 | 3 | lasso×1 Grep×1 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | scale/emissions-absent | upload | yes | 13737 | 12160 | 57 | 1 | 0 |  | 1.0 | answered |
| 1 | gpt-5.4-mini | scale/emissions-absent | direct | yes | 34293 | 16640 | 187 | 3 | 2 | Read×1 Grep×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | writing/q4-revenue-email | lasso | **no** | 2101 | 0 | 410 | 2 | 1 | lasso×1 | 4.9 | answered |
| 1 | gpt-5.4-mini | writing/q4-revenue-email | upload | yes | 780 | 0 | 212 | 1 | 0 |  | 1.8 | answered |
| 1 | gpt-5.4-mini | writing/q4-revenue-email | direct | yes | 3798 | 0 | 371 | 4 | 4 | Grep×1 Glob×1 Read×2 | 6.0 | answered |
| 1 | gpt-5.4-mini | writing/top-months-newsletter | upload | yes | 450 | 0 | 165 | 1 | 0 |  | 2.1 | answered |
| 1 | gpt-5.4-mini | writing/top-months-newsletter | direct | yes | 6646 | 1664 | 734 | 5 | 7 | Grep×4 Read×3 | 7.7 | answered |
| 1 | gpt-5.4-mini | writing/top-months-newsletter | lasso | yes | 2071 | 0 | 310 | 2 | 1 | lasso×1 | 3.5 | answered |
| 1 | gpt-5.4-mini | writing/quarterly-margin-email | upload | yes | 976 | 0 | 690 | 1 | 0 |  | 4.7 | answered |
| 1 | gpt-5.4-mini | writing/quarterly-margin-email | direct | **no** | 5402 | 1024 | 723 | 5 | 8 | Glob×1 Grep×5 Read×2 | 7.6 | answered |
| 1 | gpt-5.4-mini | writing/quarterly-margin-email | lasso | yes | 4476 | 1024 | 834 | 3 | 3 | lasso×1 Read×1 Grep×1 | 7.4 | answered |
| 1 | gpt-5.4-mini | writing/annual-total-line | lasso | yes | 1837 | 0 | 132 | 2 | 1 | lasso×1 | 2.9 | answered |
| 1 | gpt-5.4-mini | writing/annual-total-line | direct | yes | 3409 | 0 | 426 | 4 | 4 | Grep×3 Read×1 | 5.6 | answered |
| 1 | gpt-5.4-mini | writing/annual-total-line | upload | **no** | 420 | 0 | 139 | 1 | 0 |  | 1.7 | answered |
| 1 | gpt-5.4-mini | writing/budget-note | lasso | yes | 5486 | 2560 | 549 | 4 | 4 | lasso×1 Grep×2 Read×1 | 6.3 | answered |
| 1 | gpt-5.4-mini | writing/budget-note | direct | **no** | 3777 | 0 | 593 | 4 | 5 | Glob×1 Grep×3 Read×1 | 6.4 | answered |
| 1 | gpt-5.4-mini | writing/budget-note | upload | yes | 579 | 0 | 371 | 1 | 0 |  | 2.9 | answered |
| 1 | gpt-5.4-mini | writing/q1-outlook-sentence | lasso | yes | 1884 | 0 | 214 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | writing/q1-outlook-sentence | upload | yes | 361 | 0 | 79 | 1 | 0 |  | 1.2 | answered |
| 1 | gpt-5.4-mini | writing/q1-outlook-sentence | direct | yes | 2755 | 0 | 427 | 3 | 5 | Grep×4 Read×1 | 4.6 | answered |
| 1 | gpt-5.4-mini | writing/west-region-email | lasso | **no** | 4991 | 1152 | 619 | 4 | 5 | lasso×1 Grep×3 Read×1 | 7.5 | answered |
| 1 | gpt-5.4-mini | writing/west-region-email | upload | yes | 394 | 0 | 115 | 1 | 0 |  | 1.3 | answered |
| 1 | gpt-5.4-mini | writing/west-region-email | direct | **no** | 3294 | 0 | 810 | 3 | 6 | Grep×4 Read×2 | 6.2 | answered |
| 1 | gpt-5.4-mini | writing/supplier-bullets | upload | yes | 376 | 0 | 164 | 1 | 0 |  | 1.5 | answered |
| 1 | gpt-5.4-mini | writing/supplier-bullets | direct | yes | 2289 | 0 | 357 | 3 | 4 | Grep×3 Read×1 | 4.4 | answered |
| 1 | gpt-5.4-mini | writing/supplier-bullets | lasso | **no** | 2578 | 0 | 249 | 3 | 2 | lasso×1 Read×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | writing/meeting-actions-email | upload | yes | 423 | 0 | 205 | 1 | 0 |  | 1.7 | answered |
| 1 | gpt-5.4-mini | writing/meeting-actions-email | direct | yes | 2595 | 0 | 425 | 3 | 6 | Grep×5 Read×1 | 4.5 | answered |
| 1 | gpt-5.4-mini | writing/meeting-actions-email | lasso | yes | 1881 | 0 | 233 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | writing/bracket-spec | lasso | yes | 15457 | 9728 | 697 | 6 | 5 | lasso×2 Read×1 Grep×2 | 9.1 | answered |
| 1 | gpt-5.4-mini | writing/bracket-spec | direct | yes | 33232 | 17152 | 1343 | 9 | 17 | Grep×13 Read×3 Glob×1 | 17.4 | answered |
| 1 | gpt-5.4-mini | writing/bracket-spec | upload | yes | 7383 | 6784 | 429 | 1 | 0 |  | 2.2 | answered |
| 1 | gpt-5.4-mini | writing/assembly-parts-email | lasso | yes | 1825 | 0 | 193 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | writing/assembly-parts-email | upload | yes | 9421 | 8576 | 666 | 1 | 0 |  | 5.4 | answered |
| 1 | gpt-5.4-mini | writing/assembly-parts-email | direct | **no** | 61944 | 39296 | 1322 | 7 | 13 | Grep×9 Read×4 | 15.3 | answered |
| 1 | gpt-5.4-mini | writing/house-rooms-brochure | lasso | **no** | 3040 | 0 | 270 | 2 | 1 | lasso×1 | 3.0 | answered |
| 1 | gpt-5.4-mini | writing/house-rooms-brochure | upload | skipped | | | | | | a file is over 400,000 characters | | |
| 1 | gpt-5.4-mini | writing/house-rooms-brochure | direct | **no** | 70261 | 22912 | 1070 | 6 | 14 | Grep×4 Glob×2 Read×8 | 11.2 | answered |
| 1 | gpt-5.4-mini | heldout/halden-buffer-findings | lasso | **no** | 7184 | 0 | 480 | 3 | 3 | lasso×1 Read×1 Grep×1 | 5.5 | answered |
| 1 | gpt-5.4-mini | heldout/halden-buffer-findings | upload | **no** | 6673 | 0 | 534 | 1 | 0 |  | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout/halden-buffer-findings | direct | **no** | 6393 | 0 | 522 | 3 | 3 | Grep×2 Read×1 | 5.3 | answered |
| 1 | gpt-5.4-mini | heldout/halden-nitrate-headline | upload | yes | 6478 | 6016 | 326 | 1 | 0 |  | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout/halden-nitrate-headline | direct | **no** | 3938 | 0 | 277 | 2 | 3 | Grep×3 | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout/halden-nitrate-headline | lasso | **no** | 11544 | 5632 | 670 | 5 | 5 | lasso×2 Grep×2 Read×1 | 8.1 | answered |
| 1 | gpt-5.4-mini | heldout/halden-phosphorus | upload | yes | 6304 | 6016 | 168 | 1 | 0 |  | 2.1 | answered |
| 1 | gpt-5.4-mini | heldout/halden-phosphorus | direct | yes | 7189 | 2304 | 273 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.5 | answered |
| 1 | gpt-5.4-mini | heldout/halden-phosphorus | lasso | yes | 9782 | 1024 | 364 | 3 | 3 | lasso×1 Read×1 Grep×1 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout/halden-water-temperature | lasso | yes | 5135 | 1152 | 350 | 3 | 2 | lasso×1 Read×1 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout/halden-water-temperature | direct | yes | 6958 | 0 | 360 | 3 | 3 | Grep×2 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout/halden-water-temperature | upload | yes | 3583 | 1920 | 242 | 1 | 0 |  | 2.0 | answered |
| 1 | gpt-5.4-mini | heldout/halden-buffer-width | lasso | **no** | 4675 | 1280 | 349 | 3 | 2 | lasso×2 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout/halden-buffer-width | direct | **no** | 9436 | 3840 | 594 | 5 | 6 | Grep×3 Glob×1 Read×2 | 7.8 | answered |
| 1 | gpt-5.4-mini | heldout/halden-buffer-width | upload | **no** | 3527 | 3200 | 189 | 1 | 0 |  | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout/halden-stream-life | lasso | yes | 8259 | 1408 | 510 | 3 | 2 | lasso×1 Read×1 | 7.1 | answered |
| 1 | gpt-5.4-mini | heldout/halden-stream-life | upload | yes | 3575 | 3200 | 228 | 1 | 0 |  | 2.0 | answered |
| 1 | gpt-5.4-mini | heldout/halden-stream-life | direct | yes | 6316 | 0 | 445 | 3 | 3 | Grep×2 Read×1 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout/halden-fish | lasso | yes | 1770 | 0 | 202 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout/halden-fish | upload | yes | 3436 | 3200 | 98 | 1 | 0 |  | 1.4 | answered |
| 1 | gpt-5.4-mini | heldout/halden-fish | direct | yes | 6876 | 2688 | 535 | 5 | 7 | Grep×5 Glob×1 Read×1 | 8.0 | answered |
| 1 | gpt-5.4-mini | heldout/halden-reach-extremes | upload | **no** | 609 | 0 | 251 | 1 | 0 |  | 2.3 | answered |
| 1 | gpt-5.4-mini | heldout/halden-reach-extremes | direct | **no** | 2450 | 0 | 373 | 3 | 4 | Glob×2 Grep×1 Read×1 | 5.3 | answered |
| 1 | gpt-5.4-mini | heldout/halden-reach-extremes | lasso | yes | 2301 | 0 | 330 | 2 | 1 | lasso×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout/halden-reach-averages | upload | yes | 590 | 0 | 235 | 1 | 0 |  | 2.2 | answered |
| 1 | gpt-5.4-mini | heldout/halden-reach-averages | direct | yes | 2588 | 0 | 381 | 3 | 3 | Glob×1 Grep×1 Read×1 | 4.6 | answered |
| 1 | gpt-5.4-mini | heldout/halden-reach-averages | lasso | yes | 2410 | 0 | 385 | 2 | 1 | lasso×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout/halden-narrow-buffer-plans | lasso | yes | 3793 | 1152 | 317 | 3 | 3 | lasso×1 Read×1 Grep×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout/halden-narrow-buffer-plans | direct | yes | 6168 | 2432 | 321 | 3 | 4 | Grep×3 Read×1 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout/halden-narrow-buffer-plans | upload | yes | 3633 | 3200 | 125 | 1 | 0 |  | 1.7 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-trial-results | lasso | **no** | 2211 | 0 | 305 | 2 | 1 | lasso×1 | 3.2 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-trial-results | upload | **no** | 7036 | 6016 | 416 | 1 | 0 |  | 3.5 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-trial-results | direct | **no** | 5640 | 0 | 399 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-quit-rate-conflict | lasso | yes | 10617 | 1792 | 585 | 3 | 4 | lasso×1 Grep×1 Read×2 | 6.2 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-quit-rate-conflict | upload | yes | 3699 | 0 | 310 | 1 | 0 |  | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-quit-rate-conflict | direct | **no** | 2655 | 0 | 260 | 2 | 2 | Grep×2 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-heavy-smokers | upload | yes | 3134 | 1920 | 235 | 1 | 0 |  | 2.2 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-heavy-smokers | direct | yes | 6272 | 0 | 417 | 3 | 4 | Grep×1 Glob×1 Read×2 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-heavy-smokers | lasso | yes | 1855 | 0 | 280 | 2 | 1 | lasso×1 | 3.4 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-older-smokers | upload | yes | 6861 | 6400 | 240 | 1 | 0 |  | 2.5 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-older-smokers | direct | yes | 6440 | 0 | 439 | 3 | 4 | Grep×2 Read×2 | 5.1 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-older-smokers | lasso | yes | 7771 | 1152 | 465 | 3 | 3 | lasso×1 Read×1 Grep×1 | 5.7 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-pregnant-smokers | lasso | yes | 5916 | 2048 | 529 | 5 | 5 | lasso×2 Grep×3 | 7.8 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-pregnant-smokers | direct | yes | 7543 | 1152 | 350 | 3 | 5 | Grep×2 Glob×1 Read×2 | 5.0 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-pregnant-smokers | upload | yes | 3033 | 2688 | 134 | 1 | 0 |  | 1.7 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-programme-delivery | lasso | yes | 12109 | 5120 | 558 | 5 | 5 | lasso×1 Read×2 Grep×2 | 6.9 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-programme-delivery | direct | yes | 6455 | 0 | 455 | 3 | 4 | Grep×2 Read×2 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout/northfold-programme-delivery | upload | yes | 3783 | 3200 | 386 | 1 | 0 |  | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | lasso | yes | 9000 | 0 | 505 | 3 | 3 | lasso×1 Read×1 Grep×1 | 5.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | upload | yes | 3781 | 0 | 411 | 1 | 0 |  | 3.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-main-findings | direct | yes | 6347 | 0 | 482 | 3 | 3 | Glob×1 Grep×1 Read×1 | 5.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | upload | **no** | 3559 | 3200 | 183 | 1 | 0 |  | 2.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | direct | **no** | 6983 | 0 | 479 | 3 | 4 | Grep×3 Glob×1 | 6.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-cleaner-air | lasso | **no** | 11968 | 3200 | 467 | 3 | 2 | lasso×1 Read×1 | 5.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | upload | **no** | 3518 | 3200 | 148 | 1 | 0 |  | 1.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | direct | **no** | 4612 | 1024 | 395 | 4 | 5 | Grep×3 Glob×1 Read×1 | 5.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-more-walking | lasso | **no** | 8103 | 1280 | 325 | 3 | 2 | lasso×1 Read×1 | 5.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | lasso | **no** | 8540 | 0 | 354 | 3 | 3 | lasso×1 Read×1 Grep×1 | 4.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | direct | **no** | 8366 | 3328 | 561 | 5 | 6 | Grep×4 Read×2 | 8.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-moved | upload | yes | 3606 | 3200 | 236 | 1 | 0 |  | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | lasso | **no** | 2867 | 0 | 137 | 2 | 1 | lasso×1 | 2.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | direct | **no** | 3599 | 1152 | 224 | 3 | 3 | Grep×2 Read×1 | 3.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-traffic-cut-conflict | upload | yes | 3637 | 3200 | 269 | 1 | 0 |  | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | lasso | yes | 8705 | 4096 | 503 | 4 | 4 | lasso×1 Read×3 | 5.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | upload | yes | 6835 | 3200 | 203 | 1 | 0 |  | 1.8 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-gates-vs-boundary | direct | yes | 4225 | 0 | 474 | 3 | 5 | Grep×4 Read×1 | 5.6 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | lasso | **no** | 7132 | 2688 | 361 | 4 | 3 | lasso×2 Read×1 | 5.9 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | upload | **no** | 3477 | 3200 | 105 | 1 | 0 |  | 1.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-car-dropoff | direct | **no** | 3880 | 1024 | 347 | 4 | 5 | Grep×4 Read×1 | 6.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | upload | yes | 3327 | 0 | 120 | 1 | 0 |  | 1.3 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | direct | yes | 2929 | 0 | 211 | 3 | 3 | Grep×1 Glob×1 Read×1 | 3.9 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-fines | lasso | yes | 20543 | 13312 | 764 | 9 | 9 | lasso×1 Grep×5 Read×3 | 13.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | upload | **no** | 3805 | 3200 | 155 | 1 | 0 |  | 1.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | direct | **no** | 8729 | 2176 | 564 | 5 | 7 | Grep×3 Glob×2 Read×2 | 8.7 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-total-pupils | lasso | **no** | 20650 | 11776 | 652 | 5 | 6 | lasso×1 Grep×2 Read×2 Glob×1 | 8.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | lasso | yes | 23051 | 16128 | 568 | 6 | 6 | lasso×1 Grep×1 Read×2 Glob×2 | 10.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | direct | yes | 19282 | 11008 | 522 | 5 | 7 | Glob×2 Grep×2 Read×3 | 8.0 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-no2-highest-lowest | upload | **no** | 517 | 0 | 133 | 1 | 0 |  | 1.5 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | lasso | yes | 1853 | 0 | 193 | 2 | 1 | lasso×1 | 3.1 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | upload | yes | 3476 | 3200 | 108 | 1 | 0 |  | 1.4 | answered |
| 1 | gpt-5.4-mini | heldout2/ss-asthma-absent | direct | yes | 6190 | 0 | 283 | 3 | 3 | Grep×2 Read×1 | 4.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | lasso | **no** | 2594 | 0 | 213 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | upload | **no** | 3692 | 1920 | 335 | 1 | 0 |  | 2.5 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-main-findings | direct | **no** | 6459 | 0 | 402 | 3 | 4 | Glob×1 Grep×1 Read×2 | 4.9 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | upload | **no** | 3174 | 1920 | 241 | 1 | 0 |  | 2.4 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | direct | **no** | 6749 | 2432 | 336 | 3 | 4 | Grep×2 Read×2 | 4.9 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-nurse-workload | lasso | **no** | 3448 | 0 | 261 | 2 | 1 | lasso×1 | 3.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | upload | yes | 3541 | 3200 | 181 | 1 | 0 |  | 1.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | direct | yes | 7312 | 0 | 366 | 4 | 5 | Glob×2 Grep×1 Read×2 | 5.6 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-readmissions | lasso | **no** | 1842 | 0 | 161 | 2 | 1 | lasso×1 | 2.8 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | lasso | yes | 1920 | 0 | 268 | 2 | 1 | lasso×1 | 3.9 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | direct | **no** | 3589 | 1152 | 303 | 3 | 3 | Grep×2 Read×1 | 4.3 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-oldest-patients | upload | yes | 3096 | 2816 | 163 | 1 | 0 |  | 1.6 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | lasso | **no** | 1693 | 0 | 123 | 2 | 1 | lasso×1 | 2.6 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | direct | **no** | 4427 | 1664 | 246 | 3 | 3 | Grep×1 Glob×1 Read×1 | 4.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-stay-conflict | upload | yes | 3572 | 3200 | 213 | 1 | 0 |  | 2.1 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | lasso | yes | 10540 | 4224 | 328 | 5 | 4 | lasso×2 Read×2 | 6.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | upload | yes | 2998 | 2816 | 62 | 1 | 0 |  | 1.2 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-before-noon | direct | yes | 3605 | 1024 | 215 | 3 | 3 | Grep×2 Read×1 | 4.1 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | lasso | **no** | 3393 | 0 | 160 | 2 | 1 | lasso×1 | 2.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | upload | yes | 3477 | 3200 | 119 | 1 | 0 |  | 1.7 | answered |
| 1 | gpt-5.4-mini | heldout2/dp-savings-absent | direct | yes | 4629 | 1152 | 420 | 4 | 5 | Grep×4 Read×1 | 6.0 | answered |

\* capability task: needs history direct tools cannot reach; not in the comparisons.
A task whose conversation reached $0.2 was stopped there (stop "cost-cap") and counts as wrong.

