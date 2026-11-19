import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeHarness } from "./helpers/harness.mjs";
import { DispatchStore, RECORD_FIELDS } from "../lib/store.js";
import { formatShanghai, parseShanghaiTime } from "../lib/time.js";

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function withHarness(t, options = {}) {
  const harness = await makeHarness(options);
  t.after(() => harness.cleanup());
  return harness;
}

function uniqueDispatches(records) {
  return new Map(records.map((record) => [record.dispatchId, record]));
}

test("T-UNIT-01 四个工具注册，dispatch 写入台账并 fire-and-forget 唤醒", async (t) => {
  const h = await withHarness(t);
  assert.deepEqual([...h.tools.keys()].sort(), ["ack_task", "dispatch_status", "dispatch_task", "report_task"]);
  assert.ok(h.tools.get("dispatch_task").parameters.required.includes("to"));

  const result = await h.call("dispatch_task", h.dispatchArgs());
  assert.equal(result.ok, true);
  assert.match(result.dispatchId, /^dsp_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(result.status, "delivered");
  assert.equal(result.duplicate, false);
  assert.equal(result.wake.attempted, true);
  assert.equal(result.wake.mode, "live");
  assert.equal(result.wake.settled, true);

  assert.equal(h.followups.length, 1);
  const message = h.followups[0].message;
  assert.equal(message.source.kind, "agent-message");
  assert.equal(message.source.form, "relay");
  assert.equal(message.source.busMessageId, result.dispatchId);
  assert.equal(message.source.threadId, result.dispatchId);
  assert.equal(message.source.hop, 0);
  assert.equal(message.source.senderSessionId, "session-issuer");
  assert.match(message.content[0].text, /TSK-20261119-01/);
  assert.match(message.content[0].text, /ack_task/);
  assert.ok(!message.content[0].text.includes("# brief"));

  const record = h.runtime.store.findByTaskId("TSK-20261119-01");
  assert.equal(record.status, "delivered");
  assert.match(record.deliveredAt, /\+08:00$/);
  assert.equal(record.notes[0].kind, "system");
  assert.ok(record.wake.messageId);
});

test("T-UNIT-02 ackBy 缺省等于 deadline，服务端 dedupeKey 与目标解析正确", async (t) => {
  const h = await withHarness(t);
  const result = await h.call("dispatch_task", h.dispatchArgs());
  assert.equal(result.target.employeeId, "R-101");
  assert.equal(result.target.name, "鱼图");
  assert.equal(result.target.department, "研发部");
  assert.equal(result.target.sessionId, "session-target-1");
  assert.equal(result.dedupeKey, "TSK-20261119-01|session-target-1");

  const record = h.runtime.store.findByTaskId("TSK-20261119-01");
  assert.equal(record.ackBy, record.deadline);
  assert.equal(record.ackBy, "2026-11-20T18:00:00+08:00");
  assert.equal(record.schemaVersion, 1);
});

test("T-UNIT-03 相同 dedupeKey 重复派工只唤醒一次", async (t) => {
  const h = await withHarness(t);
  const first = await h.call("dispatch_task", h.dispatchArgs());
  const second = await h.call("dispatch_task", h.dispatchArgs());
  assert.equal(second.duplicate, true);
  assert.equal(second.dispatchId, first.dispatchId);
  assert.equal(second.wake.attempted, false);
  assert.equal(h.followups.length, 1);

  const records = await h.readJsonl();
  assert.equal(uniqueDispatches(records).size, 1);
  const index = await h.readIndex();
  assert.deepEqual(Object.keys(index.dispatches), [first.dispatchId]);
  assert.equal(index.byDedupeKey[first.dedupeKey], first.dispatchId);
});

test("T-UNIT-04 非白名单/质量只读角色派工被拒绝且不写台账", async (t) => {
  const h = await withHarness(t);
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs(), "session-target-1"),
    "unauthorized-issuer",
  );
  await expectCode(h.call("dispatch_task", h.dispatchArgs(), null), "unauthorized-caller");
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs(), "session-quality"),
    "unauthorized-issuer",
  );
  assert.equal(h.followups.length, 0);
  assert.equal(await h.readRawJsonl(), "");
});

