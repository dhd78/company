/**
 * ack_task / report_task 状态机与审计时间戳。
 */

import { DispatchError, ERROR_CODES, invalidArgument } from "./errors.js";
import { assertPayloadSize, callerIdFromExec, requireCaller, withTaskLock } from "./dispatch.js";
import { resolveEvidencePath } from "./paths.js";
import { nowIso, parseShanghaiTime } from "./time.js";

const REPORT_STATUS = Object.freeze({
  进行中: "in_progress",
  阻塞: "blocked",
  待验收: "pending_acceptance",
  完成: "done",
  取消: "cancelled",
});

const TERMINAL = new Set(["done", "cancelled", "rejected"]);
const REPORT_TRANSITIONS = Object.freeze({
  delivered: ["cancelled"],
  pending_wake: ["cancelled"],
  wake_failed: ["cancelled"],
  acked: ["in_progress", "cancelled"],
  in_progress: ["blocked", "pending_acceptance", "cancelled"],
  blocked: ["in_progress", "pending_acceptance", "cancelled"],
  pending_acceptance: ["done", "cancelled"],
  done: [],
  cancelled: [],
  rejected: [],
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function knownKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw invalidArgument(`未知参数：${key}`);
  }
}

function taskKey(value) {
  const taskId = typeof value === "string" ? value.trim() : "";
  if (!taskId) throw invalidArgument("taskId 不能为空");
  if (taskId.length > 64) throw invalidArgument("taskId 过长");
  return taskId;
}

function optionalNote(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw invalidArgument("note 必须是字符串");
  if (value.length > 2000) throw invalidArgument("note 不能超过 2000 字符");
  return value;
}

function findTask(runtime, taskId) {
  const record = runtime.store.findByTaskId(taskId);
  if (!record) throw new DispatchError(ERROR_CODES.UNKNOWN_TASK, "任务不存在");
  return record;
}

function appendNote(record, at, bySessionId, kind, textValue) {
  return [
    ...record.notes,
    { at, bySessionId, kind, text: String(textValue).slice(0, 2000) },
  ];
}

export async function ackTask(ctx, runtime, args, exec) {
  if (!isPlainObject(args)) throw invalidArgument("参数必须是对象");
  assertPayloadSize(args, runtime.config.maxPayloadBytes);
  knownKeys(args, new Set(["taskId", "ack", "note", "eta"]));
  const callerId = requireCaller(exec);
  const taskId = taskKey(args.taskId);
  if (typeof args.ack !== "boolean") throw invalidArgument("ack 必须是布尔值");
  const noteText = optionalNote(args.note);

  let eta = null;
  if (args.eta !== undefined) {
    try {
      eta = parseShanghaiTime(args.eta, "eta");
    } catch {
      throw new DispatchError(ERROR_CODES.INVALID_ETA, "eta 不是合法时间");
    }
  }
  if (args.ack === false && args.eta !== undefined) {
    throw invalidArgument("拒绝回执不能携带 eta");
  }

  return withTaskLock(runtime, taskId, async () => {
    const record = findTask(runtime, taskId);
    if (record.targetSessionId !== callerId) {
      throw new DispatchError(ERROR_CODES.NOT_TARGET, "回执者不是该派工目标");
    }

    if (args.ack === true) {
      if (record.status === "acked") {
        return {
          ok: true,
          taskId: record.taskId,
          dispatchId: record.dispatchId,
          status: "acked",
          ackedAt: record.ackedAt,
          eta: record.eta,
          duplicate: true,
        };
      }
      if (record.status !== "delivered") {
        throw new DispatchError(ERROR_CODES.INVALID_TRANSITION, "当前状态不能确认回执");
      }
      const at = nowIso(ctx);
      const updated = await runtime.store.update(record.dispatchId, {
        status: "acked",
        ackedAt: at,
        eta: eta ? eta.iso : null,
        updatedAt: at,
        notes: appendNote(record, at, callerId, "ack", noteText || "accepted"),
      });
      return {
        ok: true,
        taskId: updated.taskId,
        dispatchId: updated.dispatchId,
        status: "acked",
        ackedAt: updated.ackedAt,
        eta: updated.eta,
        duplicate: false,
      };
    }

    if (record.status === "rejected") {
      return {
        ok: true,
        taskId: record.taskId,
        dispatchId: record.dispatchId,
        status: "rejected",
        ackedAt: record.ackedAt,
        eta: null,
        duplicate: true,
      };
    }
    if (record.status !== "delivered") {
      throw new DispatchError(ERROR_CODES.INVALID_TRANSITION, "当前状态不能拒绝回执");
    }
    const at = nowIso(ctx);
    const updated = await runtime.store.update(record.dispatchId, {
      status: "rejected",
      ackedAt: at,
      eta: null,
      updatedAt: at,
      notes: appendNote(record, at, callerId, "ack", noteText || "rejected"),
    });
    return {
      ok: true,
      taskId: updated.taskId,
      dispatchId: updated.dispatchId,
      status: "rejected",
      ackedAt: updated.ackedAt,
      eta: null,
      duplicate: false,
    };
  });
}

