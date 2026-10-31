# Lasso evaluation (offline): baseline

Generated 2026-10-28T21:02:18.568Z, regraded 2026-10-30T17:46:31.506Z (responses unchanged) by `node scripts/agent-eval/run.mjs`. Each row is one `lasso` call with a fixed ask set, graded on the rendered response: could a careful reader complete the task from it alone? A fact counts only when all its patterns match in one sentence, record line, or table row read with its header. No model is called; token counts are estimates.

| Set | Sufficient | Material facts | Response tokens (median / p90 / max) | Share about the task | Files that state the facts, as text (median / max tokens) | Local ms (median / max) |
|---|---|---|---|---|---|---|
| dev | 8 of 24 | 16/40 | 233 / 517 / 1481 | 21% | 1800 / 2006 | 24 / 78 |
| heldout | 8 of 32 | 22/62 | 514 / 1489 / 2004 | 18% | 3412 / 3686 | 110 / 248 |
| heldout2 | 11 of 36 | 18/64 | 333 / 610 / 1724 | 23% | 3609 / 3696 | 133 / 239 |

| Set | Task | Kind | Asks | Sufficient | Material | Qualifications | Conflicts | Computed | Missing | Tokens | About the task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dev | brisk-summary | summary | "BRISK trial results", "BRISK pain difference 12 weeks", "BRISK 24 weeks" | **no** | 2/4 | 0/1 | 1/1 | 0/0 | f3, f4 | 486 | 51% |
| dev | brisk-summary | summary | "What were the main findings of the BRISK home exercise trial?" | **no** | 0/4 | 0/0 | 0/1 | 0/0 | f1, f2, f3, f4 | 123 | 0% |
| dev | brisk-six-months | summary | "BRISK long-term pain", "BRISK 24-week outcome" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f4 | 332 | 0% |
| dev | brisk-six-months | summary | "Did the benefit of the BRISK programme last after six months?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f4 | 227 | 0% |
| dev | brisk-older | qualified | "BRISK age 70 subgroup" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 96 | 79% |
| dev | brisk-older | qualified | "Was the BRISK programme effective for older adults?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f8 | 188 | 0% |
| dev | brisk-size | lookup | "BRISK number randomised" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 311 | 46% |
| dev | brisk-size | lookup | "How many participants were in BRISK?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 141 | 28% |
| dev | brisk-adverse-total | aggregate | "BRISK adverse events total" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 426 | 0% |
| dev | brisk-adverse-total | aggregate | "How many adverse events were reported in the BRISK trial overall?" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 185 | 0% |
| dev | brisk-best-site | aggregate | "BRISK site completion" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 132 | 59% |
| dev | brisk-best-site | aggregate | "Which clinic in BRISK had the best 12-week follow-up?" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 303 | 0% |
| dev | brisk-conflict | conflict | "BRISK pain improvement memo", "BRISK pain difference report" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 258 | 41% |
| dev | brisk-conflict | conflict | "What pain improvement did BRISK report, and does the memo agree?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 126 | 54% |
| dev | brisk-vs-walkon | compare | "BRISK results", "WALK-ON results" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, w1 | 284 | 0% |
| dev | brisk-vs-walkon | compare | "Compare BRISK with the WALK-ON walking study." | **no** | 1/2 | 0/0 | 0/0 | 0/0 | f1 | 233 | 69% |
| dev | brisk-depression | absent | "BRISK depression" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 517 | 0% |
| dev | brisk-depression | absent | "Did BRISK measure depression or mood?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 525 | 0% |
| dev | brisk-limitations | summary | "BRISK limitations" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | l1, l2, l3 | 342 | 0% |
| dev | brisk-limitations | summary | "What weaknesses does the BRISK report acknowledge?" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 1481 | 12% |
| dev | brisk-harms | summary | "BRISK adverse events" | **no** | 2/3 | 0/0 | 0/0 | 0/0 | f5 | 426 | 12% |
| dev | brisk-harms | summary | "Were there any side effects of the BRISK exercises?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f5, h1, h2 | 165 | 0% |
| dev | walkon-summary | summary | "WALK-ON findings" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 233 | 63% |
| dev | walkon-summary | summary | "What did the WALK-ON cohort find about walking and knee pain?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | w0, w1, w4 | 64 | 0% |
| heldout | halden-buffer-findings | summary | "Halden Vale buffer monitoring findings", "riparian buffer water quality results" | **no** | 0/5 | 0/0 | 0/1 | 0/0 | f1, f3, f4, f6, f7 | 443 | 0% |
| heldout | halden-buffer-findings | summary | "What did the Halden Vale stream buffer monitoring find?" | **no** | 2/5 | 1/1 | 0/1 | 0/0 | f1, f4, f7 | 1343 | 29% |
| heldout | halden-nitrate-headline | conflict | "Halden nitrate reduction buffers", "nitrate percent change restored streams" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f2 | 433 | 19% |
| heldout | halden-nitrate-headline | conflict | "How much did nitrate go down where the buffers were planted?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f2 | 546 | 26% |
| heldout | halden-phosphorus | qualified | "Halden phosphorus buffers", "phosphorus change restored versus control streams" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 549 | 0% |
| heldout | halden-phosphorus | qualified | "Did phosphorus levels drop in the streams with the new buffers?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 310 | 0% |
| heldout | halden-water-temperature | lookup | "Halden summer water temperature", "stream temperature after tree planting" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, f2 | 383 | 0% |
| heldout | halden-water-temperature | lookup | "Did the streams get cooler in summer after the trees were planted?" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, f2 | 194 | 0% |
| heldout | halden-buffer-width | compare | "buffer width effect nitrate", "wide versus narrow buffer results" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 562 | 12% |
| heldout | halden-buffer-width | compare | "Do wider strips of trees along streams work better than narrow ones?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 429 | 0% |
| heldout | halden-stream-life | summary | "Halden invertebrates stream ecology", "aquatic insects restored streams" | **no** | 1/2 | 1/1 | 0/0 | 0/0 | f3 | 1489 | 26% |
| heldout | halden-stream-life | summary | "Did insect and other stream life improve after the restoration?" | **no** | 1/2 | 1/1 | 0/0 | 0/0 | f3 | 1343 | 29% |
| heldout | halden-fish | absent | "Halden fish trout survey", "fish populations restored streams" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 232 | 59% |
| heldout | halden-fish | absent | "Did the Halden study find any change in fish such as trout?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 142 | 48% |
| heldout | halden-reach-extremes | aggregate | "Halden nitrate by site spreadsheet", "site nitrate 2021 2024" | yes | 2/2 | 0/0 | 0/0 | 1/1 |  | 761 | 8% |
| heldout | halden-reach-extremes | aggregate | "Which site had the biggest drop in nitrate, and which had the highest nitrate in 2024?" | yes | 2/2 | 0/0 | 0/0 | 1/1 |  | 533 | 6% |
| heldout | halden-reach-averages | aggregate | "Halden site buffer widths", "restored control sites nitrate 2024" | yes | 0/0 | 0/0 | 0/0 | 3/3 |  | 755 | 25% |
| heldout | halden-reach-averages | aggregate | "What were the buffer widths and 2024 nitrate levels at each restored and control site?" | **no** | 0/0 | 0/0 | 0/0 | 1/3 |  | 545 | 0% |
| heldout | halden-narrow-buffer-plans | lookup | "Eastwick Bridge Fallow Hill buffers", "narrow buffers decision steering group" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 260 | 26% |
| heldout | halden-narrow-buffer-plans | lookup | "What was decided about the stream sites with narrow buffers?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 304 | 31% |
| heldout | northfold-trial-results | summary | "Northfold pharmacy stop smoking trial results", "quit rates programme versus control" | **no** | 1/3 | 0/0 | 0/0 | 0/0 | f3, f5 | 1848 | 14% |
| heldout | northfold-trial-results | summary | "What did the evaluation of the pharmacy stop-smoking programme find?" | **no** | 2/3 | 0/0 | 0/0 | 0/0 | f5 | 2004 | 20% |
| heldout | northfold-quit-rate-conflict | conflict | "pharmacy stop smoking one year quit rate", "12 month quit rate memo" | **no** | 0/2 | 0/0 | 0/1 | 0/0 | f1, f2 | 852 | 0% |
| heldout | northfold-quit-rate-conflict | conflict | "What share of people on the pharmacy programme were still not smoking after a year?" | **no** | 0/2 | 0/0 | 0/1 | 0/0 | f1, f2 | 139 | 0% |
| heldout | northfold-heavy-smokers | qualified | "heavy smokers results stop smoking programme", "quit rate by cigarettes per day" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 594 | 0% |
| heldout | northfold-heavy-smokers | qualified | "Did the stop-smoking programme work for people who smoke a lot?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 417 | 0% |
| heldout | northfold-older-smokers | summary | "older smokers quit rate pharmacy programme", "results by age group" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 518 | 13% |
| heldout | northfold-older-smokers | summary | "Did the pharmacy quit-smoking programme work for older people?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 430 | 0% |
| heldout | northfold-pregnant-smokers | absent | "pregnant smokers pharmacy programme", "pregnancy stop smoking results" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1641 | 18% |
| heldout | northfold-pregnant-smokers | absent | "How did pregnant women do on the pharmacy stop-smoking programme?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 240 | 90% |
| heldout | northfold-programme-delivery | summary | "session attendance medication choice side effects", "varenicline nicotine patches uptake" | **no** | 2/4 | 0/0 | 0/0 | 0/0 | f2, f3 | 514 | 28% |
| heldout | northfold-programme-delivery | summary | "How many sessions did people attend, which quit-smoking medicines did they use, and were there side effects?" | **no** | 2/4 | 0/0 | 0/0 | 0/0 | f2, f3 | 376 | 39% |
| heldout2 | ss-main-findings | summary | "school streets pilot results traffic NO2", "school streets walking cycling boundary roads" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f1, f4, f5 | 297 | 33% |
| heldout2 | ss-main-findings | summary | "What were the main findings of the School Streets pilot evaluation?" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f1, f4, f5 | 1724 | 4% |
| heldout2 | ss-cleaner-air | summary | "school gate NO2 change pilot", "hourly air quality restriction hours" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 354 | 0% |
| heldout2 | ss-cleaner-air | summary | "Did air pollution outside the schools go down when the streets were closed?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 186 | 0% |
| heldout2 | ss-more-walking | summary | "active travel mode share school streets", "hands-up survey walking cycling" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, f2 | 692 | 0% |
| heldout2 | ss-more-walking | summary | "Did more pupils walk, cycle or scoot to school after the School Streets started?" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, f2 | 237 | 0% |
| heldout2 | ss-traffic-moved | qualified | "traffic displacement boundary roads", "diverted traffic nearby roads school streets" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 333 | 0% |
| heldout2 | ss-traffic-moved | qualified | "Did traffic increase on the roads surrounding the School Streets?" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 142 | 84% |
| heldout2 | ss-traffic-cut-conflict | conflict | "closed streets traffic reduction percent", "vehicle counts restriction hours school streets" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 454 | 16% |
| heldout2 | ss-traffic-cut-conflict | conflict | "How much did motor traffic on the closed streets drop during the School Streets pilot?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f2 | 176 | 31% |
| heldout2 | ss-gates-vs-boundary | compare | "NO2 school gate boundary road comparison", "nitrogen dioxide by monitoring location" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, f2 | 468 | 0% |
| heldout2 | ss-gates-vs-boundary | compare | "Was the change in air pollution at the school gates different from the change on nearby main roads?" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, f2 | 404 | 0% |
| heldout2 | ss-car-dropoff | lookup | "car mode share pupils pilot survey", "school run by car percentage" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 610 | 0% |
| heldout2 | ss-car-dropoff | lookup | "What percentage of children travelled to school by car during the pilot?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 151 | 0% |
| heldout2 | ss-fines | lookup | "school streets penalty charge notices issued", "enforcement camera fines closures" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 374 | 15% |
| heldout2 | ss-fines | lookup | "How many penalty notices were issued to drivers entering the School Streets?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 315 | 28% |
| heldout2 | ss-total-pupils | aggregate | "pupils on roll pilot schools", "school streets site data" | yes | 0/0 | 0/0 | 0/0 | 2/2 |  | 566 | 77% |
| heldout2 | ss-total-pupils | aggregate | "How many pupils are on roll at each of the School Streets pilot schools?" | yes | 0/0 | 0/0 | 0/0 | 2/2 |  | 293 | 74% |
| heldout2 | ss-no2-highest-lowest | aggregate | "gate NO2 by school pilot period", "highest lowest NO2 school site" | yes | 2/2 | 0/0 | 0/0 | 2/2 |  | 730 | 30% |
| heldout2 | ss-no2-highest-lowest | aggregate | "Which pilot school had the highest and which the lowest nitrogen dioxide at the gate in 2025?" | **no** | 0/2 | 0/0 | 0/0 | 0/2 | r3, r10 | 231 | 0% |
| heldout2 | ss-asthma-absent | absent | "school streets asthma pupils", "children health outcomes respiratory" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 401 | 87% |
| heldout2 | ss-asthma-absent | absent | "Did the School Streets evaluation report any effect on children's asthma?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 326 | 22% |
| heldout2 | dp-main-findings | summary | "nurse-led discharge evaluation results", "length of stay readmission discharge coordinator" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f2, f3, f4 | 444 | 24% |
| heldout2 | dp-main-findings | summary | "What were the main results of the nurse-led discharge planning evaluation?" | **no** | 0/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3, f4 | 84 | 0% |
| heldout2 | dp-nurse-workload | summary | "nurse workload discharge coordinator time", "staff survey workload ward nurses" | **no** | 1/4 | 1/1 | 0/0 | 0/0 | f1, f2, f4 | 572 | 31% |
| heldout2 | dp-nurse-workload | summary | "How did nurse-led discharge planning affect the ward nurses' workload and time?" | **no** | 1/4 | 1/1 | 0/0 | 0/0 | f1, f2, f4 | 389 | 46% |
| heldout2 | dp-readmissions | qualified | "30-day readmission nurse-led discharge", "readmission rate control intervention" | **no** | 1/1 | 0/1 | 0/0 | 0/0 |  | 411 | 23% |
| heldout2 | dp-readmissions | qualified | "Did emergency readmissions within 30 days change under nurse-led discharge planning?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 381 | 0% |
| heldout2 | dp-oldest-patients | qualified | "length of stay age 80 subgroup", "older patients discharge planning effect" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 319 | 63% |
| heldout2 | dp-oldest-patients | qualified | "Did nurse-led discharge planning have a bigger effect for the oldest patients?" | **no** | 1/2 | 0/0 | 0/0 | 0/0 | f1 | 191 | 36% |
| heldout2 | dp-stay-conflict | conflict | "length of stay reduction days nurse-led discharge", "board briefing length of stay" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f2 | 315 | 20% |
| heldout2 | dp-stay-conflict | conflict | "By how many days did average length of stay fall under the nurse-led discharge model?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f2 | 279 | 23% |
| heldout2 | dp-before-noon | lookup | "discharged before noon percentage", "discharge timing intervention period" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 520 | 0% |
| heldout2 | dp-before-noon | lookup | "What proportion of patients were discharged before noon under the new model?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 96 | 0% |
| heldout2 | dp-savings-absent | absent | "cost savings nurse-led discharge", "economic evaluation coordinator posts cost" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 260 | 51% |
| heldout2 | dp-savings-absent | absent | "Did nurse-led discharge planning save the hospital money, and how much?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 427 | 0% |
