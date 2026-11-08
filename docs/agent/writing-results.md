# Lasso on writing tasks (offline)

Generated 2026-10-31T06:39:26.256Z by `node scripts/agent-writing-benchmark.mjs`. No model is called: each row is one `lasso` call with a fixed set of asks, checked for the facts a correct draft needs. Token counts are estimates.

- **Development asks (written before any change; Lasso was changed while looking at them): 23 of 24 ask sets complete** (158 of 170 facts); mean answer 279 tokens.
- **Asks set 1 (written after the first changes; its first run had 15 of 24 complete; Lasso was changed since, its misses seen): 24 of 24 ask sets complete** (170 of 170 facts); mean answer 242 tokens.
- **Asks set 2 (written after the second changes; its one unseen run had 19 of 24 complete; Lasso was changed since, its misses seen): 21 of 24 ask sets complete** (154 of 170 facts); mean answer 285 tokens.
- Mean text of a task's files, as a file-reading agent gets it: 88,073 tokens.

| Task | Asks | Set | Facts in the answer | Answer tokens | Missing | Files as text (tokens) |
|---|---|---|---|---|---|---|
| q4-revenue-email | "Q4 2025 revenue", "Q3 2025 revenue", "best month in Q4 2025" | development | 4/4 | 483 |  | 443 |
|  | "total revenue for Q4 2025 and how it compares with Q3", "which month in Q4 2025 had the highest revenue" | development | 4/4 | 424 |  |  |
|  | "Q4 revenue and growth vs Q3" | held-out 1 | 4/4 | 187 |  |  |
|  | "October to December 2025 revenue", "fourth quarter results" | held-out 1 | 4/4 | 304 |  |  |
|  | "revenue in the last quarter of 2025", "how did Q4 compare to Q3", "strongest month in Q4" | held-out 2 | 4/4 | 563 |  |  |
|  | "Q4 2025 Board Report.pdf", "Revenue 2025.xlsx" | held-out 2 | 4/4 | 411 |  |  |
| top-months-newsletter | "2025 monthly revenue" | development | 12/12 | 205 |  | 174 |
|  | "which months had the highest revenue in 2025", "Revenue 2025.xlsx" | development | 12/12 | 281 |  |  |
|  | "revenue by month for 2025" | held-out 1 | 12/12 | 205 |  |  |
|  | "best performing months of 2025" | held-out 1 | 12/12 | 231 |  |  |
|  | "monthly revenue figures 2025" | held-out 2 | 12/12 | 205 |  |  |
|  | "Revenue 2025.xlsx Revenue column" | held-out 2 | 12/12 | 230 |  |  |
| quarterly-margin-email | "gross margin by month 2025", "revenue by month 2025" | development | 24/24 | 489 |  | 174 |
|  | "gross margin for each quarter of 2025" | development | 12/24 | 317 | January revenue, February revenue, March revenue, April revenue +8 |  |
|  | "quarterly gross margin 2025", "quarterly revenue 2025" | held-out 1 | 24/24 | 497 |  |  |
|  | "Revenue 2025.xlsx gross margin and revenue" | held-out 1 | 24/24 | 151 |  |  |
|  | "margin and revenue per month in 2025" | held-out 2 | 24/24 | 418 |  |  |
|  | "Q1 Q2 Q3 Q4 2025 gross margin and revenue" | held-out 2 | 24/24 | 380 |  |  |
| annual-total-line | "total revenue 2025" | development | 12/12 | 92 |  | 174 |
|  | "2025 revenue by month" | development | 12/12 | 205 |  |  |
|  | "full year 2025 revenue" | held-out 1 | 12/12 | 287 |  |  |
|  | "sum of monthly revenue in 2025" | held-out 1 | 12/12 | 92 |  |  |
|  | "2025 revenue total for the year" | held-out 2 | 12/12 | 281 |  |  |
|  | "what did we earn in 2025" | held-out 2 | 1/12 | 291 | January revenue, February revenue, March revenue, April revenue +7 |  |
| budget-note | "2026 budget for each department" | development | 6/6 | 321 |  | 91 |
|  | "Marketing 2026 budget", "Engineering 2026 budget", "Sales 2026 budget", "Operations 2026 budget", "Support 2026 budget" | development | 6/6 | 324 |  |  |
|  | "department budgets for 2026" | held-out 1 | 6/6 | 237 |  |  |
|  | "Budget 2026 final.xlsx" | held-out 1 | 6/6 | 78 |  |  |
|  | "2026 budgets by department, final version" | held-out 2 | 6/6 | 304 |  |  |
|  | "how much budget does each department get in 2026" | held-out 2 | 6/6 | 237 |  |  |
| q1-outlook-sentence | "Q1 2026 revenue outlook" | development | 2/2 | 122 |  | 182 |
|  | "revenue guidance for the first quarter of 2026" | development | 2/2 | 275 |  |  |
|  | "what do we expect for Q1 2026 revenue" | held-out 1 | 2/2 | 92 |  |  |
|  | "outlook section of the Q4 board report" | held-out 1 | 2/2 | 344 |  |  |
|  | "Q1 2026 forecast" | held-out 2 | 2/2 | 213 |  |  |
|  | "guidance for next quarter" | held-out 2 | 0/2 | 232 | low end, high end |  |
| west-region-email | "West region sales Q4 2025" | development | 1/1 | 170 |  | 182 |
|  | "Q4 2025 sales by region" | development | 1/1 | 158 |  |  |
|  | "West region Q4 2025 revenue" | held-out 1 | 1/1 | 146 |  |  |
|  | "regional performance in Q4 2025" | held-out 1 | 1/1 | 177 |  |  |
|  | "West region" | held-out 2 | 1/1 | 94 |  |  |
|  | "sales in the western region" | held-out 2 | 1/1 | 303 |  |  |
| supplier-bullets | "supplier review" | development | 4/4 | 134 |  | 105 |
|  | "Supplier review memo.docx" | development | 4/4 | 134 |  |  |
|  | "supplier performance review November 2025" | held-out 1 | 4/4 | 162 |  |  |
|  | "Acme Castings and Brightline Plastics on-time delivery" | held-out 1 | 4/4 | 182 |  |  |
|  | "supplier review findings and recommendation" | held-out 2 | 1/4 | 96 | Acme on time, Brightline on time, renewal date |  |
|  | "Operations/Supplier review memo.docx" | held-out 2 | 4/4 | 134 |  |  |
| meeting-actions-email | "action items from the 4 December meeting" | development | 4/4 | 128 |  | 97 |
|  | "Meeting notes 2025-12-04.docx" | development | 4/4 | 128 |  |  |
|  | "what was agreed at the operations meeting on 4 December" | held-out 1 | 4/4 | 159 |  |  |
|  | "who owns what after the December operations meeting" | held-out 1 | 4/4 | 159 |  |  |
|  | "meeting notes from 4 December 2025" | held-out 2 | 4/4 | 128 |  |  |
|  | "4 December actions, owners and deadlines" | held-out 2 | 4/4 | 164 |  |  |
| bracket-spec | "bracket overall dimensions", "bracket hole diameters" | development | 5/5 | 390 |  | 8,108 |
|  | "bracket.step" | development | 5/5 | 114 |  |  |
|  | "bracket size and holes" | held-out 1 | 5/5 | 164 |  |  |
|  | "bracket.step overall extents and hole diameters" | held-out 1 | 5/5 | 85 |  |  |
|  | "bracket dimensions and hole diameters" | held-out 2 | 5/5 | 201 |  |  |
|  | "Engineering/bracket.step" | held-out 2 | 5/5 | 114 |  |  |
| assembly-parts-email | "parts in the fixture assembly" | development | 4/4 | 249 |  | 10,205 |
|  | "fixture assembly.step" | development | 4/4 | 249 |  |  |
|  | "bill of materials for the fixture assembly" | held-out 1 | 4/4 | 280 |  |  |
|  | "what parts make up the fixture" | held-out 1 | 4/4 | 275 |  |  |
|  | "fixture assembly parts and quantities" | held-out 2 | 4/4 | 276 |  |  |
|  | "components of the fixture assembly with sizes" | held-out 2 | 4/4 | 249 |  |  |
| house-rooms-brochure | "rooms and floor areas in the house model" | development | 7/7 | 636 |  | 1,036,939 (over a 60k-character tool result) |
|  | "FZK-Haus.ifc" | development | 7/7 | 657 |  |  |
|  | "floor area of each room in FZK-Haus" | held-out 1 | 7/7 | 632 |  |  |
|  | "FZK-Haus.ifc rooms" | held-out 1 | 7/7 | 683 |  |  |
|  | "FZK-Haus rooms with net floor area" | held-out 2 | 7/7 | 671 |  |  |
|  | "room areas in the house" | held-out 2 | 7/7 | 641 |  |  |
