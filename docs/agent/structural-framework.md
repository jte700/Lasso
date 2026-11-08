# Lasso structural context framework — executable research specification

Status: local prototype, 30 October 2026, with its geometry path integrated into the MCP's `lasso` tool the same day: relations between STEP assembly instances are computed through the STEP bridge and checked by the compiler, and assembly digests place their instances ([what is integrated, and why the rest is not](README.md#structural-context-what-is-integrated)). The other parts remain a prototype. This document supersedes the earlier conceptual white paper for claims about what is actually implemented.

## Purpose

Lasso should keep source files and their indexes on the user's computer. A model asks for specific evidence or structural relationships; Lasso retrieves the relevant facts, performs supported calculations locally, and returns a small, cited context packet. A user should not have to upload an entire PDF, spreadsheet or assembly for each question.

The intended capability is **task-specific structural context**. For example, a model can receive the transform and axis angle between two component instances without reading every vertex or face; a study result with its definition and limiting qualification without reading every page; or a freshly computed spreadsheet total without receiving every operand. The entire source remains available locally for subsequent questions.

This is not a way to transmit arbitrary full-document knowledge in a fixed small message. Nor does local storage mean no information reaches the model provider: the selected evidence and computed results are still disclosed when a client sends the tool response to a remote model. This prototype itself makes no model calls or network requests.

## What is implemented

| Component | File | Behavior |
|---|---|---|
| Context compiler | `src/agent/structural/compiler.js` | Validates visible and local audit dependencies; selects evidence under complete-payload budgets; exact and heuristic modes |
| Typed adapters | `src/agent/structural/adapters.js` | Static geometry operators, declared document dependencies, normalized spreadsheet formulas |
| STEP bridge | `geometryContextFromStepModel` in the adapter module | Uses the existing STEP parser's component occurrences and placements |
| Incremental refinement | `src/agent/structural/refinement.js` | Explicit retained-context digests, smaller updates, revision checks and full recovery |
| Evaluation | `scripts/structural-context-benchmark.mjs` and `structural-context-fixtures.mjs` | Reproducible synthetic fixtures, independent numeric oracles, strong baselines and scaling experiment |
| Tests | `test/structural-compiler.test.js`, `structural-adapters.test.js`, `structural-refinement.test.js` | Closure, exact selection, budgets, repeated instances, unsupported inputs, stale records and refinement failures |

The adapters accept normalized records. Automatic semantic dependency extraction from PDFs, general XLSX formula parsing, arbitrary B-rep clearance, general natural-language query planning and durable new graph storage are not implemented. The geometry operators are reachable over MCP through `lasso` asks that name two instances ("Pin:2 relative to Pin:1"), not through a separate tool. These are explicit integration steps below. The STEP bridge is an implemented connection to an existing file parser, tested with an actual STEP assembly fixture.

## Mathematical model

Let a local immutable source snapshot have revision vector \(\nu\), and let \(G_\nu=(V,E)\) be its typed evidence graph. A record contains a fact, source locator, revision, validity and mandatory dependencies. The directed edge \(v\to u\) means that using \(v\) requires \(u\).

A query planner declares a finite set \(P\) of required predicates. Examples are “subgroup primary result with its qualification”, “B's pose relative to A”, and “recomputed total for Summary!B2”. These declarations are part of the trusted query contract; the compiler cannot infer whether they fully express an arbitrary natural-language request.

Each candidate alternative \(a_i\) has:

- coverage \(C_i\subseteq P\);
- visible evidence roots \(V_i\);
- local computation audit roots \(A_i\);
- a guarantee label and validity conditions.

Let \(\operatorname{cl}(X)\) denote transitive dependency closure, including \(X\). For a selected subset \(S\),

\[
C(S)=\bigcup_{i\in S} C_i,\qquad
E(S)=\operatorname{cl}\!\left(\bigcup_{i\in S}V_i\right),\qquad
H(S)=\operatorname{cl}\!\left(\bigcup_{i\in S}A_i\right).
\]

Every record in \(E(S)\cup H(S)\) must exist, be valid, and match the trusted revision vector. \(E(S)\) goes to the model. \(H(S)\) is validated locally and recorded in the audit; it need not be transmitted. This distinction is what allows a computed total or transform to replace many raw inputs without discarding the inputs needed to verify or invalidate it locally.

Let \(J(S)\) be the complete serialized JSON response, including status, covered and missing predicates, evidence, provenance and guarantee labels. Define

\[
B(S)=|J(S)|_{\text{UTF-8 bytes}},\qquad
T_\tau(S)=|\operatorname{encode}_\tau(J(S))|.
\]

