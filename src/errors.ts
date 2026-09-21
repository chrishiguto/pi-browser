export type BrowserErrorCode =
  | "browser_invalid_input"
  | "browser_cancelled"
  | "browser_timeout"
  | "browser_upstream_error"
  | "browser_protocol_error";

const MAX_DIAGNOSTIC_CHARS = 4_096;
function sanitize(message: string): string {
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .slice(0, MAX_DIAGNOSTIC_CHARS);
}

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  /** The bounded message without the code prefix, for callers that re-wrap with more context. */
  readonly detail: string;

  constructor(code: BrowserErrorCode, message: string) {
    const bounded = sanitize(message);
    super(`${code}: ${bounded}`);
    this.name = "BrowserError";
    this.code = code;
    this.detail = bounded;
  }
}

export function browserError(code: BrowserErrorCode, message: string): BrowserError {
  return new BrowserError(code, message);
}