test("T-UNIT-05 子会话与归档目标被拒绝且不唤醒", async (t) => {
  const h = await withHarness(t);
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ to: "R-105" })),
    "target-not-top-level",
  );
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ to: "R-106" })),
    "target-archived",
  );
  assert.equal(h.followups.length, 0);
  assert.equal(h.runtime.store.count(), 0);
});

test("T-UNIT-06 未登记/停用/裸 sessionId 目标被拒绝", async (t) => {
  const h = await withHarness(t);
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ to: "R-999" })),
    "unknown-employee",
  );
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ to: "R-104" })),
    "employee-disabled",
  );
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ to: "session-target-1" })),
    "invalid-argument",
  );
  assert.equal(h.followups.length, 0);
});

test("T-UNIT-07 非目标会话回执被拒绝，状态不变", async (t) => {
  const h = await withHarness(t);
  const dispatched = await h.call("dispatch_task", h.dispatchArgs());
  const before = await h.readRawJsonl();
  await expectCode(
    h.call("ack_task", { taskId: "TSK-20261119-01", ack: true }, "session-target-2"),
    "not-target",
  );
  await expectCode(
    h.call("ack_task", { taskId: "TSK-20261119-01", ack: true }, "session-quality"),
    "not-target",
  );
  assert.equal(h.runtime.store.findByTaskId("TSK-20261119-01").status, "delivered");
  assert.equal(h.runtime.store.findByTaskId("TSK-20261119-01").dispatchId, dispatched.dispatchId);
  assert.equal(await h.readRawJsonl(), before);
});

test("T-UNIT-08 同 taskId 换目标被拒绝（v0 无改派）", async (t) => {
  const h = await withHarness(t);
  const first = await h.call("dispatch_task", h.dispatchArgs());
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ to: "R-102" })),
    "task-id-target-conflict",
  );
  assert.equal(h.runtime.store.count(), 1);
  assert.equal(h.runtime.store.findByTaskId("TSK-20261119-01").dispatchId, first.dispatchId);
  assert.equal(h.followups.length, 1);
});

test("T-UNIT-09 重启后从 JSONL 重建 index，坏行隔离", async (t) => {
  const h = await withHarness(t);
  const dispatched = await h.call("dispatch_task", h.dispatchArgs());
  await h.call("ack_task", { taskId: "TSK-20261119-01", ack: true, note: "收到" }, "session-target-1");

  const store = new DispatchStore({ baseDir: h.dataDir });
  t.after(async () => {
    await store.close();
  });
  const rebuilt = await store.init();
  assert.equal(rebuilt.valid >= 2, true);
  assert.equal(store.count(), 1);
  assert.equal(store.findByTaskId("TSK-20261119-01").dispatchId, dispatched.dispatchId);

  const index = JSON.parse(await readFile(h.indexPath, "utf8"));
  assert.equal(index.seq >= 3, true);
  assert.equal(Object.keys(index.dispatches).length, 1);

  await writeFile(h.jsonlPath, `${await readFile(h.jsonlPath, "utf8")}{"broken":true}\n`, "utf8");
  const rebuiltStore = new DispatchStore({ baseDir: h.dataDir });
  t.after(async () => {
    await rebuiltStore.close();
  });
  const second = await rebuiltStore.init();
  assert.equal(second.corrupt, 1);
  assert.equal(rebuiltStore.count(), 1);
  assert.match(await readFile(h.corruptPath, "utf8"), /"broken":true/);
});

