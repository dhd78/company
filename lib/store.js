/**
 * 台账存储：JSONL 为权威，index.json 为派生索引。
 *
 * 写入模型：只追加完整记录快照（同一 dispatchId 的后续行代表新版本），
 * 从不改写历史行；重建时同一 dispatchId 以最后一行为准。
 * 所有写操作经进程内 Promise 串行队列；v0 假设同一 DSH_HOME 单进程。
 */

import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DispatchError, ERROR_CODES } from "./errors.js";
import { nowIso } from "./time.js";

export const RECORD_FIELDS = [
  "schemaVersion",
  "dispatchId",
  "dedupeKey",
  "taskId",
  "title",
  "priority",
  "deadline",
  "ackBy",
  "issuerSessionId",
  "issuerEmployeeId",
  "issuerName",
  "targetSessionId",
  "targetEmployeeId",
  "targetName",
  "department",
  "briefPath",
  "acceptance",
  "status",
  "deliveredAt",
  "ackedAt",
  "updatedAt",
  "evidencePath",
  "eta",
  "notes",
  "wake",
];

const STATUSES = new Set([
  "pending_wake",
  "delivered",
  "acked",
  "rejected",
  "in_progress",
  "blocked",
  "pending_acceptance",
  "done",
  "cancelled",
  "wake_failed",
]);
const PRIORITIES = new Set(["P0", "P1", "P2"]);
const NOTE_KINDS = new Set(["ack", "report", "system"]);
const MAX_LINE_BYTES = 8192;
const MAX_NOTES_BYTES = 4096;

function text(value) {
  return typeof value === "string" ? value : "";
}

function nullableText(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function normalizeNotes(value) {
  const list = Array.isArray(value) ? value : [];
  const notes = list
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      at: text(item.at),
      bySessionId: text(item.bySessionId),
      kind: NOTE_KINDS.has(item.kind) ? item.kind : "system",
      text: text(item.text).slice(0, 2000),
    }));
  // 保留最新备注：先丢最旧，再把最新一条截断到总量预算内，避免 notes 累积撑破 8KB 行上限
  while (notes.length > 1 && Buffer.byteLength(JSON.stringify(notes), "utf8") > MAX_NOTES_BYTES) {
    notes.shift();
  }
  if (notes.length === 1) {
    const original = notes[0].text;
    let text = original;
    while (text.length > 0 && Buffer.byteLength(JSON.stringify([{ ...notes[0], text }]), "utf8") > MAX_NOTES_BYTES) {
      text = text.slice(0, -100);
    }
    notes[0].text = text === original ? original : text + "…[truncated]";
  }
  return notes;
}

function normalizeWake(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    mode: source.mode === "resolved" ? "resolved" : "live",
    messageId: text(source.messageId),
    attemptedAt: nullableText(source.attemptedAt),
    settled: source.settled === true,
    error: nullableText(source.error),
  };
}

export function normalizeRecord(input = {}) {
  return {
    schemaVersion: 1,
    dispatchId: text(input.dispatchId),
    dedupeKey: text(input.dedupeKey),
    taskId: text(input.taskId),
    title: text(input.title),
    priority: text(input.priority),
    deadline: text(input.deadline),
    ackBy: text(input.ackBy),
    issuerSessionId: text(input.issuerSessionId),
    issuerEmployeeId: text(input.issuerEmployeeId),
    issuerName: text(input.issuerName),
    targetSessionId: text(input.targetSessionId),
    targetEmployeeId: text(input.targetEmployeeId),
    targetName: text(input.targetName),
    department: text(input.department),
    briefPath: text(input.briefPath),
    acceptance: text(input.acceptance),
    status: text(input.status),
    deliveredAt: nullableText(input.deliveredAt),
    ackedAt: nullableText(input.ackedAt),
    updatedAt: text(input.updatedAt),
    evidencePath: nullableText(input.evidencePath),
    eta: nullableText(input.eta),
    notes: normalizeNotes(input.notes),
    wake: normalizeWake(input.wake),
  };
}

export function assertRecord(record) {
  if (!record || typeof record !== "object") {
    throw new DispatchError(ERROR_CODES.INTERNAL_ERROR, "台账记录结构不合法");
  }
  if (!record.dispatchId || !record.taskId || !record.targetSessionId) {
    throw new DispatchError(ERROR_CODES.INTERNAL_ERROR, "台账记录缺少关键字段");
  }
  if (!STATUSES.has(record.status)) {
    throw new DispatchError(ERROR_CODES.INTERNAL_ERROR, "台账记录状态不合法");
  }
  if (!PRIORITIES.has(record.priority)) {
    throw new DispatchError(ERROR_CODES.INTERNAL_ERROR, "台账记录优先级不合法");
  }
  if (!Array.isArray(record.notes)) {
    throw new DispatchError(ERROR_CODES.INTERNAL_ERROR, "台账记录 notes 不合法");
  }
  return true;
}

function indexEntry(record) {
  return {
    taskId: record.taskId,
    targetSessionId: record.targetSessionId,
    status: record.status,
    department: record.department,
    issuerSessionId: record.issuerSessionId,
    deliveredAt: record.deliveredAt,
    ackedAt: record.ackedAt,
    deadline: record.deadline,
    ackBy: record.ackBy,
    updatedAt: record.updatedAt,
    evidencePath: record.evidencePath,
  };
}

function lineHash(line) {
  return createHash("sha1").update(line).digest("hex");
}

