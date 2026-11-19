/**
 * dispatch_task 主流程：校验 → 幂等 → 写 pending_wake → 唤醒 → delivered。
 * 目标校验全部发生在写台账和唤醒之前；同 taskId 的并发派工在进程内串行化。
 */

import { randomBytes } from "node:crypto";

import { DispatchError, ERROR_CODES, invalidArgument } from "./errors.js";
import { normalizeRecord } from "./store.js";
import { formatShanghai, nowIso, nowMs, parseShanghaiTime } from "./time.js";
import { resolveBriefPath } from "./paths.js";
import { archivedSessionSet, isTopLevelHeader } from "./roster.js";
import { walkMirrorAfterWrite } from "./mirror.js";
import { wakeTarget } from "./wake.js";

const ALLOWED_KEYS = new Set([
  "to",
  "taskId",
  "title",
  "priority",
  "deadline",
  "briefPath",
  "acceptance",
  "ackBy",
  "dedupeKey",
]);
const EMPLOYEE_RE = /^[A-Z]-[0-9]{3}$/;
const TASK_RE = /^TSK-[0-9]{8}-[0-9]{2}$/;
const PRIORITIES = new Set(["P0", "P1", "P2"]);
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function text(value) {
  return typeof value === "string" ? value : "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertPayloadSize(args, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw invalidArgument("参数无法序列化");
  }
  const bytes = Buffer.byteLength(serialized ?? "", "utf8");
  if (bytes > maxBytes) {
    throw new DispatchError(ERROR_CODES.PAYLOAD_TOO_LARGE, "入参超过 100KB 上限");
  }
}

function assertKnownKeys(args) {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_KEYS.has(key)) throw invalidArgument(`未知参数：${key}`);
  }
}

function requireText(args, key, min, max, label) {
  const value = text(args[key]).trim();
  if (value.length < min || value.length > max) {
    throw invalidArgument(`${label}长度必须在 ${min}-${max} 之间`);
  }
  return value;
}

export function callerIdFromExec(exec) {
  const agent = exec?.agent;
  const id = agent?.id ?? agent?.session?.id;
  return typeof id === "string" ? id.trim() : "";
}

export function requireCaller(exec) {
  const callerId = callerIdFromExec(exec);
  if (!callerId) throw new DispatchError(ERROR_CODES.UNAUTHORIZED_CALLER, "无法确认调用者身份");
  return callerId;
}

export function authorizeIssuer(runtime, callerId) {
  const entry = runtime.whitelistBySession.get(callerId);
  if (!entry || !["issuer", "assistant"].includes(entry.kind)) {
    throw new DispatchError(ERROR_CODES.UNAUTHORIZED_ISSUER, "调用者不在派工白名单");
  }
  return entry;
}

function makeUlid() {
  let timePart = "";
  let remaining = Date.now();
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD[remaining % 32] + timePart;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = randomBytes(16);
  let randomPart = "";
  for (let index = 0; index < 16; index += 1) {
    randomPart += CROCKFORD[bytes[index] % 32];
  }
  return (timePart + randomPart).slice(0, 26);
}

function normalizeSessions(records) {
  const list = Array.isArray(records)
    ? records
    : Array.isArray(records?.sessions)
      ? records.sessions
      : [];
  return list
    .map((record) => record?.header ?? record)
    .filter((header) => header && typeof header === "object" && typeof (header.id ?? header.sessionId) === "string");
}

async function listSessionHeaders(ctx) {
  if (!ctx?.sessionQuery || typeof ctx.sessionQuery.listSessions !== "function") {
    throw new DispatchError(ERROR_CODES.TARGET_SESSION_MISSING, "会话记录不可用");
  }
  let records;
  try {
    records = await ctx.sessionQuery.listSessions(AbortSignal.timeout(5000));
  } catch {
    throw new DispatchError(ERROR_CODES.TARGET_SESSION_MISSING, "会话记录不可用");
  }
  return normalizeSessions(records);
}

function archivedIds(ctx) {
  return archivedSessionSet(ctx);
}

