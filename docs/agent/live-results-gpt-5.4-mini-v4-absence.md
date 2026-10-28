# Lasso agent benchmark: live model runs

Generated 2026-10-28T00:22:14.992Z. Produced by `node scripts/agent-benchmark-live.mjs`. Reasoning effort low; 2 run(s); spent $0.036 of a $0.15 limit.

**Token counts are the provider's usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark's ([benchmark-results.md](benchmark-results.md)).

## gpt-5.4-mini

Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).

| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 2/2 | 82,759 | 80,930 | 54,400 | 1,829 | 528 | 13 | 32 | $0.0322 | 21 s |
| lasso-v4 | 2/2 | 2,899 | 2,573 | 0 | 326 | 168 | 4 | 2 | $0.0034 | 5.7 s |

- **lasso-v4**: S = 1 − ΣT/ΣT_direct over 2 paired tasks = **96.5%** (code null%, docs 96.5%); per-task ratio min 0.03, median 0.03, max 0.04; more tokens than direct on 0 of 2. Used Lasso on 2 of 2 tasks, also needing file tools on 0 of those (lasso ×2).
- First-call input (instructions + tool definitions + request), median: direct 417, lasso-v4 562 tokens; so each Lasso version adds lasso-v4 +145 tokens per call.
- Capability tasks (not in S): none run.

| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | doc-missing | direct | yes | 46004 | 31744 | 1080 | 7 | 17 | Grep×7 Glob×6 Read×4 | 12.2 | answered |
| 1 | doc-missing | lasso-v4 | yes | 1425 | 0 | 135 | 2 | 1 | lasso×1 | 2.4 | answered |
| 2 | doc-missing | direct | yes | 36755 | 22656 | 749 | 6 | 15 | Grep×8 Glob×3 Read×4 | 8.7 | answered |
| 2 | doc-missing | lasso-v4 | yes | 1474 | 0 | 191 | 2 | 1 | lasso×1 | 3.3 | answered |

\* capability task: needs history direct tools cannot reach.

