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

function filesIssue(failures) {
  // A failure Lasso can fix is the one shown, so its button explains itself.
  const shown = failures.find((failure) => LASSO_FAILURES.has(failure.code)) ?? failures[0];
  const reason = SCAN_REASONS[shown.code] ?? shown.reason;
  const name = fileName(shown.path);
  // An indexing reason names the file itself ("This workbook could not be read. ...").
  const own = /^This \w+ could not be (?:read|opened|parsed)\.\s*/i;
  const message = failures.length === 1
    ? own.test(reason) ? sentence(`${name} could not be read. ${reason.replace(own, '')}`) : sentence(`${name}: ${reason}`)
    : `${failures.length} files could not be read. ${sentence(`${name}: ${reason}`)}`;
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