The optional tokenizer \(\tau\) is supplied by the caller. With it, the default objective is \(T_\tau\); otherwise the objective is \(B\). Both byte and optional token limits apply to the complete response. The lexicographic objective is

\[
\min_{S\text{ valid}} \bigl(-|C(S)|,\; c(S),\; B(S),\; |S|,\;\text{sorted alternative IDs}\bigr)
\]

subject to \(B(S)\le b\) and, when supplied, \(T_\tau(S)\le t\). All declared requirements have equal weight. Full coverage wins whenever it is feasible; otherwise the compiler returns the best partial coverage among candidates it examines. An omitted requirement is explicitly listed as missing. If even the empty response cannot fit, the call raises an error.

Costs are measured after union and serialization. They are not sums of independently estimated chunk costs: shared dependencies, duplicate sources, JSON escaping and tokenizer boundaries make costs nonadditive.

### Selection algorithm

1. Validate record IDs, finite JSON locators, source revisions and alternative shapes.
2. Compute the visible and audit closures for each alternative. Reject alternatives with any missing, stale, unknown or invalid dependency.
3. For at most 18 supplied alternatives, enumerate every subset. Construct and measure its complete response; retain the best feasible candidate under the objective above.
4. For larger candidate sets, `auto` uses greedy marginal coverage per measured marginal cost. Explicit `exact` mode refuses sets larger than 18. Explicit `greedy` mode is available for comparisons.
5. Emit the packet and a separate local audit containing selected and rejected alternatives, dependency IDs, solver and accounting.

For accepted requests whose budgets accommodate the empty response, the exact solver has a finite-candidate optimality guarantee because it evaluates every subset, including the empty subset. In the worst case it performs \(2^m\) serializations and tokenizations for \(m\) alternatives; the 18-candidate limit is a research bound, not a production latency guarantee. Candidate closure preprocessing costs at most \(O(m(n+e))\); enumeration and tokenization usually dominate. No claim of polynomial-time global optimization is made.

Greedy returns `optimality: "unknown"`. There is no claimed approximation ratio, and it can return partial coverage even when another feasible combination exists. The test suite and benchmark include a constructed case where greedy is more expensive than exhaustive selection.

### What preservation means

For a supported local operator \(f_p\), an ideal task-sufficient representation \(R(G,P)\) permits a decoder \(d_p\) such that

\[
d_p(R(G,P))=f_p(G),\qquad p\in P.
\]

The prototype does not prove this equality for arbitrary models or documents. Its enforceable claims are narrower:

- **Declared dependency preservation:** every selected visible record's declared dependencies are also visible.
- **Local computation provenance:** every declared audit dependency is present, valid and revision-consistent.
- **Supported operator contract:** trusted adapter code computes a defined operation over complete declared operands. Geometry and formulas use float64; physical error bounds and exact decimal arithmetic are not supplied.
- **Budget and selection:** complete serialized output fits the supplied budgets, with exhaustive optimality only over the supplied alternatives and objective.

The compiler cannot detect an undeclared qualifier, an incorrectly normalized formula, a fabricated source hash or a misleading coverage claim. The adapter/query planner must be trusted application code. A model-generated alternative or a statement inside a retrieved document must not be allowed to certify its own validity. `complete_for_declared_requirements` deliberately does not mean “complete knowledge of the source”. Guarantee classes are not ranked; callers requiring a minimum class must filter alternatives before compilation.

A local audit is not an independently checkable proof for a remote model. It becomes independently inspectable only if the corresponding operands, algorithm version and verification logic are exported or separately fetched. SHA-256 digests used for refinement are consistency checks, not signatures or authorization credentials.

### Why a universal tiny representation is impossible

Consider a document containing \(N\) independent binary facts. If the representation must answer every fact-retrieval query exactly, it must distinguish \(2^N\) possible documents, requiring at least \(N\) bits in the worst case. A much smaller task-specific packet is possible because it supports a restricted predicate set, or because the system can ask the local store another question later. More information can also be discarded if approximation is permitted, but that needs a defined error metric and separate validation.

The practical strategy is therefore to preserve query-relevant relationships, keep the original structure locally, and refine on demand. It is not universal lossless compression of meaning.

## Domain contracts

### 3D geometry

Every component instance has its own occurrence ID, even when several instances share one part definition. An occurrence transform maps local coordinates to a shared world frame, using row-major matrices acting on column vectors:

