# Typing study: how much time Tab saves

A timed study of people writing short documents that state facts from a folder of work files, with Lasso's suggestions on and off. It measures what the agent benchmarks cannot: a person's time, and whether the facts they write are right.

Nothing here has been run. This page is the protocol to build and run it from; the analysis plan below is fixed before any data is collected.

## The question

When a person writes text that states values from their files (an email with last quarter's revenue, a note with each department's budget, a spec with a part's hole sizes), how much less time does it take with Lasso's Tab suggestions than with the tools they use today, and are more of the stated facts right?

**Primary outcome:** time per task, from the task appearing to the draft being submitted.

**Secondary outcomes:**
- facts right: the share of a task's material facts stated correctly, and the number of wrong values stated (a draft budget's figure where the final one belongs, Q3's revenue for Q4's, a West-region figure the files never give);
- keystrokes per task;
- time away from the draft, in other apps (the time spent looking things up);
- the share of the draft's characters inserted by Lasso;
- workload (raw NASA-TLX, six items, once per block) and which way of working the person prefers.

## Design

Within subjects, crossed over: every participant writes one block of tasks without Lasso and one block with it, each block in a different company's folder.

| Group | Block 1 | Block 2 |
|---|---|---|
| 1 | Baseline, company A | Lasso, company B |
| 2 | Lasso, company A | Baseline, company B |
| 3 | Baseline, company B | Lasso, company A |
| 4 | Lasso, company B | Baseline, company A |

