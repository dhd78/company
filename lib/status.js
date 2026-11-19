/**
 * dispatch_status 查询：范围权限、分页、超期派生。
 * 超期只计算，不回写台账，不触发升级或定时器。
 */

import { DispatchError, ERROR_CODES, invalidArgument } from "./errors.js";
import { assertPayloadSize, requireCaller } from "./dispatch.js";
import { nowMs, secondsBetween } from "./time.js";

const TERMINAL = new Set(["done", "cancelled", "rejected"]);
const FILTERS = new Set(["taskId", "dispatchId", "department", "limit"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function deriveStatus(record, atMs) {
  const terminal = TERMINAL.has(record.status);
  const ackByMs = asTime(record.ackBy);
  const deadlineMs = asTime(record.deadline);
  const ackOverdue = !record.ackedAt && !terminal && Number.isFinite(ackByMs) && atMs > ackByMs;
  const deadlineOverdue = !terminal && Number.isFinite(deadlineMs) && atMs > deadlineMs;
  const overdueSeconds = Math.max(
    ackOverdue ? secondsBetween(atMs, ackByMs) : 0,
    deadlineOverdue ? secondsBetween(atMs, deadlineMs) : 0,
  );
  return {
    ackOverdue,
    deadlineOverdue,
    overdueSeconds,
    derivedStatus: deadlineOverdue ? "expired" : record.status,
  };
}

function toItem(record, atMs) {
  const derived = deriveStatus(record, atMs);
  const last = record.notes.length ? record.notes[record.notes.length - 1] : null;
  return {
    dispatchId: record.dispatchId,
    taskId: record.taskId,
    title: record.title,
    priority: record.priority,
    status: record.status,
    derivedStatus: derived.derivedStatus,
    issuer: {
      sessionId: record.issuerSessionId,
      employeeId: record.issuerEmployeeId,
      name: record.issuerName,
    },
    target: {
      sessionId: record.targetSessionId,
      employeeId: record.targetEmployeeId,
      name: record.targetName,
      department: record.department,
    },
    deliveredAt: record.deliveredAt,
    ackedAt: record.ackedAt,
    updatedAt: record.updatedAt,
    deadline: record.deadline,
    ackBy: record.ackBy,
    ackOverdue: derived.ackOverdue,
    deadlineOverdue: derived.deadlineOverdue,
    overdueSeconds: derived.overdueSeconds,
    evidencePath: record.evidencePath,
    lastNote: last ? last.text : null,
  };
}

function visibleTo(entry, callerId, record) {
  if (entry.kind === "assistant" || entry.kind === "quality") return true;
  return record.issuerSessionId === callerId || record.targetSessionId === callerId;
}

export async function dispatchStatus(ctx, runtime, args, exec) {
  if (!isPlainObject(args)) throw invalidArgument("参数必须是对象");
  assertPayloadSize(args, runtime.config.maxPayloadBytes);
  for (const key of Object.keys(args)) {
    if (!FILTERS.has(key)) throw invalidArgument(`未知参数：${key}`);
  }
  const callerId = requireCaller(exec);
  const entry = runtime.whitelistBySession.get(callerId);
  if (!entry) throw new DispatchError(ERROR_CODES.UNAUTHORIZED_VIEWER, "调用者无查询权限");

  const taskId = args.taskId === undefined ? "" : clean(args.taskId);
  const dispatchId = args.dispatchId === undefined ? "" : clean(args.dispatchId);
  const department = args.department === undefined ? "" : clean(args.department);
  if (!taskId && !dispatchId && !department) {
    throw new DispatchError(ERROR_CODES.INVALID_QUERY, "至少提供一个过滤条件");
  }
  if (args.taskId !== undefined && !taskId) throw invalidArgument("taskId 不能为空");
  if (args.dispatchId !== undefined && !dispatchId) throw invalidArgument("dispatchId 不能为空");
  if (args.department !== undefined && !department) throw invalidArgument("department 不能为空");

  let limit = 50;
  if (args.limit !== undefined) {
    limit = args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new DispatchError(ERROR_CODES.INVALID_LIMIT, "limit 必须是 1-200 的整数");
    }
  }

  const global = runtime.store.query({ taskId, dispatchId, department });
  if (taskId && !runtime.store.findByTaskId(taskId)) {
    throw new DispatchError(ERROR_CODES.UNKNOWN_TASK, "任务不存在");
  }
  if (dispatchId && !runtime.store.getByDispatchId(dispatchId)) {
    throw new DispatchError(ERROR_CODES.UNKNOWN_DISPATCH, "派工不存在");
  }

  const atMs = nowMs(ctx);
  const visible = global.filter((record) => visibleTo(entry, callerId, record));
  const total = visible.length;
  const page = visible.slice(0, limit);
  return {
    ok: true,
    query: {
      taskId: taskId || null,
      dispatchId: dispatchId || null,
      department: department || null,
      limit,
    },
    count: total,
    truncated: total > page.length,
    dispatches: page.map((record) => toItem(record, atMs)),
  };
}

export const __test = { TERMINAL, visibleTo, toItem };
