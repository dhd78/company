/**
 * 错误码与可安全外显的异常类型。
 *
 * 所有可预期失败都使用 DispatchError；调用方只比较 code，不比较文案。
 * message 面向使用者，不包含堆栈、密钥或花名册全量。
 */

export const ERROR_CODES = Object.freeze({
  UNAUTHORIZED_CALLER: "unauthorized-caller",
  UNAUTHORIZED_ISSUER: "unauthorized-issuer",
  INVALID_ARGUMENT: "invalid-argument",
  UNKNOWN_EMPLOYEE: "unknown-employee",
  EMPLOYEE_DISABLED: "employee-disabled",
  TARGET_NOT_TOP_LEVEL: "target-not-top-level",
  TARGET_ARCHIVED: "target-archived",
  TARGET_SESSION_MISSING: "target-session-missing",
  TARGET_IS_CALLER: "target-is-caller",
  BRIEF_PATH_OUTSIDE_ROOT: "brief-path-outside-root",
  BRIEF_FILE_MISSING: "brief-file-missing",
  PAYLOAD_TOO_LARGE: "payload-too-large",
  TASK_ID_TARGET_CONFLICT: "task-id-target-conflict",
  DEDUPE_KEY_MISMATCH: "dedupe-key-mismatch",
  WAKE_FAILED: "wake-failed",
  UNKNOWN_TASK: "unknown-task",
  UNKNOWN_DISPATCH: "unknown-dispatch",
  NOT_TARGET: "not-target",
  INVALID_TRANSITION: "invalid-transition",
  INVALID_STATUS: "invalid-status",
  INVALID_ETA: "invalid-eta",
  EVIDENCE_PATH_OUTSIDE_ROOT: "evidence-path-outside-root",
  UNAUTHORIZED_VIEWER: "unauthorized-viewer",
  INVALID_QUERY: "invalid-query",
  INVALID_LIMIT: "invalid-limit",
  INTERNAL_ERROR: "internal-error",
});

export class DispatchError extends Error {
  constructor(code, message, details = undefined) {
    super(String(message || code));
    this.name = "DispatchError";
    this.code = String(code);
    if (details !== undefined && details !== null) this.details = details;
  }
}

export function invalidArgument(message = "参数不合法") {
  return new DispatchError(ERROR_CODES.INVALID_ARGUMENT, message);
}

export function asDispatchError(error, fallbackMessage = "内部错误") {
  if (error instanceof DispatchError) return error;
  return new DispatchError(ERROR_CODES.INTERNAL_ERROR, fallbackMessage);
}

export function isDispatchError(error) {
  return error instanceof DispatchError && typeof error.code === "string";
}
