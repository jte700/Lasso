# Reader contract

A reader turns one file's bytes into source objects. Lasso has one reader per kind of file, listed in [src/dependencies/readers.js](../src/dependencies/readers.js), and runs them all in its one server process. This page describes what a reader receives and returns, so a reader written in another language can run as a child process with the same contract.

## The registry

Each reader is an entry in `READERS`:

| Field | Meaning |
|---|---|
| `id` | A stable name, such as `table`, `pdf` or `code`. |
| `version` | A whole number, bumped whenever the reader reads the same bytes differently. |
| `accepts(file)` | Whether this reader reads the file. The first reader that accepts a file reads it. |
| `extract` | How it reads: `file` (bytes in memory), `table` (a batch of rows at a time, off the thread when large) or `video` (from the file where it lies). |

Every index records the version of each reader that read it (`snapshot_object_indexes.reader_versions_json`). When a reader's version changes, re-reading a folder reads only that reader's files and carries every other file's objects forward. Indexes written before readers had versions are re-read by kind of file, as before.

## Input

A reader is given the file as the snapshot recorded it:

```json
{ "path": "Budget/Q3.xlsx", "fileType": "spreadsheet", "contentHash": "<sha256 of the raw bytes>",
  "size": 48213, "projectFileId": "<stable id of the file>" }
```

and either its bytes or a path to them. Text versions may be stored compressed; a reader that is given a path always gets one to the raw bytes (`BlobStore.rawPath`).

## Output

A list of object descriptors, each built as `objectDescriptor` in [src/dependencies/object-descriptors.js](../src/dependencies/object-descriptors.js) builds them:

```json
{ "key": "<projectFileId>:cell:payroll:Amount", "type": "DATASET_VALUE", "path": "Budget/Q3.xlsx",
  "anchor": { "kind": "table-cell", "rowIndex": 3, "column": "Amount" },
  "label": "Payroll · Amount", "value": "19,250", "contentHash": "<sha256>", "metadata": {} }
```

- `key` is the object's identity. It must be the same for the same thing in every version of the file: name a row by its label, not its position (see [src/dependencies/row-identity.js](../src/dependencies/row-identity.js) for rows without names).
- `type` is one of `OBJECT_TYPES` in [src/dependencies/constants.js](../src/dependencies/constants.js).
- A new version of an object is recorded only when its value, label, search text, metadata or anchor changes, so a reader must not put anything that changes on every reading (a time, a counter) into them.

A reader may also report one problem for the file, `{ "code": "UNREADABLE_CONTENT", "reason": "plain words" }`, which the folder's indexing issues show.

## Steps and workers

A reader that takes a while is a generator. It yields `{ share }` (0 to 1) as it goes, and may yield `{ share, offThread(report) }`, where `offThread` starts its work in a worker and returns a promise of the result; the caller either awaits it or, when it must have the answer now, the reader does the work on the calling thread instead.

Heavy readers run in workers ([src/worker-pool.js](../src/worker-pool.js)): each starts one worker for one job, with its own memory limit, and ends it when the job is done. At most two run at once; the rest wait their turn, with a model preview someone is waiting to see going before waiting indexing. A worker that posts nothing for two minutes (one minute for a large table) is stopped and its turn handed on, so one that never exits cannot hold it. A worker receives its job as `workerData` and posts:

| Message | Meaning |
|---|---|
| `{ "progress": 0.4 }` | How far it got. |
| `{ "done": true, ... }` | Finished, with its result. |
| `{ "error": "plain words" }` | It failed; the file is reported as a problem. |

A reader in another process would use the same three messages as newline-delimited JSON on standard output, after reading one job (the input above plus `"bytesPath"`) as JSON on standard input.