test("T-UNIT-10 到 ackBy/deadline 未完成派生 overdue 与 expired", async (t) => {
  const h = await withHarness(t);
  await h.call(
    "dispatch_task",
    h.dispatchArgs({
      deadline: "2026-11-19T13:00:00+08:00",
      ackBy: "2026-11-19T12:30:00+08:00",
    }),
  );
  h.advance(31 * 60 * 1000);
  let status = await h.call("dispatch_status", { taskId: "TSK-20261119-01" });
  assert.equal(status.count, 1);
  assert.equal(status.dispatches[0].ackOverdue, true);
  assert.equal(status.dispatches[0].deadlineOverdue, false);
  assert.equal(status.dispatches[0].derivedStatus, "delivered");
  assert.ok(status.dispatches[0].overdueSeconds > 0);

  h.advance(60 * 60 * 1000);
  status = await h.call("dispatch_status", { taskId: "TSK-20261119-01" });
  assert.equal(status.dispatches[0].ackOverdue, true);
  assert.equal(status.dispatches[0].deadlineOverdue, true);
  assert.equal(status.dispatches[0].derivedStatus, "expired");
  assert.equal(h.runtime.store.findByTaskId("TSK-20261119-01").status, "delivered");
});

test("T-UNIT-11 ack 后 status 立即可见", async (t) => {
  const h = await withHarness(t);
  await h.call("dispatch_task", h.dispatchArgs());
  const ack = await h.call(
    "ack_task",
    { taskId: "TSK-20261119-01", ack: true, note: "已收到", eta: "2026-11-20T10:00:00+08:00" },
    "session-target-1",
  );
  assert.equal(ack.ok, true);
  assert.equal(ack.status, "acked");
  assert.ok(ack.ackedAt);
  assert.equal(ack.eta, "2026-11-20T10:00:00+08:00");
  const duplicate = await h.call(
    "ack_task",
    { taskId: "TSK-20261119-01", ack: true },
    "session-target-1",
  );
  assert.equal(duplicate.duplicate, true);

  const status = await h.call("dispatch_status", { taskId: "TSK-20261119-01" });
  assert.equal(status.dispatches[0].status, "acked");
  assert.ok(status.dispatches[0].ackedAt);
});

test("T-UNIT-12 report 后总管可见状态与证据", async (t) => {
  const h = await withHarness(t);
  await h.call("dispatch_task", h.dispatchArgs());
  await h.call("ack_task", { taskId: "TSK-20261119-01", ack: true }, "session-target-1");

  const inProgress = await h.call(
    "report_task",
    { taskId: "TSK-20261119-01", status: "进行中", note: "开工" },
    "session-target-1",
  );
  assert.equal(inProgress.status, "in_progress");

  const proof = join(h.evidenceRoot, "proof.txt");
  await writeFile(proof, "proof\n", "utf8");
  const pending = await h.call(
    "report_task",
    { taskId: "TSK-20261119-01", status: "待验收", evidencePath: proof },
    "session-target-1",
  );
  assert.equal(pending.status, "pending_acceptance");
  const done = await h.call(
    "report_task",
    { taskId: "TSK-20261119-01", status: "完成", note: "验收通过" },
    "session-target-1",
  );
  assert.equal(done.status, "done");

  const status = await h.call("dispatch_status", { taskId: "TSK-20261119-01" });
  assert.equal(status.dispatches[0].status, "done");
  assert.equal(status.dispatches[0].evidencePath, proof);
  assert.equal(status.dispatches[0].lastNote, "验收通过");
  assert.equal(status.dispatches[0].derivedStatus, "done");
});

test("T-UNIT-13 JSONL 每行字段完整、顺序固定、可独立解析", async (t) => {
  const h = await withHarness(t);
  await h.call("dispatch_task", h.dispatchArgs());
  await h.call("ack_task", { taskId: "TSK-20261119-01", ack: true }, "session-target-1");
  await h.call(
    "report_task",
    { taskId: "TSK-20261119-01", status: "进行中" },
    "session-target-1",
  );
  const raw = await h.readRawJsonl();
  const lines = raw.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 8192);
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record), RECORD_FIELDS);
    assert.equal(record.schemaVersion, 1);
    assert.equal(typeof record.dispatchId, "string");
    assert.equal(typeof record.taskId, "string");
    assert.ok(["P0", "P1", "P2"].includes(record.priority));
    assert.ok(Array.isArray(record.notes));
    assert.ok(!Object.hasOwn(record, "stack"));
  }
  const statuses = new Set(lines.map((line) => JSON.parse(line).status));
  assert.equal(statuses.has("pending_wake"), true);
  assert.equal(statuses.has("delivered"), true);
  assert.equal(statuses.has("acked"), true);
  assert.equal(statuses.has("in_progress"), true);
});

