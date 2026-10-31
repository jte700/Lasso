# Lasso evaluation (offline): heldout3

Generated 2026-10-30T22:59:02.779Z by `node scripts/agent-eval/run.mjs`. Each row is one `lasso` call with a fixed ask set, graded on the rendered response: could a careful reader complete the task from it alone? A fact counts only when all its patterns match in one sentence, record line, or table row read with its header. No model is called; token counts are estimates.

| Set | Sufficient | Material facts | Response tokens (median / p90 / max) | Share about the task | Files that state the facts, as text (median / max tokens) | Local ms (median / max) |
|---|---|---|---|---|---|---|
| heldout3 | 20 of 36 | 37/62 | 864 / 1704 / 1958 | 14% | 2494 / 3231 | 10 / 61 |

| Set | Task | Kind | Asks | Sufficient | Material | Qualifications | Conflicts | Computed | Missing | Tokens | About the task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| heldout3 | library-of-things-report-findings | summary | "Library of Things pilot evaluation findings", "Brackenford borrowers loans savings results" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 1805 | 38% |
| heldout3 | library-of-things-report-findings | summary | "What did the study of the library's tool-lending scheme find overall?" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 946 | 10% |
| heldout3 | heat-pump-report-findings | summary | "Kestle Bay heat pump programme evaluation findings", "heat pump results bills temperature emissions satisfaction" | **no** | 3/4 | 0/0 | 0/0 | 0/0 | f4 | 1717 | 32% |
| heldout3 | heat-pump-report-findings | summary | "How did the community heat pump scheme work out for the people who got one?" | **no** | 2/4 | 0/0 | 0/0 | 0/0 | f2, f3 | 1036 | 14% |
| heldout3 | library-briefing-findings | summary | "Library of Things committee briefing", "briefing proposals Northfield deposit repair log" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 684 | 63% |
| heldout3 | library-briefing-findings | summary | "What is the library team asking councillors to sign off for the tool-lending scheme, and do they agree with the evaluation?" | **no** | 0/4 | 0/0 | 0/0 | 0/0 | f1, f2, f3, f4 | 864 | 0% |
| heldout3 | heat-pump-board-meeting-findings | summary | "heat pump programme board meeting November 2024", "board notes phase two target installer complaints" | yes | 4/4 | 0/0 | 0/0 | 0/0 |  | 695 | 48% |
| heldout3 | heat-pump-board-meeting-findings | summary | "What did the heat pump project's board decide when they last met?" | **no** | 1/4 | 0/0 | 0/0 | 0/0 | f2, f3, f4 | 335 | 12% |
| heldout3 | library-household-savings | qualified | "Library of Things household savings", "borrower survey median saving" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1704 | 10% |
| heldout3 | library-household-savings | qualified | "Did borrowing things from the library actually save people any cash?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 508 | 0% |
| heldout3 | heat-pump-indoor-warmth | qualified | "Kestle Bay indoor temperature after heat pump installation", "living-room temperature loggers winter" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1206 | 28% |
| heldout3 | heat-pump-indoor-warmth | qualified | "Did people's houses actually get any warmer once the new heating went in?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 1094 | 0% |
| heldout3 | library-carbon-avoided | qualified | "Library of Things carbon emissions avoided", "avoided purchases tonnes carbon dioxide" | yes | 1/1 | 1/1 | 0/0 | 0/0 |  | 1035 | 22% |
| heldout3 | library-carbon-avoided | qualified | "Was the tool-lending scheme any good for the environment?" | **no** | 1/1 | 0/1 | 0/0 | 0/0 |  | 790 | 12% |
| heldout3 | library-damage-rate | conflict | "Library of Things damage rate loans", "items returned damaged repair log" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1318 | 15% |
| heldout3 | library-damage-rate | conflict | "How much of the stuff people borrowed came back broken?" | **no** | 0/2 | 0/0 | 0/1 | 0/0 | f1, f2 | 506 | 0% |
| heldout3 | heat-pump-bill-fall | conflict | "heat pump energy bill reduction percent", "Kestle Bay annual energy spend before after installation" | yes | 2/2 | 0/0 | 1/1 | 0/0 |  | 1180 | 24% |
| heldout3 | heat-pump-bill-fall | conflict | "How much cheaper did it get to run the house after switching to a heat pump?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 839 | 8% |
| heldout3 | library-loan-growth | conflict | "Library of Things loans year one year two", "loan growth percent second year" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 1349 | 14% |
| heldout3 | library-loan-growth | conflict | "Were people using the tool library more in its second year than its first, and by how much?" | **no** | 1/2 | 0/0 | 0/1 | 0/0 | f1 | 917 | 17% |
| heldout3 | repeat-borrowing-comparison | compare | "repeat borrowing rate Library of Things", "repeat borrowing other tool libraries previous studies" | yes | 3/3 | 0/0 | 0/0 | 0/0 |  | 1231 | 17% |
| heldout3 | repeat-borrowing-comparison | compare | "Do people come back for a second loan more often here than at similar schemes elsewhere?" | **no** | 0/3 | 0/0 | 0/0 | 0/0 | f1, f2, f3 | 1007 | 0% |
| heldout3 | most-borrowed-item | lookup | "Library of Things most borrowed items", "top ten items loans" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 1445 | 1% |
| heldout3 | most-borrowed-item | lookup | "What's the most popular thing people take out of the tool library?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 662 | 0% |
| heldout3 | survey-to-installation-wait | lookup | "heat pump survey to installation waiting time", "median weeks between survey and installation" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 696 | 16% |
| heldout3 | survey-to-installation-wait | lookup | "Once someone's house has been assessed, how long until the heat pump actually goes in?" | **no** | 0/1 | 0/0 | 0/0 | 0/0 | f1 | 390 | 0% |
| heldout3 | solid-wall-bill-change | lookup | "energy spend change by wall type solid wall", "heat pump bills solid wall homes before 1919" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 431 | 23% |
| heldout3 | solid-wall-bill-change | lookup | "Did the really old houses, the ones built before about 1920, save much on their heating?" | yes | 1/1 | 0/0 | 0/0 | 0/0 |  | 852 | 13% |
| heldout3 | north-shore-installations | aggregate | "heat pump installations by area North Shore", "installations by zone workbook" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 442 | 25% |
| heldout3 | north-shore-installations | aggregate | "How many homes along the north shore ended up with a heat pump?" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 211 | 29% |
| heldout3 | south-shore-surveyed-not-installed | aggregate | "home surveys installations South Shore", "surveyed but not installed by area" | yes | 0/0 | 0/0 | 0/0 | 1/1 |  | 1369 | 8% |
| heldout3 | south-shore-surveyed-not-installed | aggregate | "How many people down on the south shore got their house checked but never had a heat pump put in?" | **no** | 0/0 | 0/0 | 0/0 | 0/1 |  | 75 | 0% |
| heldout3 | library-effect-on-shops | absent | "Library of Things effect on local retailers", "hardware shop sales impact" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 179 | 0% |
| heldout3 | library-effect-on-shops | absent | "Has the tool library taken business away from the hardware stores in town?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 716 | 0% |
| heldout3 | heat-pump-house-prices | absent | "heat pump house prices property value", "Kestle Bay property values after installation" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 1958 | 0% |
| heldout3 | heat-pump-house-prices | absent | "Are the houses that got the new heat pumps worth more now?" | yes | 0/0 | 0/0 | 0/0 | 0/0 |  | 925 | 0% |
