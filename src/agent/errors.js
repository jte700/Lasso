// Errors an agent can act on. Each carries a stable code so a caller can
// recover without parsing prose: narrow an ambiguous name, ask for a
// historical revision, fetch a fresh page, or tell the person what is missing.

const STATUS = {
  invalid_request: 400,
  scope_not_configured: 403,
  unauthorized: 403,
  not_found: 404,
  revision_not_found: 404,
  expired_handle: 410,
  ambiguous: 409,
  revision_mismatch: 409,
  stale_cursor: 409,
  inconsistent: 409,
  unbound: 422,
  out_of_range: 422,
  unsupported: 422,
  too_large: 413,
};

export class AgentError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = STATUS[code] ?? 400;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? this.details : {}) };
  }
}

/** Any thrown error as the shape an agent receives; internal failures keep their message only. */
export function errorBody(error) {
  if (error instanceof AgentError) return error.toJSON();
  if (Number.isInteger(error?.status) && error.status < 500) return { code: 'invalid_request', message: error.message };
  return { code: 'internal', message: error?.message ?? String(error) };
}
