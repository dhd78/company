/**
 * Markdown 台账镜像（best-effort）。
 * 失败只允许写 mirror-failed 系统备注，绝不影响 JSONL 权威数据。
 */

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { formatShanghai, nowIso } from "./time.js";

function escapeCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderLedger(records) {
  const lines = [
    "# 任务派送台账",
    "",
    `更新时间：${formatShanghai()}`,
    "",
    "| dispatchId | taskId | 标题 | 优先级 | 状态 | 派工 | 目标 | 部门 | 交付时间 | 回执时间 | 截止 | 证据 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const record of records) {
    lines.push(
      `| ${[
        record.dispatchId,
        record.taskId,
        record.title,
        record.priority,
        record.status,
        record.issuerName,
        record.targetName,
        record.department,
        record.deliveredAt,
        record.ackedAt,
        record.deadline,
        record.evidencePath,
      ]
        .map(escapeCell)
        .join(" | ")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeMirror(path, records) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, renderLedger(records), "utf8");
  try {
    await rename(temp, path);
  } catch {
    await rm(path, { force: true });
    await rename(temp, path);
  }
}

/**
 * 镜像失败只追加一条系统备注，不影响 dispatch 成功返回。
 */
export async function walkMirrorAfterWrite(runtime, record) {
  if (runtime.config.mirror.enabled !== true) return;
  try {
    await writeMirror(runtime.config.mirror.path, runtime.store.query({}));
  } catch (error) {
    const at = nowIso(runtime.ctx);
    try {
      await runtime.store.update(record.dispatchId, {
        updatedAt: at,
        notes: [
          ...record.notes,
          {
            at,
            bySessionId: record.issuerSessionId,
            kind: "system",
            text: `mirror-failed: ${error?.code ?? "io-error"}`,
          },
        ],
      });
    } catch {
      // best-effort only
    }
  }
}