export async function reportTask(ctx, runtime, args, exec) {
  if (!isPlainObject(args)) throw invalidArgument("参数必须是对象");
  assertPayloadSize(args, runtime.config.maxPayloadBytes);
  knownKeys(args, new Set(["taskId", "status", "evidencePath", "note"]));
  const callerId = requireCaller(exec);
  const taskId = taskKey(args.taskId);
  const mapped = typeof args.status === "string" && Object.hasOwn(REPORT_STATUS, args.status)
    ? REPORT_STATUS[args.status]
    : undefined;
  if (!mapped) throw new DispatchError(ERROR_CODES.INVALID_STATUS, "报告状态不合法");
  const noteText = optionalNote(args.note);

  let evidencePath = null;
  if (args.evidencePath !== undefined && args.evidencePath !== "") {
    if (typeof args.evidencePath !== "string" || args.evidencePath.length > 512) {
      throw new DispatchError(ERROR_CODES.EVIDENCE_PATH_OUTSIDE_ROOT, "evidencePath 不合法");
    }
    evidencePath = resolveEvidencePath(runtime.config.evidenceRoots, args.evidencePath);
  } else if (args.evidencePath !== undefined && typeof args.evidencePath !== "string") {
    throw new DispatchError(ERROR_CODES.EVIDENCE_PATH_OUTSIDE_ROOT, "evidencePath 不合法");
  }

  return withTaskLock(runtime, taskId, async () => {
    const record = findTask(runtime, taskId);
    if (record.targetSessionId !== callerId) {
      throw new DispatchError(ERROR_CODES.NOT_TARGET, "报告者不是该派工目标");
    }
    if (TERMINAL.has(record.status)) {
      if (record.status === mapped) {
        return {
          ok: true,
          taskId: record.taskId,
          dispatchId: record.dispatchId,
          status: record.status,
          updatedAt: record.updatedAt,
          evidencePath: record.evidencePath,
          duplicate: true,
        };
      }
      throw new DispatchError(ERROR_CODES.INVALID_TRANSITION, "终态任务不能变更状态");
    }
    if (record.status === mapped) {
      return {
        ok: true,
        taskId: record.taskId,
        dispatchId: record.dispatchId,
        status: record.status,
        updatedAt: record.updatedAt,
        evidencePath: record.evidencePath,
        duplicate: true,
      };
    }
    const allowed = REPORT_TRANSITIONS[record.status] ?? [];
    if (!allowed.includes(mapped)) {
      throw new DispatchError(ERROR_CODES.INVALID_TRANSITION, "非法状态迁移");
    }
    const at = nowIso(ctx);
    const nextEvidence = evidencePath ?? record.evidencePath;
    const updated = await runtime.store.update(record.dispatchId, {
      status: mapped,
      evidencePath: nextEvidence,
      updatedAt: at,
      notes: appendNote(record, at, callerId, "report", noteText || mapped),
    });
    return {
      ok: true,
      taskId: updated.taskId,
      dispatchId: updated.dispatchId,
      status: updated.status,
      updatedAt: updated.updatedAt,
      evidencePath: updated.evidencePath,
      duplicate: false,
    };
  });
}

export const __test = { REPORT_STATUS, REPORT_TRANSITIONS, TERMINAL, callerIdFromExec };
