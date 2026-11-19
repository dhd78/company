/**
 * 路径边界校验。所有任务包/证据路径必须落在配置的根目录内。
 */

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { DispatchError, ERROR_CODES } from "./errors.js";

function normalizedForCompare(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function isWithin(root, candidate) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(normalizedForCompare(rootPath), normalizedForCompare(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function containsParentTraversal(value) {
  return String(value)
    .split(/[\\/]+/)
    .some((part) => part === "..");
}

export function resolveAgainstRoots(roots, raw, options = {}) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new DispatchError(options.code ?? ERROR_CODES.INVALID_ARGUMENT, `${options.label ?? "路径"}不能为空`);
  }
  const text = raw.trim();
  if (text.includes("\0")) {
    throw new DispatchError(options.code ?? ERROR_CODES.INVALID_ARGUMENT, `${options.label ?? "路径"}不合法`);
  }
  if (options.rejectParentTraversal && containsParentTraversal(text)) {
    throw new DispatchError(options.code ?? ERROR_CODES.INVALID_ARGUMENT, `${options.label ?? "路径"}不能包含 ..`);
  }
  const list = Array.isArray(roots) ? roots : [];
  if (!list.length) {
    throw new DispatchError(options.code ?? ERROR_CODES.INVALID_ARGUMENT, "未配置允许的根目录");
  }
  const candidate = isAbsolute(text) ? resolve(text) : resolve(list[0], text);
  if (!list.some((root) => isWithin(root, candidate))) {
    throw new DispatchError(options.code ?? ERROR_CODES.INVALID_ARGUMENT, `${options.label ?? "路径"}不在允许的根目录内`);
  }
  return candidate;
}

export async function resolveBriefPath(roots, raw) {
  const candidate = resolveAgainstRoots(roots, raw, {
    code: ERROR_CODES.BRIEF_PATH_OUTSIDE_ROOT,
    label: "briefPath",
    rejectParentTraversal: false,
  });
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new DispatchError(ERROR_CODES.BRIEF_FILE_MISSING, "任务简报文件不存在");
  }
  if (!info.isFile()) {
    throw new DispatchError(ERROR_CODES.BRIEF_FILE_MISSING, "任务简报必须是文件");
  }
  return candidate;
}

export function resolveEvidencePath(roots, raw) {
  return resolveAgainstRoots(roots, raw, {
    code: ERROR_CODES.EVIDENCE_PATH_OUTSIDE_ROOT,
    label: "evidencePath",
    rejectParentTraversal: true,
  });
}
