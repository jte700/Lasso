// The one issue a work directory shows beside its folder icon, if any.
//
// A fix is offered only when the cause is Lasso's own: a folder it failed to
// start, files it had too many of open at once, or an index made by an older
// reader. A missing folder, a permission macOS withheld, or a damaged or
// locked file is described, since Lasso cannot repair it.

const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);
const TRY_AGAIN = Object.freeze({ label: 'Try Again' });
const RE_READ = Object.freeze({ label: 'Re-read Files' });

// The scanner's reasons are terse codes; these say what happened to the file.
const SCAN_REASONS = {
  PERMISSION_DENIED: 'macOS did not let Lasso read it',
  DISAPPEARED: 'it changed or moved while Lasso was reading it',
  DEVICE_UNAVAILABLE: 'its drive stopped responding',
  NOT_A_FILE: 'it is not a regular file',
  BUSY: 'another app has it locked',
  TOO_MANY_FILES: 'Lasso had too many files open at once',
};
const LASSO_FAILURES = new Set(['TOO_MANY_FILES']);

const fileName = (filePath) => String(filePath).split('/').pop();
const sentence = (text) => {
  const trimmed = String(text ?? '').trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const PARTIAL_CODES = new Set(['PARTIALLY_INDEXED', 'DRAWING_PARTIAL']);
const NOT_INDEXED_CODES = new Set(['NOT_INDEXED_LIMIT', 'UNSUPPORTED_FORMAT', 'DRAWING_UNSUPPORTED', 'DRAWING_OCR_REQUIRED']);
const failureCategory = ({ code }) => PARTIAL_CODES.has(code) ? 'partial'
  : NOT_INDEXED_CODES.has(code) ? 'notIndexed' : 'unreadable';

function filesIssue(failures) {
  // Prioritize a fixable failure, then unreadable files over partial results.
  const shown = failures.find((failure) => LASSO_FAILURES.has(failure.code))
    ?? failures.find((failure) => failureCategory(failure) === 'unreadable')
    ?? failures.find((failure) => failureCategory(failure) === 'notIndexed') ?? failures[0];
  const reason = SCAN_REASONS[shown.code] ?? shown.reason;
  const name = fileName(shown.path);
  const category = failureCategory(shown);
  const paths = new Map();
  for (const failure of failures) {
    const kind = failureCategory(failure);
    const previous = paths.get(failure.path);
    if (!previous || kind === 'unreadable' || kind === 'notIndexed' && previous === 'partial') paths.set(failure.path, kind);
  }
  const counts = { unreadable: 0, notIndexed: 0, partial: 0 };
  for (const kind of paths.values()) counts[kind]++;
  const own = /^This \w+ could not be (?:read|opened|parsed)\.\s*/i;
  let message;
  if (paths.size === 1) {
    message = category === 'partial' ? sentence(`${name} was only partially indexed. ${reason}`)
      : category === 'notIndexed' ? sentence(`${name} was not indexed. ${reason}`)
      : own.test(reason) ? sentence(`${name} could not be read. ${reason.replace(own, '')}`) : sentence(`${name}: ${reason}`);
  } else {
    const summary = [
      counts.unreadable && `${counts.unreadable} file${counts.unreadable === 1 ? '' : 's'} could not be read`,
      counts.notIndexed && `${counts.notIndexed} file${counts.notIndexed === 1 ? ' was' : 's were'} not indexed`,
      counts.partial && `${counts.partial} file${counts.partial === 1 ? ' was' : 's were'} only partially indexed`,
    ].filter(Boolean).join('; ');
    message = `${summary}. ${sentence(`${name}: ${reason}`)}`;
  }
  return { kind: 'FILES', message: message.replace(/\s+\.$/, '.'),
    fix: failures.some((failure) => LASSO_FAILURES.has(failure.code)) ? TRY_AGAIN : null };
}

/**
 * @param {{ available: boolean, activationError: { message: string, code: string | null } | null,
 *   readerBehind: boolean, failures: Array<{ path: string, code: string, reason: string }> }} directory
 * @returns {{ kind: string, message: string, fix: { label: string } | null } | null}
 */
export function directoryIssue({ available, activationError, readerBehind, failures }) {
  if (!available) {
    return { kind: 'UNAVAILABLE', fix: null,
      message: "Lasso can't find this folder. It may have been moved or renamed, or its drive is not connected." };
  }
  if (activationError && PERMISSION_CODES.has(activationError.code)) {
    return { kind: 'PERMISSION', fix: null,
      message: 'macOS is not letting Lasso read this folder. Allow access in System Settings → Privacy & Security.' };
  }
  if (activationError) {
    return { kind: 'ACTIVATION', fix: TRY_AGAIN, message: sentence(`Lasso could not start this folder: ${activationError.message}`) };
  }
  if (readerBehind) {
    return { kind: 'READER', fix: RE_READ,
      message: "Lasso's file reader has improved since this folder was indexed, so some values may be missing." };
  }
  return failures.length ? filesIssue(failures) : null;
}
