# Lasso agent benchmark: live model runs

Generated 2026-10-27T21:57:17.240Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 1 run(s); spent $0.052 of a $0.3 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.3-codex

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 1/1 | 1,023 | 941 | 0 | 82 | 9 | 2 | 1 | $0.0028 | 2.5 s |
| lasso | 1/1 | 1,845 | 1,695 | 0 | 150 | 68 | 2 | 1 | $0.0051 | 3.1 s |
| lasso-first | 1/1 | 3,225 | 2,993 | 0 | 232 | 107 | 3 | 2 | $0.0085 | 5.3 s |

- **lasso**: S = 1 − ΣT/ΣT_direct over 1 paired tasks = **-80.4%** (code -80.4%, docs null%); per-task ratio min 1.8, median 1.8, max 1.8; more tokens than direct on 1 of 1. Used Lasso on 0 of 1 tasks, also needing file tools on 0 of those (Read ×1).
- **lasso-first**: S = 1 − ΣT/ΣT_direct over 1 paired tasks = **-215.2%** (code -215.2%, docs null%); per-task ratio min 3.15, median 3.15, max 3.15; more tokens than direct on 1 of 1. Used Lasso on 1 of 1 tasks, also needing file tools on 1 of those (lasso_inspect ×1, Read ×1).
- First-call input (instructions + tool definitions + request), median: direct 431, lasso 791, lasso-first 814 tokens. Lasso's definitions and instructions cost **360 tokens per call** in this model's tokenizer (offline estimate: 838).
- Capability tasks (not in S): code-stale-reference run 1 lasso wrong; code-stale-reference run 1 lasso-first correct; code-stale-reference run 1 direct wrong.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | code-stale-reference * | lasso | **no** | 5858 | 1280 | 784 | 4 | 3 | lasso_inspect×3 | 13.3 | answered |
| 1 | code-stale-reference * | lasso-first | yes | 3738 | 1024 | 372 | 3 | 2 | lasso_inspect×2 | 6.2 | answered |
| 1 | code-stale-reference * | direct | **no** | 1594 | 0 | 453 | 2 | 1 | Read×1 | 7.2 | answered |
| 1 | code-modified-on-disk | lasso-first | yes | 3225 | 0 | 232 | 3 | 2 | lasso_inspect×1 Read×1 | 5.3 | answered |
| 1 | code-modified-on-disk | direct | yes | 1023 | 0 | 82 | 2 | 1 | Read×1 | 2.5 | answered |
| 1 | code-modified-on-disk | lasso | yes | 1845 | 0 | 150 | 2 | 1 | Read×1 | 3.1 | answered |

\* capability task: needs history direct tools cannot reach.

