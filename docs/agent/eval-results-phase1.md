# Lasso evaluation (offline): phase1

Generated 2026-10-28T21:02:26.513Z, regraded 2026-10-30T17:46:31.622Z (responses unchanged) by `node scripts/agent-eval/run.mjs`. Each row is one `lasso` call with a fixed ask set, graded on the rendered response: could a careful reader complete the task from it alone? A fact counts only when all its patterns match in one sentence, record line, or table row read with its header. No model is called; token counts are estimates.

| Set | Sufficient | Material facts | Response tokens (median / p90 / max) | Share about the task | Files that state the facts, as text (median / max tokens) | Local ms (median / max) |
|---|---|---|---|---|---|---|
| dev | 15 of 24 | 26/40 | 306 / 718 / 1294 | 19% | 1800 / 2006 | 4 / 40 |
| heldout | 14 of 32 | 36/62 | 699 / 1704 / 2122 | 13% | 3412 / 3686 | 11 / 53 |
| heldout2 | 29 of 36 | 48/64 | 1009 / 1950 / 2010 | 15% | 3609 / 3696 | 13 / 46 |

| Set | Task | Kind | Asks | Sufficient | Material | Qualifications | Conflicts | Computed | Missing | Tokens | About the task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dev | brisk-summary | summary | "BRISK trial results", "BRISK pain difference 12 weeks", "BRISK 24 weeks" | **no** | 3/4 | 0/1 | 1/1 | 0/0 | f3 | 1294 | 19% |
| dev | brisk-summary | summary | "What were the main findings of the BRISK home exercise trial?" | **no** | 1/4 | 0/0 | 0/1 | 0/0 | f1, f3, f4 | 237 | 22% |
| dev | brisk-six-months | summary | "BRISK long-term pain", "BRISK 24-week outcome" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 615 | 12% |
| dev | brisk-six-months | summary | "Did the benefit of the BRISK programme last after six months?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f4 | 296 | 0% |
| dev | brisk-older | qualified | "BRISK age 70 subgroup" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 206 | 33% |
| dev | brisk-older | qualified | "Was the BRISK programme effective for older adults?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f8 | 593 | 0% |
| dev | brisk-size | lookup | "BRISK number randomised" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 327 | 41% |
| dev | brisk-size | lookup | "How many participants were in BRISK?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 646 | 21% |
| dev | brisk-adverse-total | aggregate | "BRISK adverse events total" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 312 | 3% |
| dev | brisk-adverse-total | aggregate | "How many adverse events were reported in the BRISK trial overall?" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 345 | 2% |
| dev | brisk-best-site | aggregate | "BRISK site completion" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 78 | 0% |
| dev | brisk-best-site | aggregate | "Which clinic in BRISK had the best 12-week follow-up?" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 539 | 0% |
| dev | brisk-conflict | conflict | "BRISK pain improvement memo", "BRISK pain difference report" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1173 | 16% |
| dev | brisk-conflict | conflict | "What pain improvement did BRISK report, and does the memo agree?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 306 | 34% |
| dev | brisk-vs-walkon | compare | "BRISK results", "WALK-ON results" | yes | 2/2 | 0/0 | 0/0 | 0/0 |  | 718 | 27% |
| dev | brisk-vs-walkon | compare | "Compare BRISK with the WALK-ON walking study." | **no** | 1/2 | 0/0 | 0/0 | 0/0 | f1 | 272 | 53% |
| dev | brisk-depression | absent | "BRISK depression" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 263 | 0% |
| dev | brisk-depression | absent | "Did BRISK measure depression or mood?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 152 | 0% |
| dev | brisk-limitations | summary | "BRISK limitations" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 115 | 61% |
| dev | brisk-limitations | summary | "What weaknesses does the BRISK report acknowledge?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | l1, l2, l3 | 262 | 0% |
| dev | brisk-harms | summary | "BRISK adverse events" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 314 | 17% |
| dev | brisk-harms | summary | "Were there any side effects of the BRISK exercises?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f5, h1, h2 | 341 | 0% |
| dev | walkon-summary | summary | "WALK-ON findings" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 275 | 47% |
| dev | walkon-summary | summary | "What did the WALK-ON cohort find about walking and knee pain?" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 268 | 48% |
| heldout | halden-buffer-findings | summary | "Halden Vale buffer monitoring findings", "riparian buffer water quality results" | **no** | 2/5 | 1/2 | 0/1 | 0/0 | f1, f3, f7 | 1497 | 8% |
| heldout | halden-buffer-findings | summary | "What did the Halden Vale stream buffer monitoring find?" | **no** | 2/5 | 0/1 | 0/1 | 0/0 | f1, f4, f7 | 699 | 35% |
| heldout | halden-nitrate-headline | conflict | "Halden nitrate reduction buffers", "nitrate percent change restored streams" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 931 | 26% |
| heldout | halden-nitrate-headline | conflict | "How much did nitrate go down where the buffers were planted?" | **no** | 0/2 | 0/0 | 0/1 | 0/0 | f1, f2 | 332 | 0% |
| heldout | halden-phosphorus | qualified | "Halden phosphorus buffers", "phosphorus change restored versus control streams" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1910 | 9% |
| heldout | halden-phosphorus | qualified | "Did phosphorus levels drop in the streams with the new buffers?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 337 | 13% |
| heldout | halden-water-temperature | lookup | "Halden summer water temperature", "stream temperature after tree planting" | yes | 2/2 | 0/0 | 0/0 | 0/0 |  | 999 | 3% |
| heldout | halden-water-temperature | lookup | "Did the streams get cooler in summer after the trees were planted?" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, f2 | 300 | 0% |
| heldout | halden-buffer-width | compare | "buffer width effect nitrate", "wide versus narrow buffer results" | yes | 3/3 | 1/1 | 0/0 | 0/0 |  | 1707 | 25% |
| heldout | halden-buffer-width | compare | "Do wider strips of trees along streams work better than narrow ones?" | **no** | 2/3 | 0/1 | 0/0 | 0/0 | f3 | 351 | 24% |
| heldout | halden-stream-life | summary | "Halden invertebrates stream ecology", "aquatic insects restored streams" | **no** | 1/2 | 1/1 | 0/0 | 0/0 | f3 | 1228 | 27% |
| heldout | halden-stream-life | summary | "Did insect and other stream life improve after the restoration?" | **no** | 0/2 | 0/0 | 0/0 | 0/0 | f1, f3 | 287 | 18% |
| heldout | halden-fish | absent | "Halden fish trout survey", "fish populations restored streams" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 358 | 11% |
| heldout | halden-fish | absent | "Did the Halden study find any change in fish such as trout?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 322 | 11% |
| heldout | halden-reach-extremes | aggregate | "Halden nitrate by site spreadsheet", "site nitrate 2021 2024" | yes | 2/2 | 0/0 | 0/0 | 1/1 |  | 553 | 5% |
| heldout | halden-reach-extremes | aggregate | "Which site had the biggest drop in nitrate, and which had the highest nitrate in 2024?" | yes | 2/2 | 0/0 | 0/0 | 1/1 |  | 491 | 4% |
| heldout | halden-reach-averages | aggregate | "Halden site buffer widths", "restored control sites nitrate 2024" | yes | 0/0 | 0/0 | 0/0 | 3/3 |  | 994 | 19% |
| heldout | halden-reach-averages | aggregate | "What were the buffer widths and 2024 nitrate levels at each restored and control site?" | yes | 0/0 | 0/0 | 0/0 | 3/3 |  | 581 | 32% |
| heldout | halden-narrow-buffer-plans | lookup | "Eastwick Bridge Fallow Hill buffers", "narrow buffers decision steering group" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 591 | 23% |
| heldout | halden-narrow-buffer-plans | lookup | "What was decided about the stream sites with narrow buffers?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 303 | 0% |
| heldout | northfold-trial-results | summary | "Northfold pharmacy stop smoking trial results", "quit rates programme versus control" | **no** | 2/3 | 0/0 | 0/0 | 0/0 | f5 | 1525 | 20% |
| heldout | northfold-trial-results | summary | "What did the evaluation of the pharmacy stop-smoking programme find?" | **no** | 2/3 | 0/0 | 0/0 | 0/0 | f5 | 1266 | 19% |
| heldout | northfold-quit-rate-conflict | conflict | "pharmacy stop smoking one year quit rate", "12 month quit rate memo" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 1369 | 4% |
| heldout | northfold-quit-rate-conflict | conflict | "What share of people on the pharmacy programme were still not smoking after a year?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 511 | 12% |
| heldout | northfold-heavy-smokers | qualified | "heavy smokers results stop smoking programme", "quit rate by cigarettes per day" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1604 | 15% |
| heldout | northfold-heavy-smokers | qualified | "Did the stop-smoking programme work for people who smoke a lot?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 338 | 0% |
| heldout | northfold-older-smokers | summary | "older smokers quit rate pharmacy programme", "results by age group" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 2122 | 6% |
| heldout | northfold-older-smokers | summary | "Did the pharmacy quit-smoking programme work for older people?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 356 | 0% |
| heldout | northfold-pregnant-smokers | absent | "pregnant smokers pharmacy programme", "pregnancy stop smoking results" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1704 | 3% |
| heldout | northfold-pregnant-smokers | absent | "How did pregnant women do on the pharmacy stop-smoking programme?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 741 | 8% |
| heldout | northfold-programme-delivery | summary | "session attendance medication choice side effects", "varenicline nicotine patches uptake" | **no** | 2/4 | 1/1 | 0/0 | 0/0 | f2, f3 | 921 | 13% |
| heldout | northfold-programme-delivery | summary | "How many sessions did people attend, which quit-smoking medicines did they use, and were there side effects?" | **no** | 3/4 | 1/1 | 0/0 | 0/0 | f3 | 719 | 24% |
| heldout2 | ss-main-findings | summary | "school streets pilot results traffic NO2", "school streets walking cycling boundary roads" | yes | 4/4 | 1/1 | 0/0 | 0/0 |  | 2009 | 27% |
| heldout2 | ss-main-findings | summary | "What were the main findings of the School Streets pilot evaluation?" | **no** | 1/4 | 1/1 | 0/0 | 0/0 | f1, f2, f4 | 1118 | 18% |
| heldout2 | ss-cleaner-air | summary | "school gate NO2 change pilot", "hourly air quality restriction hours" | **no** | 2/3 | 1/1 | 0/0 | 0/0 | f1 | 1972 | 15% |
| heldout2 | ss-cleaner-air | summary | "Did air pollution outside the schools go down when the streets were closed?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 326 | 0% |
| heldout2 | ss-more-walking | summary | "active travel mode share school streets", "hands-up survey walking cycling" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 1461 | 13% |
| heldout2 | ss-more-walking | summary | "Did more pupils walk, cycle or scoot to school after the School Streets started?" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 346 | 32% |
| heldout2 | ss-traffic-moved | qualified | "traffic displacement boundary roads", "diverted traffic nearby roads school streets" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1461 | 16% |
| heldout2 | ss-traffic-moved | qualified | "Did traffic increase on the roads surrounding the School Streets?" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1009 | 16% |
| heldout2 | ss-traffic-cut-conflict | conflict | "closed streets traffic reduction percent", "vehicle counts restriction hours school streets" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 966 | 14% |
| heldout2 | ss-traffic-cut-conflict | conflict | "How much did motor traffic on the closed streets drop during the School Streets pilot?" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 975 | 13% |
| heldout2 | ss-gates-vs-boundary | compare | "NO2 school gate boundary road comparison", "nitrogen dioxide by monitoring location" | yes | 2/2 | 0/0 | 0/0 | 0/0 |  | 1410 | 18% |
| heldout2 | ss-gates-vs-boundary | compare | "Was the change in air pollution at the school gates different from the change on nearby main roads?" | yes | 2/2 | 0/0 | 0/0 | 0/0 |  | 1059 | 19% |
| heldout2 | ss-car-dropoff | lookup | "car mode share pupils pilot survey", "school run by car percentage" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 983 | 1% |
| heldout2 | ss-car-dropoff | lookup | "What percentage of children travelled to school by car during the pilot?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1008 | 0% |
| heldout2 | ss-fines | lookup | "school streets penalty charge notices issued", "enforcement camera fines closures" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 593 | 11% |
| heldout2 | ss-fines | lookup | "How many penalty notices were issued to drivers entering the School Streets?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 616 | 17% |
| heldout2 | ss-total-pupils | aggregate | "pupils on roll pilot schools", "school streets site data" | yes | 0/0 | 0/0 | 0/0 | 2/2 |  | 1589 | 27% |
| heldout2 | ss-total-pupils | aggregate | "How many pupils are on roll at each of the School Streets pilot schools?" | yes | 0/0 | 0/0 | 0/0 | 2/2 |  | 1345 | 16% |
| heldout2 | ss-no2-highest-lowest | aggregate | "gate NO2 by school pilot period", "highest lowest NO2 school site" | yes | 2/2 | 0/0 | 0/0 | 2/2 |  | 1950 | 11% |
| heldout2 | ss-no2-highest-lowest | aggregate | "Which pilot school had the highest and which the lowest nitrogen dioxide at the gate in 2025?" | **no** | 0/2 | 0/0 | 0/0 | 0/2 | r3, r10 | 723 | 0% |
| heldout2 | ss-asthma-absent | absent | "school streets asthma pupils", "children health outcomes respiratory" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 1222 | 15% |
| heldout2 | ss-asthma-absent | absent | "Did the School Streets evaluation report any effect on children's asthma?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 983 | 6% |
| heldout2 | dp-main-findings | summary | "nurse-led discharge evaluation results", "length of stay readmission discharge coordinator" | **no** | 3/4 | 1/1 | 0/0 | 0/0 | f4 | 2010 | 17% |
| heldout2 | dp-main-findings | summary | "What were the main results of the nurse-led discharge planning evaluation?" | **no** | 0/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3, f4 | 1127 | 7% |
| heldout2 | dp-nurse-workload | summary | "nurse workload discharge coordinator time", "staff survey workload ward nurses" | yes | 4/4 | 1/1 | 0/0 | 0/0 |  | 1210 | 25% |
| heldout2 | dp-nurse-workload | summary | "How did nurse-led discharge planning affect the ward nurses' workload and time?" | **no** | 2/4 | 1/1 | 0/0 | 0/0 | f1, f4 | 276 | 41% |
| heldout2 | dp-readmissions | qualified | "30-day readmission nurse-led discharge", "readmission rate control intervention" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1791 | 16% |
| heldout2 | dp-readmissions | qualified | "Did emergency readmissions within 30 days change under nurse-led discharge planning?" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 780 | 17% |
| heldout2 | dp-oldest-patients | qualified | "length of stay age 80 subgroup", "older patients discharge planning effect" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 917 | 17% |
| heldout2 | dp-oldest-patients | qualified | "Did nurse-led discharge planning have a bigger effect for the oldest patients?" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 272 | 39% |
| heldout2 | dp-stay-conflict | conflict | "length of stay reduction days nurse-led discharge", "board briefing length of stay" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1657 | 12% |
| heldout2 | dp-stay-conflict | conflict | "By how many days did average length of stay fall under the nurse-led discharge model?" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 997 | 16% |
| heldout2 | dp-before-noon | lookup | "discharged before noon percentage", "discharge timing intervention period" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1582 | 3% |
| heldout2 | dp-before-noon | lookup | "What proportion of patients were discharged before noon under the new model?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 498 | 5% |
| heldout2 | dp-savings-absent | absent | "cost savings nurse-led discharge", "economic evaluation coordinator posts cost" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 1321 | 7% |
| heldout2 | dp-savings-absent | absent | "Did nurse-led discharge planning save the hospital money, and how much?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 317 | 0% |
