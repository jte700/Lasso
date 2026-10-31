# Evaluation spec format

An evaluation set is one JSON file: documents, rendered into real files and
indexed by Lasso, and tasks, each with the facts a correct answer must state.
`scripts/agent-eval/build.mjs` renders the documents; `scripts/agent-eval/run.mjs`
asks Lasso for each task and grades what comes back.

```jsonc
{
  "name": "set-name",
  "documents": [
    {
      "path": "Research/Trial report.pdf",       // the first part is the shared folder
      "type": "pdf",                             // pdf | docx | xlsx | md
      "title": "Document title",
      // pdf: one list of blocks per page
      "pages": [[{ "heading": "1 Introduction" }, { "paragraph": "..." }]],
      // docx and md: one list of blocks
      "blocks": [{ "heading": "Summary" }, { "paragraph": "..." }],
      // xlsx: sheets; the first column holds each row's label
      "sheets": [{ "name": "Sheet1", "header": ["Site", "Visits"], "rows": [["North", "120"]] }]
    }
  ],
  "tasks": [
    {
      "id": "kebab-case-id",
      "kind": "summary",            // summary | lookup | aggregate | compare | conflict | qualified | absent
      "prompt": "What the person asks their assistant, in their words.",
      "facts": [
        { "id": "f1", "statement": "Plain statement of one fact.", "all": ["regex", "regex"], "material": true }
      ],
      "qualifications": [
        { "id": "q1", "for": "f1", "statement": "What limits or conditions f1.", "all": ["regex"] }
      ],
      "conflicts": [{ "between": ["f2", "f3"], "statement": "How the two sources disagree." }],
      "computed": [{ "id": "c1", "statement": "A value worked out from facts.", "value": "1234", "from": ["f4", "f5"] }],
      "absent": false,
      "absence": [["regex", "regex"]],
      "answer": "A short reference answer a careful analyst would give.",
      "asks": [["a terse search", "another"], ["a question in plain words"]]
    }
  ]
}
```

Blocks:
- `{ "heading": "..." }`: a section heading.
- `{ "paragraph": "..." }`: prose. A PDF wraps it into lines.
- `{ "table": { "caption": "Table 2. ...", "header": [...], "rows": [[...]] } }`: a table. In a PDF it is set as text rows, as a PDF's text layer has it; in Word it becomes a Word table.

Facts:
- `all` is a list of JavaScript regular expressions, matched without case. Every one must match within **one sentence, or one table row together with its header**, of the document. That is how a grader checks that a value belongs to its entity, period and unit, rather than only appearing somewhere.
- The same patterns are used to check a model's answer, so write them to accept the usual ways of stating the fact (`12(?:\\.0)?\\s*%`, `twelve|12`), and keep each one short: a number, an entity's distinctive word, a unit.
- `material: true` marks a fact a correct answer must not leave out.

Tasks:
- `qualifications` are conditions, limitations or caveats that an answer stating the fact must also state.
- `conflicts` are facts from sources (or sections) that disagree; a good answer shows both and says they disagree.
- `computed` values are worked out from facts (a total, a difference); an answer may state the value or give the facts it comes from.
- `absent: true` marks a task about something the documents do not contain; the answer must say it is not there, and `facts` are then what is there instead, if anything.
- `absence` (with `absent`), optional: where a document itself says the thing is not there ("The study did not measure health outcomes, such as asthma"), one or more pattern sets, each matched like a fact's `all`. A response that shows such a sentence lets a reader say it is absent, as does one that says nothing was found.
- `asks` are the searches an assistant would send a local search tool for this task: one terse set, one in plain words. Each inner list is one call.