test("T-UNIT-14 状态机非法迁移与重复相反操作", async (t) => {
  const h = await withHarness(t);
  await h.call("dispatch_task", h.dispatchArgs());
  await expectCode(
    h.call("report_task", { taskId: "TSK-20261119-01", status: "完成" }, "session-target-1"),
    "invalid-transition",
  );
  const rejected = await h.call(
    "ack_task",
    { taskId: "TSK-20261119-01", ack: false, note: "资源不足" },
    "session-target-1",
  );
  assert.equal(rejected.status, "rejected");
  const duplicate = await h.call(
    "ack_task",
    { taskId: "TSK-20261119-01", ack: false },
    "session-target-1",
  );
  assert.equal(duplicate.duplicate, true);
  await expectCode(
    h.call("ack_task", { taskId: "TSK-20261119-01", ack: true }, "session-target-1"),
    "invalid-transition",
  );
  await expectCode(
    h.call("report_task", { taskId: "TSK-20261119-01", status: "取消" }, "session-target-1"),
    "invalid-transition",
  );

  await h.call(
    "dispatch_task",
    h.dispatchArgs({ to: "R-102", taskId: "TSK-20261119-02" }),
  );
  await h.call(
    "ack_task",
    { taskId: "TSK-20261119-02", ack: true },
    "session-target-2",
  );
  await expectCode(
    h.call("report_task", { taskId: "TSK-20261119-02", status: "完成" }, "session-target-2"),
    "invalid-transition",
  );
  const pending = await h.call(
    "report_task",
    { taskId: "TSK-20261119-02", status: "进行中" },
    "session-target-2",
  );
  assert.equal(pending.status, "in_progress");
  const pendingAcceptance = await h.call(
    "report_task",
    { taskId: "TSK-20261119-02", status: "待验收" },
    "session-target-2",
  );
  assert.equal(pendingAcceptance.status, "pending_acceptance");
  const cancelled = await h.call(
    "report_task",
    { taskId: "TSK-20261119-02", status: "取消" },
    "session-target-2",
  );
  assert.equal(cancelled.status, "cancelled");
  await expectCode(
    h.call("report_task", { taskId: "TSK-20261119-02", status: "进行中" }, "session-target-2"),
    "invalid-transition",
  );
});

test("T-UNIT-15 简报/证据路径穿越与出根被拒绝", async (t) => {
  const h = await withHarness(t);
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ briefPath: "../escape.md" })),
    "brief-path-outside-root",
  );
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ briefPath: join(h.root, "outside.md") })),
    "brief-path-outside-root",
  );
  await expectCode(
    h.call("dispatch_task", h.dispatchArgs({ briefPath: join(h.taskRoot, "missing.md") })),
    "brief-file-missing",
  );

  await h.call("dispatch_task", h.dispatchArgs());
  await h.call("ack_task", { taskId: "TSK-20261119-01", ack: true }, "session-target-1");
  await expectCode(
    h.call(
      "report_task",
      { taskId: "TSK-20261119-01", status: "进行中", evidencePath: "../escape.txt" },
      "session-target-1",
    ),
    "evidence-path-outside-root",
  );
  await expectCode(
    h.call(
      "report_task",
      { taskId: "TSK-20261119-01", status: "进行中", evidencePath: join(h.root, "outside.txt") },
      "session-target-1",
    ),
    "evidence-path-outside-root",
  );
});

test("T-UNIT-16 并发同 dedupeKey 只产生一个 dispatchId 和一次唤醒", async (t) => {
  const h = await withHarness(t);
  const calls = Array.from({ length: 5 }, () => h.call("dispatch_task", h.dispatchArgs()));
  const results = await Promise.all(calls);
  const ids = new Set(results.map((result) => result.dispatchId));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((result) => result.duplicate === false).length, 1);
  assert.equal(results.filter((result) => result.duplicate === true).length, 4);
  assert.equal(h.followups.length, 1);
  assert.equal(h.runtime.store.count(), 1);
  const index = await h.readIndex();
  assert.equal(Object.keys(index.dispatches).length, 1);
});