export class DispatchStore {
  constructor(options = {}) {
    this.baseDir = options.baseDir;
    this.jsonlPath = join(this.baseDir, "dispatches.jsonl");
    this.indexPath = join(this.baseDir, "index.json");
    this.corruptPath = join(this.baseDir, "dispatches.corrupt.jsonl");
    this.logger = options.logger;
    this.maxLineBytes = Math.min(MAX_LINE_BYTES, Number(options.maxLineBytes) || MAX_LINE_BYTES);
    this.latest = new Map();
    this.seq = 0;
    this.queue = Promise.resolve();
    this.initPromise = null;
    this.corruptHashes = new Set();
  }

  async init() {
    if (!this.initPromise) this.initPromise = this.#initialize();
    return this.initPromise;
  }

  async #initialize() {
    await mkdir(this.baseDir, { recursive: true });
    await this.#readCorruptHashes();
    return this.#rebuild();
  }

  #enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #readCorruptHashes() {
    if (!existsSync(this.corruptPath)) return;
    try {
      const content = await readFile(this.corruptPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (!line) continue;
        this.corruptHashes.add(lineHash(line));
      }
    } catch {
      this.corruptHashes = new Set();
    }
  }

  async #rebuild() {
    this.latest = new Map();
    this.seq = 0;
    if (!existsSync(this.jsonlPath)) {
      await this.#writeIndex();
      return { valid: 0, corrupt: 0 };
    }
    const content = await readFile(this.jsonlPath, "utf8");
    const lines = content.split(/\r?\n/);
    let valid = 0;
    let corrupt = 0;
    const corruptLines = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      this.seq += 1;
      try {
        const parsed = JSON.parse(line);
        assertRecord(parsed);
        const record = normalizeRecord(parsed);
        this.latest.set(record.dispatchId, record);
        valid += 1;
      } catch {
        corrupt += 1;
        const hash = lineHash(line);
        if (!this.corruptHashes.has(hash)) {
          this.corruptHashes.add(hash);
          corruptLines.push(line);
        }
        this.logger?.warn?.("task-dispatch: corrupt-ledger-line", {
          line: index + 1,
          code: "corrupt-line",
        });
      }
    }
    if (corruptLines.length) {
      await appendFile(this.corruptPath, `${corruptLines.join("\n")}\n`, "utf8");
    }
    await this.#writeIndex();
    return { valid, corrupt };
  }

  async #writeIndex() {
    const dispatches = {};
    const byTask = {};
    const byDedupeKey = {};
    const byDepartment = {};
    for (const [dispatchId, record] of this.latest) {
      dispatches[dispatchId] = indexEntry(record);
      if (!byTask[record.taskId]) byTask[record.taskId] = [];
      byTask[record.taskId].push(dispatchId);
      byDedupeKey[record.dedupeKey] = dispatchId;
      if (!byDepartment[record.department]) byDepartment[record.department] = [];
      byDepartment[record.department].push(dispatchId);
    }
    const body = JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: nowIso(),
        seq: this.seq,
        dispatches,
        byTask,
        byDedupeKey,
        byDepartment,
      },
      null,
      2,
    );
    const temp = `${this.indexPath}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
    await writeFile(temp, `${body}\n`, "utf8");
    try {
      await rename(temp, this.indexPath);
    } catch {
      await rm(this.indexPath, { force: true });
      await rename(temp, this.indexPath);
    }
  }

  async #appendLine(record) {
    assertRecord(record);
    const normalized = normalizeRecord(record);
    const line = JSON.stringify(normalized);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxLineBytes) {
      throw new DispatchError(ERROR_CODES.PAYLOAD_TOO_LARGE, "单条台账记录超过 8KB 上限");
    }
    await appendFile(this.jsonlPath, `${line}\n`, "utf8");
    this.latest.set(normalized.dispatchId, normalized);
    this.seq += 1;
    return normalized;
  }

  async append(record) {
    await this.init();
    return this.#enqueue(async () => {
      const normalized = await this.#appendLine(record);
      await this.#writeIndex();
      return normalized;
    });
  }

  async update(dispatchId, patch = {}) {
    await this.init();
    return this.#enqueue(async () => {
      const current = this.latest.get(dispatchId);
      if (!current) throw new DispatchError(ERROR_CODES.UNKNOWN_DISPATCH, "派工记录不存在");
      const next = normalizeRecord({ ...current, ...patch, dispatchId });
      const normalized = await this.#appendLine(next);
      await this.#writeIndex();
      return normalized;
    });
  }

  findByTaskId(taskId) {
    let found = null;
    for (const record of this.latest.values()) {
      if (record.taskId !== taskId) continue;
      if (!found || record.updatedAt >= found.updatedAt) found = record;
    }
    return found;
  }

  findByDedupeKey(dedupeKey) {
    for (const record of this.latest.values()) {
      if (record.dedupeKey === dedupeKey) return record;
    }
    return null;
  }

  getByDispatchId(dispatchId) {
    return this.latest.get(dispatchId) ?? null;
  }

  query(filter = {}) {
    let items = Array.from(this.latest.values());
    if (filter.dispatchId) items = items.filter((record) => record.dispatchId === filter.dispatchId);
    if (filter.taskId) items = items.filter((record) => record.taskId === filter.taskId);
    if (filter.department) items = items.filter((record) => record.department === filter.department);
    items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return items;
  }

  count() {
    return this.latest.size;
  }

  paths() {
    return {
      jsonl: this.jsonlPath,
      index: this.indexPath,
      corrupt: this.corruptPath,
    };
  }

  async rebuild() {
    await this.init();
    return this.#enqueue(() => this.#rebuild());
  }

  async close() {
    try {
      await this.init();
    } catch {
      // A failed init has no pending writes to drain.
    }
    await this.queue;
  }
}
