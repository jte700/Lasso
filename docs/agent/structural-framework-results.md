# Structural context prototype: offline results

Measurement: **o200k_base tokens via local js-tiktoken**. Counts cover serialized response content, not total API usage.

Fixtures are synthetic and required evidence is known in advance. These are structural correctness and payload-size experiments, not a production retrieval or model-answering benchmark.

| Workload | Full context | Dependency-complete inputs | Direct local results | Compiled | Saving vs full | Saving vs direct |
|---|---:|---:|---:|---:|---:|---:|
| document-study | 7,768 | 366 | 362 | 478 | 93.85% | -32.04% |
| spreadsheet-240 | 7,651 | 6,151 | 237 | 298 | 96.11% | -25.74% |
| geometry-80-occurrences | 5,923 | 229 | 223 | 280 | 95.27% | -25.56% |

Negative saving means the compiler emitted more. Direct local results already execute the same supported operators and retain the same required evidence; they use one source header and omit the compiler’s coverage/status metadata. This is a strong baseline. Compiler bookkeeping has a measurable cost.

Dependency-complete inputs contain all required raw facts with units and dependencies, before replacing calculations with local results. For small geometry queries, sending two transforms can be cheaper than a rich computed result packet.

The deliberately adversarial selection fixture used 86 tokens with exhaustive selection and 93 with greedy selection (7.53% smaller). Ordinary workloads above have one alternative per requirement, so they do not establish an optimization advantage.

Three incremental document turns sent 743 tokens, versus 1227 when sending each complete packet (39.45% reduction in new response content). This assumes an explicitly retained client context. Missing retention confirmation produced a full response. It does not establish a reduction in total billed conversation tokens.

| Aggregate input cells | Full payload | Compiled payload | Locally validated records |
|---|---:|---:|---:|
| 10 | 318 | 199 | 13 |
| 100 | 2,568 | 200 | 103 |
| 1000 | 25,074 | 204 | 1003 |

The aggregate’s output remains small while local evaluation still reads every dependent operand. This moves computation out of the language model; it does not make all computation constant-time.

All fixture correctness assertions, undersized-byte-budget checks and stale-revision rejection checks passed. Unit tests separately exercise missing qualifiers, missing placements, repeated STEP occurrences, formula cycles, unit mismatches and corrupt refinement patches.

No empirical novelty claim, model accuracy score, real customer savings estimate or Claude token count follows from this experiment. See [the specification](structural-framework.md) for contracts, limits and reproduction commands.