test("T-UNIT-17 查询权限、空条件与分页校验", async (t) => {
  const h = await withHarness(t);
  await h.call("dispatch_task", h.dispatchArgs());
  await expectCode(
    h.call("dispatch_status", { taskId: "TSK-20261119-01" }, "session-target-1"),
    "unauthorized-viewer",
  );
  await expectCode(h.call("dispatch_status", {}), "invalid-query");
  await expectCode(
    h.call("dispatch_status", { taskId: "TSK-20261119-01", limit: 0 }),
    "invalid-limit",
  );
  await expectCode(
    h.call("dispatch_status", { dispatchId: "dsp_not-a-real-id" }),
    "unknown-dispatch",
  );

  const quality = await h.call("dispatch_status", { taskId: "TSK-20261119-01" }, "session-quality");
  assert.equal(quality.count, 1);
  const assistant = await h.call("dispatch_status", { taskId: "TSK-20261119-01" }, "session-assistant");
  assert.equal(assistant.count, 1);
  const department = await h.call("dispatch_status", { department: "研发部" });
  assert.equal(department.count, 1);
  const emptyDepartment = await h.call("dispatch_status", { department: "不存在部" });
  assert.equal(emptyDepartment.count, 0);
  assert.equal(emptyDepartment.truncated, false);
});

test("T-UNIT-18 唤醒失败记录 wake_failed，重派可重试并置 retried", async (t) => {
  const h = await withHarness(t);
  h.setFollowupFailure(true);
  await expectCode(h.call("dispatch_task", h.dispatchArgs()), "wake-failed");
  const failed = h.runtime.store.findByTaskId("TSK-20261119-01");
  assert.equal(failed.status, "wake_failed");
  assert.equal(failed.wake.error, "wake-failed");
  assert.equal(h.followups.length, 0);

  h.setFollowupFailure(false);
  const retried = await h.call("dispatch_task", h.dispatchArgs());
  assert.equal(retried.retried, true);
  assert.equal(retried.duplicate, true);
  assert.equal(retried.status, "delivered");
  assert.equal(retried.wake.attempted, true);
  assert.equal(h.followups.length, 1);
  assert.equal(h.runtime.store.count(), 1);
  assert.equal(h.runtime.store.findByTaskId("TSK-20261119-01").status, "delivered");
});

test("T-UNIT-19 Markdown 镜像 best-effort，不改变 JSONL 权威", async (t) => {
  const h = await withHarness(t, { mirrorEnabled: true });
  const result = await h.call("dispatch_task", h.dispatchArgs());
  const mirror = await readFile(join(h.dataDir, "ledger.md"), "utf8");
  assert.match(mirror, /任务派送台账/);
  assert.match(mirror, new RegExp(result.taskId));
  assert.equal(h.runtime.store.findByTaskId(result.taskId).status, "delivered");
});

test("T-MAN-01 模拟卸载：关闭插件后 JSONL 仍可独立解析", async (t) => {
  const h = await withHarness(t);
  const result = await h.call("dispatch_task", h.dispatchArgs());
  await h.call("ack_task", { taskId: result.taskId, ack: true }, "session-target-1");
  await h.runtime.store.close();
  const lines = (await readFile(h.jsonlPath, "utf8")).split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    const record = JSON.parse(line);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.dispatchId, result.dispatchId);
    assert.ok(record.status);
  }
});

test("T-UNIT-20 上海时区解析与 +08:00 输出", () => {
  assert.equal(
    parseShanghaiTime("2026-11-19 18:30", "deadline").iso,
    "2026-11-19T18:30:00+08:00",
  );
  assert.equal(
    formatShanghai(new Date("2026-11-19T10:30:00Z")),
    "2026-11-19T18:30:00+08:00",
  );
  assert.throws(() => parseShanghaiTime("2026-02-30 10:00", "deadline"), (error) => {
    return error.code === "invalid-argument";
  });
  assert.throws(() => parseShanghaiTime("2026-02-30T10:00:00+08:00", "deadline"), (error) => {
    return error.code === "invalid-argument";
  });
});