- **Two companies, not one.** Each block uses its own folder, so nobody meets a folder twice: what someone learns about where things are in block 1 cannot speed up block 2. The two folders are built to the same plan (below), and the groups balance which company goes with which condition and which comes first.
- **Six tasks per block**, in a fixed random order per company, the same for every participant.
- **Conditions.**
  - *Baseline:* Lasso is quit. Any app on the Mac may be used: Finder and Spotlight, Excel or Numbers, Preview, Word or Pages. No AI assistant.
  - *Lasso:* Lasso is running with **Suggest While Typing** on and the company's folder enabled; every other app is allowed as in baseline, so a person may still open a file to check.
  - A third arm (an AI chat assistant with the folder's files attached) is left for a later round; it would need its own tasks about prompting.

## Participants

- **Who:** people who write documents with figures from work files as part of their job: finance and accounting, operations, research, consulting, project management. Mac users, because Lasso's suggestions run in the Mac app.
- **Not eligible:** anyone who has worked on Lasso or used it before the session.
- **How many:** 24, six per group, revised after the pilot. The study is sized to detect a 20% cut in task time with 80% power at a two-sided 5% level. With σ the standard deviation, across participants, of the log ratio of their Lasso and baseline times (estimated in the pilot), N ≈ ((1.96 + 0.84) σ / ln 1.25)², rounded up to a multiple of 4: σ = 0.3 gives 16, σ = 0.4 gives 28.
- **Pay:** [$__] for the session, the same whatever the result.

## Materials

### The two folders

Each company's folder is generated from fixed data, as `scripts/agent-writing-corpus.mjs` generates the agent benchmark's, so every fact a draft needs is known. Both follow one plan:

- `Finance/`: a monthly revenue and margin workbook, a final and a draft budget workbook, two quarterly board reports (PDF);
- `Operations/`: a supplier review memo and dated meeting notes (Word);
- **distractors**, about 100 files in all: earlier years' workbooks and reports, superseded drafts, unrelated memos and notes, with names a person might search for. A ten-file folder would make looking things up in Finder unrealistically quick.

The two companies differ in names, figures, dates and people, never in structure. The folders are indexed by Lasso before the session; indexing time is not part of the study.

### Tasks

Each company has six tasks built from the same six templates, so the two blocks are matched in kind and size:

| Template | Sources | Facts |
|---|---|---|
| Quarter email: the quarter's total, change on the previous quarter, best month | workbook, two board reports | 4 |
| Budget note: each department's budget, from the final file | final and draft workbooks | 5–6 |
| Outlook sentence: next quarter's guidance range | board report | 2 |
| Supplier bullets: on-time rates, recommendation, renewal date | Word memo | 4 |
| Meeting actions email: owners and deadlines | Word notes | 4 |
| Region email for a region the reports never mention | board report | 1, and must say the region is not reported |

Every task lists its facts in the format of the agent benchmark (`scripts/agent-eval/SPEC.md`): patterns that accept the usual ways of writing a value and that must match within one sentence of the draft, `material` marks, and, new here, **wrong-value patterns** for the traps each task sets (the draft budget's figures, the previous quarter's total, any amount beside the unreported region).

**Who writes them:** an author who has not seen Lasso's ranking code or tuned it, working only from this page, as the agent benchmark's held-out sets were written. The tasks are frozen before the pilot. After the pilot they may be changed only to fix unclear wording, each change recorded; Lasso is not changed for them at any point.

**Optional engineering module:** for participants who work with CAD or building models, a third block of three tasks per condition on STEP parts and assemblies and an IFC building (a part's overall size and hole diameters, an assembly's parts and quantities, rooms and floor areas). In baseline they use the CAD or BIM viewer they use at work, installed on the study Mac; without one these tasks cannot be done, which would overstate Lasso's advantage. It is analysed separately from the office tasks.

**Practice:** a third, small folder (ten files) with two practice tasks per condition, not scored.

**Instructions to participants**, the same words every time: write as you would for a colleague; getting the facts right matters as much as speed; you may open any file; submit when you would send it. They are not told who makes Lasso or what the study expects.

## Session

One person at a time, about 75 minutes, on the study Mac.

| Step | Minutes |
|---|---|
| Consent, background questions (role, years, how often they write with figures) | 5 |
| How the task page works | 3 |
| Block 1: tutorial if Lasso (5 min, scripted: Tab, ↑↓, `fn →`, `Esc`), two practice tasks, six tasks | 25–30 |
| Workload questions for block 1, break | 5 |
| Block 2: as block 1, in the other condition and company | 25–30 |
| Workload questions for block 2, preference, comments | 5 |

A task is stopped at **8 minutes**. It then counts as 8 minutes, with whatever facts the draft has by then.

## Setup and instruments

**The Mac:** one machine for every session, with Excel, Word, Numbers, Pages and Preview installed. Each participant starts from a fresh Lasso data folder with the two company folders already indexed, an empty `references.json`, and a fresh user account or cleared app state, so recent files and Spotlight history from earlier sessions cannot help. The Lasso build is fixed for the whole study, and its commit is recorded with every log.

**The task page:** a local page (served on `127.0.0.1`) that shows each task's prompt above a text box and records, per task, one line of JSON per event:

```jsonc
{ "participant": "p07", "group": 3, "block": 1, "condition": "lasso", "company": "B",
  "task": "budget-note", "t": 18342, "wall": "2026-11-20T10:14:03.512Z",
  "type": "input",            // task-start | keydown | input | paste | blur | focus | submit | timeout
  "key": "printable",         // keydown only: printable | Backspace | Delete | Enter | Tab | arrow | modifier
  "inputType": "insertText",  // input only, as the browser reports it
  "inserted": 1, "deleted": 0 }
```

It records only what happens in its own text box and when it loses or regains focus: nothing from other apps, no screen recording. The submitted draft is saved with the log.

**Where characters came from:** each inserted character is counted as typed (an input of one character right after its keydown), pasted (a paste event), or inserted by Lasso. Lasso writes its text into the field through the Accessibility API (`AccessibilityReader.replace` in `desktop/GlobalAssist.swift`), which reaches the page as an input event with no keydown or paste. The count is checked against Lasso's own records for the session: each accepted suggestion is posted to `/api/projects/:id/recommendation-usage` with `kind: "accept"`, and its inserted text is kept as a reference in `~/Library/Application Support/Lasso/references.json`. The pilot confirms that the page sees Lasso's insertions this way in the browser used; if Lasso falls back to typing the text as keystrokes there, the count comes from Lasso's records alone.

**Time away:** the sum of the intervals between the text box losing focus and regaining it.

## Scoring

Drafts are scored by script, from the frozen fact and wrong-value patterns, without knowing the condition. For each task:

- **facts right**: the material facts the draft states correctly, over the task's material facts;
- **complete**: all material facts right, and no wrong value;
- **wrong values**: the number of wrong-value patterns the draft matches.

For the region that is never reported, the draft is complete when it says the reports do not give it and states no figure for it.

## Analysis (fixed before data)

**Primary:** a linear mixed model of log task time, with condition, block (1 or 2) and company as fixed effects and participant and task as random intercepts. The result is reported as the percentage change in time with Lasso, exp(β) − 1, with its 95% confidence interval. Lasso is said to save time only if the whole interval is below zero.

**Secondary:**
- completeness: a logistic mixed model with the same terms;
- wrong values per task: a Poisson mixed model;
- keystrokes, time away and Lasso's share of characters, as medians per condition with interquartile ranges;
- workload: paired comparison of raw NASA-TLX scores; preference as counts.

**Checks reported alongside:** the condition × block interaction (whether the effect differs by order), and results per template.

**Exploratory, labelled so:** differences by role and by how often people write with figures.

**Exclusions:** a participant is excluded only for a technical failure (the logger stopped, Lasso was not running in the Lasso block), decided from the logs without looking at times or scores, and listed with the reason. Pilot participants are not in the main analysis.

**Reported whatever the result**, including a slowdown or no difference, with every task's median times in both conditions. The analysis script is written and run on pilot data before the main study, then run once on the main data.

## Pilot

Three or four people, in two groups, run exactly as above. It goes ahead to the main study when:

- baseline tasks take a median of 2 to 6 minutes, and no task is stopped at 8 minutes for more than one pilot participant;
- Lasso's suggestions appear and insert in the task page's text box;
- every event is logged, and characters are classified the same way as Lasso's own records count accepts;
- the scoring script agrees with a person scoring the pilot drafts by hand.

The pilot also gives σ, and so the final number of participants.

## From results to the deck

The deck may then state, for these tasks: the median minutes per draft in each condition, the percentage change in time with its confidence interval, and completeness in each condition. A yearly figure is a projection and says so: minutes saved per draft × drafts a day × 230 working days, with the drafts-a-day assumption written on the slide, as the token-savings slide does.

## Limits

- **Unfamiliar folders.** Participants meet each folder for the first time, which is how a new project, a colleague's folder or an inherited one feels, but not someone's own long-used files. The field study below covers those.
- **One text box.** Writing in the task page rather than in Mail or Word keeps the measurements identical across people. Lasso's highlights and insertion vary by host app, so the field study uses real apps.
- **Short training.** Five minutes of tutorial is less than a regular user has; the Lasso times are likely slower than an experienced user's.
- **Synthetic files.** Generated folders make every fact checkable; their layout and size are set to resemble real ones, but they are not anyone's real work.

## What to build

| Piece | Where | What it does |
|---|---|---|
| Folders and tasks | `scripts/typing-study/corpus.mjs` | Generates company A, company B and the practice folder from fixed data, with the tasks, facts and wrong-value patterns (using the builders in `scripts/agent-writing-corpus.mjs`) |
| Task page | `scripts/typing-study/runner/` | The local page, its event log, the 8-minute stop and the session's group and order |
| Scoring | `scripts/typing-study/grade.mjs` | Scores each draft from the logs; also run on hand-scored pilot drafts to check it |
| Analysis | `scripts/typing-study/analyze.R` | The models above (R with lme4), writing a results page like `docs/agent/eval-results-*.md` |
| Session script | `docs/typing-study-session.md` | What the facilitator says and does, word for word, and the checklist for resetting the Mac between sessions |

## Later: a field study on people's own files

After the lab study: about ten Lasso users over two weeks, alternating days with suggestions on and off, writing in their own apps on their own files. Lasso would record, on their Mac only, counts per day of accepted suggestions and characters inserted (no text), which each person reviews and chooses to share. It measures use and inserted text in real work rather than timed tasks, and answers the first limit above.

## Ethics and data

Participants give written consent, can stop at any time and keep their payment, and can have their data deleted. Logs and drafts are stored under a participant code, apart from names and contact details, and contain no personal data beyond the background questions. If the results are to be published as research, the protocol goes to an ethics review board first.
