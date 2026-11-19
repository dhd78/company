/**
 * resolveAgent + followup 的最小实现。
 * 不 import flow 插件，不等待目标会话完成一轮。
 */

import { randomUUID } from "node:crypto";

import { DispatchError, ERROR_CODES } from "./errors.js";
import { nowIso } from "./time.js";

function pickAgent(value) {
  const candidate =
    value?.agent ||
    value?.value?.agent ||
    value?.session?.agent ||
    value;
  return candidate && typeof candidate.followup === "function" ? candidate : null;
}

export async function resolveAgent(ctx, sessionId) {
  try {
    const live = ctx?.agents?.get?.(sessionId);
    if (live && typeof live.followup === "function") {
      return { agent: live, mode: "live" };
    }
  } catch {
    // fall through to controller
  }
  try {
    const controller = ctx?.get?.("sessionController");
    if (controller && typeof controller.resolveAgent === "function") {
      const result = await controller.resolveAgent(sessionId);
      const agent = pickAgent(result);
      if (agent) return { agent, mode: "resolved" };
    }
  } catch {
    // normalized by caller
  }
  return null;
}

export function buildPointerMessage(record) {
  const acceptance = typeof record.acceptance === "string" ? record.acceptance : "";
  const summary = acceptance.length > 240 ? `${acceptance.slice(0, 240)}…` : acceptance;
  return [
    "【任务派送】收到一个任务指针，请按简报执行。",
    `taskId: ${record.taskId}`,
    `dispatchId: ${record.dispatchId}`,
    `标题: ${record.title}`,
    `优先级: ${record.priority}`,
    `截止: ${record.deadline}`,
    `回执截止: ${record.ackBy}`,
    `任务简报: ${record.briefPath}`,
    `验收摘要: ${summary}`,
    "",
    "回执：调用 ack_task({ taskId, ack: true/false, note?, eta? })。",
    "进度：调用 report_task({ taskId, status, evidencePath?, note? })。",
    "状态：调用 dispatch_status({ taskId })。",
  ].join("\n");
}

export async function wakeTarget(ctx, record, options = {}) {
  const resolved = await resolveAgent(ctx, record.targetSessionId);
  if (!resolved) {
    throw new DispatchError(ERROR_CODES.WAKE_FAILED, "目标会话不可唤醒");
  }
  const timeoutMs = Math.max(100, Math.min(30000, Number(options.timeoutMs) || 2000));
  const messageId = randomUUID();
  const payload = {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: buildPointerMessage(record) }],
    source: {
      kind: "agent-message",
      form: "relay",
      busMessageId: record.dispatchId,
      threadId: record.dispatchId,
      hop: 0,
      senderSessionId: record.issuerSessionId,
    },
  };

  let timer;
  try {
    await Promise.race([
      Promise.resolve(resolved.agent.followup(payload)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new DispatchError(ERROR_CODES.WAKE_FAILED, "唤醒目标会话超时"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof DispatchError) throw error;
    throw new DispatchError(ERROR_CODES.WAKE_FAILED, "唤醒目标会话失败");
  } finally {
    if (timer) clearTimeout(timer);
  }

  return {
    mode: resolved.mode,
    messageId,
    attemptedAt: nowIso(ctx),
    settled: true,
    error: null,
  };
}