\[
T_A=\begin{bmatrix}R_A&t_A\\0&1\end{bmatrix},\qquad
T_{A\leftarrow B}=T_A^{-1}T_B
=\begin{bmatrix}R_A^TR_B&R_A^T(t_B-t_A)\\0&1\end{bmatrix}.
\]

The result explicitly states the source and destination occurrence IDs and length unit. Local named axes are transformed into world coordinates. The unsigned angle between directed unit axes is

\[
\theta=\operatorname{atan2}(\|u\times v\|,u\cdot v)\in[0,\pi].
\]

Supported operations are `relative_transform`, `axis_angle` and `solid_box_separation`. The last is restricted to explicitly occupied solid boxes that are exactly axis-aligned in the world frame. For each axis \(j\),

\[
g_j=\max(0,\ell_{Bj}-u_{Aj},\ell_{Aj}-u_{Bj}),\qquad d=\sqrt{g_x^2+g_y^2+g_z^2}.
\]

It returns nearest witness points and distinguishes positive separation from `touching_or_overlapping`. A bounding box around an arbitrary object is not accepted as its occupied solid. Rotated boxes, general surfaces, motion clearance, inferred adjacency and manufacturing feasibility need other operators.

Unknown placements or units, non-finite transforms, scaling and reflections fail closed. Input transforms must already compose any parent transforms into the same world frame. The STEP bridge uses Lasso's `readStepModel`; any structural placement/cycle/truncation warning disqualifies requested placement computations because the current parser does not expose validity per occurrence. It supports relative transforms and axis angles only. Its `occurrence:N` IDs are local to a revision, not persistent IDs across edits.

### PDFs and other documents

The adapter takes already extracted records with explicit `requires` relationships and page/sentence locators. A study result can require an endpoint definition, population, confidence-interval explanation, limitation, table header or footnote elsewhere in the file. Those records become mandatory visible context. A single attractive sentence is insufficient if its interpretation depends on a remote qualification.

Each request supplies alternative candidate roots for one requirement. To summarize several findings, declare several requirements. The prototype does not determine semantic completeness or discover missing links automatically. The benchmark's document dependencies are hand-declared ground truth; its success must not be represented as automatic PDF understanding.

### Spreadsheets

Cells are normalized into literals or supported operators: `sum`, `difference`, and `ratio`. Formula evaluation traverses every declared operand, rejects cycles and missing values, checks declared units, rejects division by zero and ignores formula caches. A stale literal fails; a stale formula cache is harmless when all operands are current and the result is recomputed.

The visible response contains the requested result, unit, cell locator, operator, dependency count and local audit reference. Complete formulas and operand values stay in the local audit graph. This prevents a sum of 1,000 cells from returning 1,000 cell names as supposed compression.

This is not an Excel calculation engine. External references, volatile functions, arbitrary formula strings, structured references, hidden-row filtering, date systems, rounding conventions and recalculation policy need explicit handling before integration. An adapter must never silently normalize an unsupported workbook formula to a supported one.

## Incremental context and model memory

`refineContext` compiles the next graph against its current revision mapping and preserves all previously declared requirements, including unmet ones. To intentionally change the task, start a new query.

A patch is considered only when the client supplies the digest of the full context it actually retains. The patch contains its base digest, next digest, complete next metadata, removals and changed evidence. The client verifies reconstruction with `applyContextUpdate`. A wrong or missing receipt produces a full response. Source changes invalidate old facts through ordinary revision validation.

A patch must fit both configured budgets and be strictly cheaper under the chosen objective than the full response. Digest and metadata overhead can make full replacement cheaper for small packets.

This is client-managed state, not a claim that an MCP connection gives ChatGPT or Claude permanent memory. If the host reconstructs and resends the entire context on each model call, only wire traffic may shrink. If it sends deltas into a retained conversation, old messages may still contribute to later input-token charges. The measured refinement saving concerns newly emitted tool content only. End-to-end savings require an actual host integration and usage measurements.

## Using the prototype

The repository requires Node 24 or newer. No additional dependency is needed for byte budgets or tests.

```js
import { buildGeometryContext } from './src/agent/structural/adapters.js';
import { compileContext } from './src/agent/structural/compiler.js';

const placement = (x) => [[1, 0, 0, x], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const graph = buildGeometryContext({
  source: { id: 'authorized-assembly-id', revision: 'snapshot-content-hash' },
  expectedRevision: 'snapshot-content-hash',
  unit: 'mm',
  occurrences: [
    { id: 'A', definitionId: 'bolt', placementValidity: 'valid', transform: placement(0) },
    { id: 'B', definitionId: 'bolt', placementValidity: 'valid', transform: placement(25) },
  ],
  queries: [{ id: 'pose', op: 'relative_transform', a: 'A', b: 'B' }],
});
const result = compileContext({ ...graph, budgetBytes: 3000 });
console.log(result.text); // selected context for a future tool response
// result.audit stays local unless an explicit verification request needs it.
```

