# Lasso evaluation (offline): pdf-gap

Generated 2026-10-30T23:09:16.864Z by `node scripts/agent-eval/run.mjs`. Each row is one `lasso` call with a fixed ask set, graded on the rendered response: could a careful reader complete the task from it alone? A fact counts only when all its patterns match in one sentence, record line, or table row read with its header. No model is called; token counts are estimates.

| Set | Sufficient | Material facts | Response tokens (median / p90 / max) | Share about the task | Files that state the facts, as text (median / max tokens) | Local ms (median / max) |
|---|---|---|---|---|---|---|
| dev | 15 of 24 | 26/40 | 312 / 1121 / 1259 | 19% | 1800 / 2006 | 5 / 41 |
| heldout | 18 of 32 | 46/62 | 1091 / 1868 / 2093 | 16% | 3412 / 3686 | 11 / 45 |
| heldout2 | 31 of 36 | 56/64 | 1103 / 1887 / 1955 | 17% | 3609 / 3696 | 13 / 46 |
| heldout3 | 20 of 36 | 38/62 | 921 / 1548 / 1953 | 14% | 2494 / 3231 | 10 / 42 |

| Set | Task | Kind | Asks | Sufficient | Material | Qualifications | Conflicts | Computed | Missing | Tokens | About the task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dev | brisk-summary | summary | "BRISK trial results", "BRISK pain difference 12 weeks", "BRISK 24 weeks" | **no** | 3/4 | 0/1 | 1/1 | 0/0 | f3 | 1259 | 20% |
| dev | brisk-summary | summary | "What were the main findings of the BRISK home exercise trial?" | **no** | 1/4 | 0/0 | 0/1 | 0/0 | f1, f3, f4 | 236 | 20% |
| dev | brisk-six-months | summary | "BRISK long-term pain", "BRISK 24-week outcome" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1121 | 7% |
| dev | brisk-six-months | summary | "Did the benefit of the BRISK programme last after six months?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f4 | 609 | 0% |
| dev | brisk-older | qualified | "BRISK age 70 subgroup" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 206 | 33% |
| dev | brisk-older | qualified | "Was the BRISK programme effective for older adults?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f8 | 516 | 0% |
| dev | brisk-size | lookup | "BRISK number randomised" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 291 | 45% |
| dev | brisk-size | lookup | "How many participants were in BRISK?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 638 | 21% |
| dev | brisk-adverse-total | aggregate | "BRISK adverse events total" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 312 | 3% |
| dev | brisk-adverse-total | aggregate | "How many adverse events were reported in the BRISK trial overall?" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 346 | 2% |
| dev | brisk-best-site | aggregate | "BRISK site completion" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 78 | 0% |
| dev | brisk-best-site | aggregate | "Which clinic in BRISK had the best 12-week follow-up?" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 535 | 0% |
| dev | brisk-conflict | conflict | "BRISK pain improvement memo", "BRISK pain difference report" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1175 | 15% |
| dev | brisk-conflict | conflict | "What pain improvement did BRISK report, and does the memo agree?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 617 | 16% |
| dev | brisk-vs-walkon | compare | "BRISK results", "WALK-ON results" | yes | 2/2 | 0/0 | 0/0 | 0/0 |  | 722 | 27% |
| dev | brisk-vs-walkon | compare | "Compare BRISK with the WALK-ON walking study." | **no** | 1/2 | 0/0 | 0/0 | 0/0 | f1 | 273 | 53% |
| dev | brisk-depression | absent | "BRISK depression" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 263 | 0% |
| dev | brisk-depression | absent | "Did BRISK measure depression or mood?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 147 | 0% |
| dev | brisk-limitations | summary | "BRISK limitations" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 115 | 61% |
| dev | brisk-limitations | summary | "What weaknesses does the BRISK report acknowledge?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | l1, l2, l3 | 262 | 0% |
| dev | brisk-harms | summary | "BRISK adverse events" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 314 | 16% |
| dev | brisk-harms | summary | "Were there any side effects of the BRISK exercises?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f5, h1, h2 | 406 | 0% |
| dev | walkon-summary | summary | "WALK-ON findings" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 220 | 58% |
| dev | walkon-summary | summary | "What did the WALK-ON cohort find about walking and knee pain?" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 249 | 51% |
| heldout | halden-buffer-findings | summary | "Halden Vale buffer monitoring findings", "riparian buffer water quality results" | **no** | 4/5 | 2/2 | 1/1 | 0/0 | f7 | 1868 | 35% |
| heldout | halden-buffer-findings | summary | "What did the Halden Vale stream buffer monitoring find?" | **no** | 2/5 | 0/1 | 0/1 | 0/0 | f1, f4, f7 | 699 | 35% |
| heldout | halden-nitrate-headline | conflict | "Halden nitrate reduction buffers", "nitrate percent change restored streams" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1467 | 19% |
| heldout | halden-nitrate-headline | conflict | "How much did nitrate go down where the buffers were planted?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 962 | 10% |
| heldout | halden-phosphorus | qualified | "Halden phosphorus buffers", "phosphorus change restored versus control streams" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1945 | 8% |
| heldout | halden-phosphorus | qualified | "Did phosphorus levels drop in the streams with the new buffers?" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1091 | 19% |
| heldout | halden-water-temperature | lookup | "Halden summer water temperature", "stream temperature after tree planting" | yes | 2/2 | 0/0 | 0/0 | 0/0 |  | 981 | 4% |
| heldout | halden-water-temperature | lookup | "Did the streams get cooler in summer after the trees were planted?" | **no** | 1/2 | 0/0 | 0/0 | 0/0 | f2 | 668 | 2% |
| heldout | halden-buffer-width | compare | "buffer width effect nitrate", "wide versus narrow buffer results" | yes | 3/3 | 1/1 | 0/0 | 0/0 |  | 1519 | 36% |
| heldout | halden-buffer-width | compare | "Do wider strips of trees along streams work better than narrow ones?" | yes | 3/3 | 1/1 | 0/0 | 0/0 |  | 1041 | 22% |
| heldout | halden-stream-life | summary | "Halden invertebrates stream ecology", "aquatic insects restored streams" | **no** | 1/2 | 1/1 | 0/0 | 0/0 | f3 | 1297 | 25% |
| heldout | halden-stream-life | summary | "Did insect and other stream life improve after the restoration?" | **no** | 1/2 | 0/0 | 0/0 | 0/0 | f1 | 1093 | 9% |
| heldout | halden-fish | absent | "Halden fish trout survey", "fish populations restored streams" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1060 | 4% |
| heldout | halden-fish | absent | "Did the Halden study find any change in fish such as trout?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 397 | 33% |
| heldout | halden-reach-extremes | aggregate | "Halden nitrate by site spreadsheet", "site nitrate 2021 2024" | yes | 2/2 | 0/0 | 0/0 | 1/1 |  | 1323 | 2% |
| heldout | halden-reach-extremes | aggregate | "Which site had the biggest drop in nitrate, and which had the highest nitrate in 2024?" | yes | 2/2 | 0/0 | 0/0 | 1/1 |  | 521 | 4% |
| heldout | halden-reach-averages | aggregate | "Halden site buffer widths", "restored control sites nitrate 2024" | yes | 0/0 | 0/0 | 0/0 | 3/3 |  | 2004 | 9% |
| heldout | halden-reach-averages | aggregate | "What were the buffer widths and 2024 nitrate levels at each restored and control site?" | yes | 0/0 | 0/0 | 0/0 | 3/3 |  | 1292 | 14% |
| heldout | halden-narrow-buffer-plans | lookup | "Eastwick Bridge Fallow Hill buffers", "narrow buffers decision steering group" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 586 | 23% |
| heldout | halden-narrow-buffer-plans | lookup | "What was decided about the stream sites with narrow buffers?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 896 | 20% |
| heldout | northfold-trial-results | summary | "Northfold pharmacy stop smoking trial results", "quit rates programme versus control" | **no** | 2/3 | 0/0 | 0/0 | 0/0 | f5 | 1428 | 21% |
| heldout | northfold-trial-results | summary | "What did the evaluation of the pharmacy stop-smoking programme find?" | **no** | 2/3 | 0/0 | 0/0 | 0/0 | f5 | 1266 | 19% |
| heldout | northfold-quit-rate-conflict | conflict | "pharmacy stop smoking one year quit rate", "12 month quit rate memo" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 1671 | 3% |
| heldout | northfold-quit-rate-conflict | conflict | "What share of people on the pharmacy programme were still not smoking after a year?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 459 | 13% |
| heldout | northfold-heavy-smokers | qualified | "heavy smokers results stop smoking programme", "quit rate by cigarettes per day" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1626 | 15% |
| heldout | northfold-heavy-smokers | qualified | "Did the stop-smoking programme work for people who smoke a lot?" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1052 | 17% |
| heldout | northfold-older-smokers | summary | "older smokers quit rate pharmacy programme", "results by age group" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 2093 | 6% |
| heldout | northfold-older-smokers | summary | "Did the pharmacy quit-smoking programme work for older people?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 1085 | 13% |
| heldout | northfold-pregnant-smokers | absent | "pregnant smokers pharmacy programme", "pregnancy stop smoking results" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1709 | 3% |
| heldout | northfold-pregnant-smokers | absent | "How did pregnant women do on the pharmacy stop-smoking programme?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 640 | 9% |
| heldout | northfold-programme-delivery | summary | "session attendance medication choice side effects", "varenicline nicotine patches uptake" | yes | 4/4 | 1/1 | 0/0 | 0/0 |  | 1234 | 22% |
| heldout | northfold-programme-delivery | summary | "How many sessions did people attend, which quit-smoking medicines did they use, and were there side effects?" | **no** | 3/4 | 1/1 | 0/0 | 0/0 | f3 | 571 | 31% |
| heldout2 | ss-main-findings | summary | "school streets pilot results traffic NO2", "school streets walking cycling boundary roads" | yes | 4/4 | 1/1 | 0/0 | 0/0 |  | 1931 | 27% |
| heldout2 | ss-main-findings | summary | "What were the main findings of the School Streets pilot evaluation?" | **no** | 3/4 | 1/1 | 0/0 | 0/0 | f4 | 1020 | 33% |
| heldout2 | ss-cleaner-air | summary | "school gate NO2 change pilot", "hourly air quality restriction hours" | yes | 3/3 | 1/1 | 0/0 | 0/0 |  | 1955 | 25% |
| heldout2 | ss-cleaner-air | summary | "Did air pollution outside the schools go down when the streets were closed?" | **no** | 1/3 | 0/0 | 0/0 | 0/0 | f1, f3 | 905 | 16% |
| heldout2 | ss-more-walking | summary | "active travel mode share school streets", "hands-up survey walking cycling" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 1266 | 15% |
| heldout2 | ss-more-walking | summary | "Did more pupils walk, cycle or scoot to school after the School Streets started?" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 288 | 37% |
| heldout2 | ss-traffic-moved | qualified | "traffic displacement boundary roads", "diverted traffic nearby roads school streets" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1477 | 16% |
| heldout2 | ss-traffic-moved | qualified | "Did traffic increase on the roads surrounding the School Streets?" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 810 | 20% |
| heldout2 | ss-traffic-cut-conflict | conflict | "closed streets traffic reduction percent", "vehicle counts restriction hours school streets" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1319 | 10% |
| heldout2 | ss-traffic-cut-conflict | conflict | "How much did motor traffic on the closed streets drop during the School Streets pilot?" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 906 | 14% |
| heldout2 | ss-gates-vs-boundary | compare | "NO2 school gate boundary road comparison", "nitrogen dioxide by monitoring location" | yes | 2/2 | 0/0 | 0/0 | 0/0 |  | 1436 | 18% |
| heldout2 | ss-gates-vs-boundary | compare | "Was the change in air pollution at the school gates different from the change on nearby main roads?" | yes | 2/2 | 0/0 | 0/0 | 0/0 |  | 1064 | 24% |
| heldout2 | ss-car-dropoff | lookup | "car mode share pupils pilot survey", "school run by car percentage" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 900 | 1% |
| heldout2 | ss-car-dropoff | lookup | "What percentage of children travelled to school by car during the pilot?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 890 | 0% |
| heldout2 | ss-fines | lookup | "school streets penalty charge notices issued", "enforcement camera fines closures" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 753 | 9% |
| heldout2 | ss-fines | lookup | "How many penalty notices were issued to drivers entering the School Streets?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 618 | 17% |
| heldout2 | ss-total-pupils | aggregate | "pupils on roll pilot schools", "school streets site data" | yes | 0/0 | 0/0 | 0/0 | 2/2 |  | 1639 | 26% |
| heldout2 | ss-total-pupils | aggregate | "How many pupils are on roll at each of the School Streets pilot schools?" | yes | 0/0 | 0/0 | 0/0 | 2/2 |  | 1372 | 16% |
| heldout2 | ss-no2-highest-lowest | aggregate | "gate NO2 by school pilot period", "highest lowest NO2 school site" | yes | 2/2 | 0/0 | 0/0 | 2/2 |  | 1920 | 11% |
| heldout2 | ss-no2-highest-lowest | aggregate | "Which pilot school had the highest and which the lowest nitrogen dioxide at the gate in 2025?" | **no** | 0/2 | 0/0 | 0/0 | 0/2 | r3, r10 | 847 | 0% |
| heldout2 | ss-asthma-absent | absent | "school streets asthma pupils", "children health outcomes respiratory" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 1152 | 15% |
| heldout2 | ss-asthma-absent | absent | "Did the School Streets evaluation report any effect on children's asthma?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 1045 | 5% |
| heldout2 | dp-main-findings | summary | "nurse-led discharge evaluation results", "length of stay readmission discharge coordinator" | **no** | 3/4 | 1/1 | 0/0 | 0/0 | f4 | 1887 | 27% |
| heldout2 | dp-main-findings | summary | "What were the main results of the nurse-led discharge planning evaluation?" | **no** | 2/4 | 1/1 | 0/0 | 0/0 | f3, f4 | 1007 | 40% |
| heldout2 | dp-nurse-workload | summary | "nurse workload discharge coordinator time", "staff survey workload ward nurses" | yes | 4/4 | 1/1 | 0/0 | 0/0 |  | 1313 | 28% |
| heldout2 | dp-nurse-workload | summary | "How did nurse-led discharge planning affect the ward nurses' workload and time?" | yes | 4/4 | 1/1 | 0/0 | 0/0 |  | 1103 | 23% |
| heldout2 | dp-readmissions | qualified | "30-day readmission nurse-led discharge", "readmission rate control intervention" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1586 | 18% |
| heldout2 | dp-readmissions | qualified | "Did emergency readmissions within 30 days change under nurse-led discharge planning?" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 627 | 21% |
| heldout2 | dp-oldest-patients | qualified | "length of stay age 80 subgroup", "older patients discharge planning effect" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 1496 | 18% |
| heldout2 | dp-oldest-patients | qualified | "Did nurse-led discharge planning have a bigger effect for the oldest patients?" | yes | 2/2 | 1/1 | 0/0 | 0/0 |  | 1105 | 10% |
| heldout2 | dp-stay-conflict | conflict | "length of stay reduction days nurse-led discharge", "board briefing length of stay" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1587 | 12% |
| heldout2 | dp-stay-conflict | conflict | "By how many days did average length of stay fall under the nurse-led discharge model?" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1032 | 19% |
| heldout2 | dp-before-noon | lookup | "discharged before noon percentage", "discharge timing intervention period" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1789 | 3% |
| heldout2 | dp-before-noon | lookup | "What proportion of patients were discharged before noon under the new model?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 491 | 5% |
| heldout2 | dp-savings-absent | absent | "cost savings nurse-led discharge", "economic evaluation coordinator posts cost" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 1081 | 8% |
| heldout2 | dp-savings-absent | absent | "Did nurse-led discharge planning save the hospital money, and how much?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 1111 | 10% |
| heldout3 | library-of-things-report-findings | summary | "Library of Things pilot evaluation findings", "Brackenford borrowers loans savings results" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 1801 | 38% |
| heldout3 | library-of-things-report-findings | summary | "What did the study of the library's tool-lending scheme find overall?" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 952 | 11% |
| heldout3 | heat-pump-report-findings | summary | "Kestle Bay heat pump programme evaluation findings", "heat pump results bills temperature emissions satisfaction" | **no** | 3/4 | 0/0 | 0/0 | 0/0 | f4 | 1704 | 32% |
| heldout3 | heat-pump-report-findings | summary | "How did the community heat pump scheme work out for the people who got one?" | **no** | 2/4 | 0/0 | 0/0 | 0/0 | f2, f3 | 1034 | 15% |
| heldout3 | library-briefing-findings | summary | "Library of Things committee briefing", "briefing proposals Northfield deposit repair log" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 685 | 63% |
| heldout3 | library-briefing-findings | summary | "What is the library team asking councillors to sign off for the tool-lending scheme, and do they agree with the evaluation?" | **no** | 0/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3, f4 | 878 | 0% |
| heldout3 | heat-pump-board-meeting-findings | summary | "heat pump programme board meeting November 2024", "board notes phase two target installer complaints" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 701 | 48% |
| heldout3 | heat-pump-board-meeting-findings | summary | "What did the heat pump project's board decide when they last met?" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f2, f3, f4 | 343 | 13% |
| heldout3 | library-household-savings | qualified | "Library of Things household savings", "borrower survey median saving" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1548 | 10% |
| heldout3 | library-household-savings | qualified | "Did borrowing things from the library actually save people any cash?" | **no** | 1/1 | 0/1 | 0/0 | 0/0 |  | 700 | 10% |
| heldout3 | heat-pump-indoor-warmth | qualified | "Kestle Bay indoor temperature after heat pump installation", "living-room temperature loggers winter" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1198 | 28% |
| heldout3 | heat-pump-indoor-warmth | qualified | "Did people's houses actually get any warmer once the new heating went in?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 1087 | 0% |
| heldout3 | library-carbon-avoided | qualified | "Library of Things carbon emissions avoided", "avoided purchases tonnes carbon dioxide" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1041 | 22% |
| heldout3 | library-carbon-avoided | qualified | "Was the tool-lending scheme any good for the environment?" | **no** | 1/1 | 0/1 | 0/0 | 0/0 |  | 793 | 13% |
| heldout3 | library-damage-rate | conflict | "Library of Things damage rate loans", "items returned damaged repair log" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1336 | 15% |
| heldout3 | library-damage-rate | conflict | "How much of the stuff people borrowed came back broken?" | **no** | 0/2 | 0/0 | 0/1 | 0/0 | f1, f2 | 500 | 0% |
| heldout3 | heat-pump-bill-fall | conflict | "heat pump energy bill reduction percent", "Kestle Bay annual energy spend before after installation" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1178 | 24% |
| heldout3 | heat-pump-bill-fall | conflict | "How much cheaper did it get to run the house after switching to a heat pump?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 838 | 8% |
| heldout3 | library-loan-growth | conflict | "Library of Things loans year one year two", "loan growth percent second year" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 1363 | 14% |
| heldout3 | library-loan-growth | conflict | "Were people using the tool library more in its second year than its first, and by how much?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 921 | 17% |
| heldout3 | repeat-borrowing-comparison | compare | "repeat borrowing rate Library of Things", "repeat borrowing other tool libraries previous studies" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 1239 | 17% |
| heldout3 | repeat-borrowing-comparison | compare | "Do people come back for a second loan more often here than at similar schemes elsewhere?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 1021 | 0% |
| heldout3 | most-borrowed-item | lookup | "Library of Things most borrowed items", "top ten items loans" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1450 | 1% |
| heldout3 | most-borrowed-item | lookup | "What's the most popular thing people take out of the tool library?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 665 | 0% |
| heldout3 | survey-to-installation-wait | lookup | "heat pump survey to installation waiting time", "median weeks between survey and installation" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 517 | 9% |
| heldout3 | survey-to-installation-wait | lookup | "Once someone's house has been assessed, how long until the heat pump actually goes in?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 393 | 0% |
| heldout3 | solid-wall-bill-change | lookup | "energy spend change by wall type solid wall", "heat pump bills solid wall homes before 1919" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 440 | 23% |
| heldout3 | solid-wall-bill-change | lookup | "Did the really old houses, the ones built before about 1920, save much on their heating?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 978 | 11% |
| heldout3 | north-shore-installations | aggregate | "heat pump installations by area North Shore", "installations by zone workbook" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 442 | 25% |
| heldout3 | north-shore-installations | aggregate | "How many homes along the north shore ended up with a heat pump?" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 272 | 23% |
| heldout3 | south-shore-surveyed-not-installed | aggregate | "home surveys installations South Shore", "surveyed but not installed by area" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 1352 | 8% |
| heldout3 | south-shore-surveyed-not-installed | aggregate | "How many people down on the south shore got their house checked but never had a heat pump put in?" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 75 | 0% |
| heldout3 | library-effect-on-shops | absent | "Library of Things effect on local retailers", "hardware shop sales impact" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 178 | 0% |
| heldout3 | library-effect-on-shops | absent | "Has the tool library taken business away from the hardware stores in town?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 723 | 0% |
| heldout3 | heat-pump-house-prices | absent | "heat pump house prices property value", "Kestle Bay property values after installation" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 1953 | 0% |
| heldout3 | heat-pump-house-prices | absent | "Are the houses that got the new heat pumps worth more now?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 931 | 0% |