async function resolveTarget(ctx, employee, callerId) {
  const headers = await listSessionHeaders(ctx);
  const header = headers.find((item) => (item.id ?? item.sessionId) === employee.sessionId);
  if (!header) throw new DispatchError(ERROR_CODES.TARGET_SESSION_MISSING, "目标会话记录不存在");
  if (archivedIds(ctx).has(employee.sessionId)) {
    throw new DispatchError(ERROR_CODES.TARGET_ARCHIVED, "目标会话已归档");
  }
  if (!isTopLevelHeader(header)) {
    throw new DispatchError(ERROR_CODES.TARGET_NOT_TOP_LEVEL, "目标不是顶层会话");
  }
  if (employee.sessionId === callerId) {
    throw new DispatchError(ERROR_CODES.TARGET_IS_CALLER, "不能向调用者自己派工");
  }
  return employee;
}

export function withTaskLock(runtime, key, fn) {
  const previous = runtime.taskLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  runtime.taskLocks.set(key, tail);
  return run.finally(() => {
    if (runtime.taskLocks.get(key) === tail) runtime.taskLocks.delete(key);
  });
}

function responseFrom(record, wake, options = {}) {
  return {
    ok: true,
    dispatchId: record.dispatchId,
    taskId: record.taskId,
    dedupeKey: record.dedupeKey,
    target: {
      employeeId: record.targetEmployeeId,
      name: record.targetName,
      department: record.department,
      sessionId: record.targetSessionId,
    },
    status: record.status,
    deliveredAt: record.deliveredAt,
    duplicate: options.duplicate === true,
    wake: {
      attempted: options.attempted === true,
      mode: wake?.mode === "resolved" ? "resolved" : "live",
      settled: options.attempted === true ? true : wake?.settled === true,
    },
    ...(options.retried === true ? { retried: true } : {}),
  };
}

function note(record, at, bySessionId, kind, textValue) {
  return [
    ...record.notes,
    {
      at,
      bySessionId,
      kind,
      text: String(textValue).slice(0, 2000),
    },
  ];
}

async function markRetryFailure(runtime, record, error) {
  const at = nowIso(runtime.ctx);
  await runtime.store.update(record.dispatchId, {
    status: "wake_failed",
    updatedAt: at,
    wake: {
      mode: record.wake.mode,
      messageId: record.wake.messageId,
      attemptedAt: at,
      settled: false,
      error: error.code || ERROR_CODES.WAKE_FAILED,
    },
    notes: note(record, at, record.issuerSessionId, "system", `wake-failed: ${error.code || ERROR_CODES.WAKE_FAILED}`),
  });
}

async function retryWake(runtime, record) {
  const at = nowIso(runtime.ctx);
  let wake;
  try {
    wake = await wakeTarget(runtime.ctx, record, {
      timeoutMs: runtime.config.wake.timeoutMs,
      now: nowMs(runtime.ctx),
    });
  } catch (error) {
    const normalized = error instanceof DispatchError
      ? error
      : new DispatchError(ERROR_CODES.WAKE_FAILED, "唤醒目标会话失败");
    await markRetryFailure(runtime, record, normalized);
    throw normalized;
  }
  const delivered = await runtime.store.update(record.dispatchId, {
    status: "delivered",
    deliveredAt: at,
    updatedAt: at,
    wake,
    notes: note(record, at, record.issuerSessionId, "system", "wake-retried"),
  });
  await walkMirrorAfterWrite(runtime, delivered);
  return responseFrom(
    { ...delivered, status: "delivered", deliveredAt: at },
    wake,
    { duplicate: true, retried: true, attempted: true },
  );
}

async function handleExisting(runtime, existing, taskId, target, dedupeKey) {
  if (existing.targetSessionId !== target.sessionId) {
    throw new DispatchError(ERROR_CODES.TASK_ID_TARGET_CONFLICT, "同一 taskId 已派给其他目标");
  }
  if (dedupeKey && dedupeKey !== existing.dedupeKey) {
    throw new DispatchError(ERROR_CODES.DEDUPE_KEY_MISMATCH, "dedupeKey 与服务端计算不一致");
  }
  if (["pending_wake", "wake_failed"].includes(existing.status)) {
    return retryWake(runtime, existing);
  }
  return responseFrom(existing, existing.wake, { duplicate: true, attempted: false });
}

