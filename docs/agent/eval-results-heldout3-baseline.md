# Lasso evaluation (offline): heldout3-baseline

Generated 2026-10-30T22:58:58.377Z by `node scripts/agent-eval/run.mjs`. Each row is one `lasso` call with a fixed ask set, graded on the rendered response: could a careful reader complete the task from it alone? A fact counts only when all its patterns match in one sentence, record line, or table row read with its header. No model is called; token counts are estimates.

| Set | Sufficient | Material facts | Response tokens (median / p90 / max) | Share about the task | Files that state the facts, as text (median / max tokens) | Local ms (median / max) |
|---|---|---|---|---|---|---|
| heldout3 | 12 of 36 | 23/62 | 371 / 677 / 1508 | 21% | 2494 / 3231 | 93 / 249 |

| Set | Task | Kind | Asks | Sufficient | Material | Qualifications | Conflicts | Computed | Missing | Tokens | About the task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| heldout3 | library-of-things-report-findings | summary | "Library of Things pilot evaluation findings", "Brackenford borrowers loans savings results" | **no** | 0/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3, f4 | 368 | 0% |
| heldout3 | library-of-things-report-findings | summary | "What did the study of the library's tool-lending scheme find overall?" | **no** | 0/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3, f4 | 320 | 0% |
| heldout3 | heat-pump-report-findings | summary | "Kestle Bay heat pump programme evaluation findings", "heat pump results bills temperature emissions satisfaction" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f2, f3, f4 | 706 | 52% |
| heldout3 | heat-pump-report-findings | summary | "How did the community heat pump scheme work out for the people who got one?" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f2, f3, f4 | 193 | 68% |
| heldout3 | library-briefing-findings | summary | "Library of Things committee briefing", "briefing proposals Northfield deposit repair log" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 677 | 61% |
| heldout3 | library-briefing-findings | summary | "What is the library team asking councillors to sign off for the tool-lending scheme, and do they agree with the evaluation?" | **no** | 0/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3, f4 | 221 | 0% |
| heldout3 | heat-pump-board-meeting-findings | summary | "heat pump programme board meeting November 2024", "board notes phase two target installer complaints" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 513 | 59% |
| heldout3 | heat-pump-board-meeting-findings | summary | "What did the heat pump project's board decide when they last met?" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 406 | 52% |
| heldout3 | library-household-savings | qualified | "Library of Things household savings", "borrower survey median saving" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 184 | 0% |
| heldout3 | library-household-savings | qualified | "Did borrowing things from the library actually save people any cash?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 295 | 0% |
| heldout3 | heat-pump-indoor-warmth | qualified | "Kestle Bay indoor temperature after heat pump installation", "living-room temperature loggers winter" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 748 | 55% |
| heldout3 | heat-pump-indoor-warmth | qualified | "Did people's houses actually get any warmer once the new heating went in?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 527 | 0% |
| heldout3 | library-carbon-avoided | qualified | "Library of Things carbon emissions avoided", "avoided purchases tonnes carbon dioxide" | **no** | 1/1 | 0/1 | 0/0 | 0/0 |  | 323 | 49% |
| heldout3 | library-carbon-avoided | qualified | "Was the tool-lending scheme any good for the environment?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 251 | 0% |
| heldout3 | library-damage-rate | conflict | "Library of Things damage rate loans", "items returned damaged repair log" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 379 | 51% |
| heldout3 | library-damage-rate | conflict | "How much of the stuff people borrowed came back broken?" | **no** | 0/2 | 0/0 | 0/1 | 0/0 | f1, f2 | 498 | 0% |
| heldout3 | heat-pump-bill-fall | conflict | "heat pump energy bill reduction percent", "Kestle Bay annual energy spend before after installation" | **no** | 0/2 | 0/0 | 0/1 | 0/0 | f1, f2 | 292 | 0% |
| heldout3 | heat-pump-bill-fall | conflict | "How much cheaper did it get to run the house after switching to a heat pump?" | **no** | 0/2 | 0/0 | 0/1 | 0/0 | f1, f2 | 209 | 0% |
| heldout3 | library-loan-growth | conflict | "Library of Things loans year one year two", "loan growth percent second year" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 343 | 80% |
| heldout3 | library-loan-growth | conflict | "Were people using the tool library more in its second year than its first, and by how much?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 485 | 41% |
| heldout3 | repeat-borrowing-comparison | compare | "repeat borrowing rate Library of Things", "repeat borrowing other tool libraries previous studies" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 414 | 86% |
| heldout3 | repeat-borrowing-comparison | compare | "Do people come back for a second loan more often here than at similar schemes elsewhere?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 258 | 0% |
| heldout3 | most-borrowed-item | lookup | "Library of Things most borrowed items", "top ten items loans" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 1508 | 0% |
| heldout3 | most-borrowed-item | lookup | "What's the most popular thing people take out of the tool library?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 287 | 0% |
| heldout3 | survey-to-installation-wait | lookup | "heat pump survey to installation waiting time", "median weeks between survey and installation" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 303 | 55% |
| heldout3 | survey-to-installation-wait | lookup | "Once someone's house has been assessed, how long until the heat pump actually goes in?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 293 | 0% |
| heldout3 | solid-wall-bill-change | lookup | "energy spend change by wall type solid wall", "heat pump bills solid wall homes before 1919" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 375 | 0% |
| heldout3 | solid-wall-bill-change | lookup | "Did the really old houses, the ones built before about 1920, save much on their heating?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 499 | 0% |
| heldout3 | north-shore-installations | aggregate | "heat pump installations by area North Shore", "installations by zone workbook" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 386 | 16% |
| heldout3 | north-shore-installations | aggregate | "How many homes along the north shore ended up with a heat pump?" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 318 | 0% |
| heldout3 | south-shore-surveyed-not-installed | aggregate | "home surveys installations South Shore", "surveyed but not installed by area" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 371 | 17% |
| heldout3 | south-shore-surveyed-not-installed | aggregate | "How many people down on the south shore got their house checked but never had a heat pump put in?" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 392 | 0% |
| heldout3 | library-effect-on-shops | absent | "Library of Things effect on local retailers", "hardware shop sales impact" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 546 | 0% |
| heldout3 | library-effect-on-shops | absent | "Has the tool library taken business away from the hardware stores in town?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 448 | 0% |
| heldout3 | heat-pump-house-prices | absent | "heat pump house prices property value", "Kestle Bay property values after installation" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 640 | 0% |
| heldout3 | heat-pump-house-prices | absent | "Are the houses that got the new heat pumps worth more now?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 184 | 0% |