Core input records are `{id,text,requires,source:{id,revision,locator?},validity}`. Alternatives are `{id,covers,evidence,audit,guarantee}`. Record IDs must be unique within a compilation; the prototype adapters produce one source graph per call. A production multi-source composer must namespace IDs and remap all edges before merging graphs.

Optional token measurement:

```js
const result = compileContext({
  ...graph, budgetBytes: 12000, budgetTokens: 1800,
  tokenCounter: (text) => encoding.encode(text).length,
  objective: 'tokens', // default when tokenCounter is provided
});
```

The callback must deterministically count the complete serialized string and return a nonnegative integer. It should be configured for ordinary untrusted text, including any special-token-looking strings. Use a validated tokenizer for the intended host when available. An `o200k_base` measurement is not a Claude measurement or a promise about billing for a particular model.

Run the focused tests and offline byte benchmark:

```sh
node --test test/structural-*.test.js
node scripts/structural-context-benchmark.mjs --out /tmp/lasso-structural-byte-results
```

Reproduce the token experiment using a separately installed, pinned optional tokenizer (this does not modify Lasso's package dependencies):

```sh
mkdir -p /tmp/lasso-structural-tokenizer
npm install --prefix /tmp/lasso-structural-tokenizer --ignore-scripts js-tiktoken@1.0.21
node scripts/structural-context-benchmark.mjs \
  --tokenizer-module /tmp/lasso-structural-tokenizer/node_modules/js-tiktoken/dist/index.js \
  --out docs/agent
```

The generated Markdown and JSON reports are `structural-framework-results.md` and `structural-framework-results.json`. Payload counts are deterministic for the pinned tokenizer; timestamps and timings vary by run.

## Findings and what they establish

The [offline report](structural-framework-results.md) contains the actual token counts. In three synthetic tasks, compiled responses were 93.85–96.11% smaller than full normalized context. They were 25.56–32.04% larger than a compact direct local-results baseline that already knew the necessary records and performed the same operations. Therefore the current result does **not** establish that this compiler beats competent targeted retrieval on ordinary workloads. Repeated provenance and coverage metadata are visible costs.

A constructed overlapping-alternative fixture used 86 tokens with exact selection versus 93 with greedy selection, a 7.53% reduction. That is an existence demonstration, not an estimate of expected savings. The three ordinary tasks each have one alternative per requirement, so exact and greedy selection provide no meaningful comparison there.

Three incremental document turns used 743 newly emitted tokens instead of 1,227 for repeated complete packets, a 39.45% reduction under explicit client retention. A sum over 10, 100 and 1,000 inputs returned 199, 200 and 204 tokens respectively. Local operand validation still grew with input size.

These experiments check correct fixture results and declared-context retention. They do not measure model answer quality, actual source retrieval errors, real customer workloads, indexing cost or total provider usage. The STEP integration has independent tests but is not represented as a customer CAD benchmark.

For a workload of \(Q\) queries, a more complete economic model is

\[
\Delta C = p_{\rm in}\sum_{q=1}^{Q}(T_{\rm baseline,q}-T_{\rm lasso,q})
- C_{\rm indexing}-C_{\rm local\ queries}-C_{\rm maintenance}
-\Delta C_{\rm outputs/retries}.
\]

Token savings alone do not prove net computational, financial or energy savings. Local indexing and kernel computation move work away from the model, and repeated queries can amortize that work. No break-even value is asserted without measurements.

## Lasso integration plan

Status on 30 October 2026: steps 1 and 4 are done for STEP geometry (the evidence service resolves and authorizes the file and pins its content hash; `src/agent/geometry.js` uses the bridge and compiler). Step 5 took the form of `lasso` asks and an `{op: "pose"|"angle", file, a, b}` object, adding no tool and two words to the definition. Step 6 is in `scripts/agent-benchmark-live.mjs` (OpenAI and Claude, cache reads and writes apart), waiting for API keys. Steps 2, 3 and 7 are open.

1. **Snapshot and authorization boundary.** Resolve existing source handles and permitted directories before loading graph records. Use immutable snapshot/content revisions from the local store; do not accept revision assertions from model text. Recheck access on refinement. A digest must not grant file access. Never follow arbitrary file paths embedded in a source document.
2. **Incremental structural indexing.** Extend the local index with typed records, dependency edges, locators and extraction version. A suitable persisted key is `(source_id, revision, adapter_version, record_id)`. Store derived computations by `(operator_version, operand_revisions, parameters)` and maintain reverse dependency edges for invalidation. This storage is specified here, not implemented by the prototype.
3. **Candidate retrieval and planning.** Reuse `src/agent/text-index.js`, `selectEvidence` and `withContext` in `src/agent/select.js` for candidate discovery. Extend the context graph for remote definitions, exceptions, tables and footnotes. Distinguish heuristic semantic links from verified format links. Reuse existing local aggregation/structure facilities in `src/agent/evidence.js`; do not duplicate already implemented local computation merely to claim a new saving.
4. **Typed geometry and spreadsheet operations.** Use `readStepModel` and its occurrence transforms through the implemented bridge. Add per-occurrence placement validity to the upstream index before relaxing global warning rejection. For XLSX, implement an allowlisted formula parser with explicit external-reference and cache policy, then generate normalized operators. A geometry kernel must supply trustworthy shape-distance queries before general clearance claims are allowed.
5. **Small additive MCP surface.** A future `lasso_context` call would accept an authorized source handle, declared task/predicates, budget and optional retained digest. Return the selected packet and opaque local handle. An explicit expansion call would request additional predicates or audit detail. Keep schemas small and distinguish “insufficient budget”, “unsupported operation” and “unknown dependency”. Do not expose the entire local audit by default. These tool names are proposed contracts, not registered tools.
6. **Host-specific accounting.** Measure complete schemas, requests, response framing, conversation replay, retries and model outputs. Do not send the same packet twice through text and structured response fields. Capability-test retention and compaction recovery before enabling delta responses for a host.
7. **Rollout gate.** Keep existing MCP behavior as the default. Evaluate the new path on held-out real documents, workbooks and assemblies with independent ground truth. Ship only after it preserves answer accuracy and source-access boundaries and improves total workload cost over the current implementation.

## Research contribution and novelty boundary

The broad ingredients already have substantial prior art. SpreadsheetLLM describes structure-aware spreadsheet encoding and SheetCompressor; this directly limits any claim that structural spreadsheet compression itself is new. [SpreadsheetLLM, Dong et al.](https://arxiv.org/abs/2407.09025)

G-Retriever optimizes retrieval over textual graphs using a prize-collecting Steiner tree formulation. A generic “select a small relevant subgraph for an LLM” claim would overlap established work. [G-Retriever, He et al.](https://arxiv.org/abs/2402.07630)

AgentsCAD parses STEP geometry, constructs face-adjacency topology and supplies geometry information to language-model reasoning. Geometry-to-language tools and structured CAD context are therefore also established directions. [AgentsCAD, George et al.](https://arxiv.org/abs/2607.02448)

BrepLLM trains geometric encoders and adapts an LLM to reason over B-rep information. It is relevant to compact structural representation, though its learned multimodal path differs from an ordinary text-based MCP used by an unchanged model. [BrepLLM, Deng et al.](https://arxiv.org/abs/2512.16413)

Exhaustive subset search, dependency closure, query pushdown, memoization and delta updates are established techniques. This prototype implements a concrete combination and a testable contract; it does not establish a new foundational algorithm, a publication-level novelty claim or patentability.

A defensible next research hypothesis is: **joint selection of raw evidence and verified local operator results, with typed dependency obligations and explicit refinement, reduces total interaction cost at equal task accuracy across heterogeneous structured sources.** It requires better evidence than a comparison with full-file uploads.

The next experiments should:

- Introduce genuinely competing representations per requirement: raw operands, computed result, structural relation, coarse summary and requested expansion. Require equivalent stated guarantees before comparing costs.
- Compare current Lasso, competent retrieval plus local operators, dependency-aware top-k, graph retrieval, exact finite-candidate selection and bounded heuristics. Separate gains from retrieval, local computation, selection, serialization and caching through ablations.
- Reduce the measured metadata overhead, for example by a versioned source table and compact typed relation encoding, while testing source attribution and model comprehension. Do not assume fewer characters always means fewer tokens or better answers.
- Use adversarial held-out tasks: repeated CAD instances with different frames, missing placements, unknown units, exceptions in remote footnotes, contradictory passages, stale workbook caches, formula cycles and changed source revisions.
- Report accuracy, unsupported/unknown rates, total input/output tokens, latency, local memory/CPU, indexing amortization, and confidence intervals over actual workloads. Use the same model settings and task ground truth for every baseline.

The current framework makes that hypothesis executable and falsifiable. Establishing novelty or superior production efficiency remains future research.