export async function dispatchTask(ctx, runtime, args, exec) {
  if (!isPlainObject(args)) throw invalidArgument("参数必须是对象");
  assertPayloadSize(args, runtime.config.maxPayloadBytes);
  assertKnownKeys(args);

  const callerId = requireCaller(exec);
  const issuer = authorizeIssuer(runtime, callerId);

  const to = requireText(args, "to", 1, 8, "目标工号");
  if (!EMPLOYEE_RE.test(to)) throw invalidArgument("目标必须是工号（如 R-101）");
  const taskId = requireText(args, "taskId", 1, 32, "taskId");
  if (!TASK_RE.test(taskId)) throw invalidArgument("taskId 格式不合法");
  const title = requireText(args, "title", 1, 200, "标题");
  const priority = text(args.priority);
  if (!PRIORITIES.has(priority)) throw invalidArgument("priority 必须是 P0/P1/P2");
  const acceptance = requireText(args, "acceptance", 1, 2000, "验收标准");
  const briefPath = requireText(args, "briefPath", 1, 512, "briefPath");
  if (args.dedupeKey !== undefined && typeof args.dedupeKey !== "string") {
    throw invalidArgument("dedupeKey 必须是字符串");
  }
  const suppliedDedupeKey = args.dedupeKey === undefined ? "" : text(args.dedupeKey);
  if (suppliedDedupeKey.length > 300) throw invalidArgument("dedupeKey 不能超过 300 字符");

  const employee = await resolveTarget(
    ctx,
    runtime.roster.requireEnabled(to),
    callerId,
  );
  const dedupeKey = `${taskId}|${employee.sessionId}`;

  return withTaskLock(runtime, taskId, async () => {
    const existing = runtime.store.findByTaskId(taskId);
    if (existing) return handleExisting(runtime, existing, taskId, employee, suppliedDedupeKey);
    if (suppliedDedupeKey && suppliedDedupeKey !== dedupeKey) {
      throw new DispatchError(ERROR_CODES.DEDUPE_KEY_MISMATCH, "dedupeKey 与服务端计算不一致");
    }

    const now = nowMs(ctx);
    const deadline = parseShanghaiTime(args.deadline, "deadline");
    if (deadline.ms <= now) throw invalidArgument("deadline 必须晚于当前时间");
    const ackBy = args.ackBy === undefined
      ? deadline
      : parseShanghaiTime(args.ackBy, "ackBy");
    if (ackBy.ms <= now) throw invalidArgument("ackBy 必须晚于当前时间");
    if (ackBy.ms > deadline.ms) throw invalidArgument("ackBy 不能晚于 deadline");
    const brief = await resolveBriefPath(runtime.config.taskRoots, briefPath);

    const at = formatShanghai(new Date(now));
    const dispatchId = `dsp_${makeUlid()}`;
    const record = normalizeRecord({
      schemaVersion: 1,
      dispatchId,
      dedupeKey,
      taskId,
      title,
      priority,
      deadline: deadline.iso,
      ackBy: ackBy.iso,
      issuerSessionId: callerId,
      issuerEmployeeId: issuer.employeeId,
      issuerName: issuer.name,
      targetSessionId: employee.sessionId,
      targetEmployeeId: employee.employeeId,
      targetName: employee.name,
      department: employee.department,
      briefPath: brief,
      acceptance,
      status: "pending_wake",
      deliveredAt: null,
      ackedAt: null,
      updatedAt: at,
      evidencePath: null,
      eta: null,
      notes: [{ at, bySessionId: callerId, kind: "system", text: "dispatch-created" }],
      wake: { mode: "live", messageId: "", attemptedAt: null, settled: false, error: null },
    });
    await runtime.store.append(record);

    let wake;
    try {
      wake = await wakeTarget(ctx, record, {
        timeoutMs: runtime.config.wake.timeoutMs,
        now,
      });
    } catch (error) {
      const normalized = error instanceof DispatchError
        ? error
        : new DispatchError(ERROR_CODES.WAKE_FAILED, "唤醒目标会话失败");
      await markRetryFailure(runtime, record, normalized);
      throw normalized;
    }

    const deliveredAt = nowIso(ctx);
    const delivered = await runtime.store.update(dispatchId, {
      status: "delivered",
      deliveredAt,
      updatedAt: deliveredAt,
      wake,
    });
    await walkMirrorAfterWrite(runtime, delivered);
    return responseFrom(delivered, wake, { duplicate: false, attempted: true });
  });
}

export const __test = {
  makeUlid,
  normalizeSessions,
  resolveTarget,
  withTaskLock,
};
