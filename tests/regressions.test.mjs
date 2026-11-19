/**
 * 0.1.1 G2 整改测试：F8 BOM 兼容、F3 notes 8KB 上限。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeHarness } from "./helpers/harness.mjs";
import { loadConfig } from "../lib/config.js";
import { loadRoster } from "../lib/roster.js";
import { nowMs } from "../lib/time.js";

async function withHarness(t) {
  const harness = await makeHarness();
  t.after(() => harness.cleanup());
  return harness;
}

test("T-FIX-01 UTF-8 BOM 的 config/roster 可加载", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-bom-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "dsh-home");
  const dataDir = join(home, "task-dispatch");
  await mkdir(dataDir, { recursive: true });
  const config = { version: 1, timeZone: "Asia/Shanghai", rosterPath: "roster.json" };
  const roster = {
    version: 1,
    employees: [{ employeeId: "R-101", name: "鱼图", department: "研发部", sessionId: "session-x", roles: ["部长"], enabled: true }],
  };
  await writeFile(join(dataDir, "config.json"), "\uFEFF" + JSON.stringify(config, null, 2), "utf8");
  await writeFile(join(dataDir, "roster.json"), "\uFEFF" + JSON.stringify(roster, null, 2), "utf8");

  const cfg = loadConfig({ home });
  assert.equal(cfg.timeZone, "Asia/Shanghai");
  const loaded = loadRoster(cfg);
  assert.equal(loaded.employees.length, 1);
  assert.equal(loaded.employees[0].employeeId, "R-101");
});

test("T-FIX-02 长 note 累积后单行不超 8KB，任务仍可更新", async (t) => {
  const h = await withHarness(t);
  await h.call("dispatch_task", h.dispatchArgs());
  await h.call("ack_task", { taskId: "TSK-20261119-01", ack: true }, "session-target-1");
  const longNote = "长备注".repeat(600); // 1800 字符
  for (let i = 0; i < 10; i += 1) {
    const result = await h.call(
      "report_task",
      { taskId: "TSK-20261119-01", status: "进行中", note: longNote + i },
      "session-target-1",
    );
    assert.equal(result.ok, true);
  }
  const raw = await h.readRawJsonl();
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 8192, "单行台账不应超过 8KB");
  }
  const record = h.runtime.store.findByTaskId("TSK-20261119-01");
  assert.ok(record.notes.length >= 1);
  assert.ok(Buffer.byteLength(JSON.stringify(record.notes), "utf8") <= 4096, "notes 总量应被裁剪");
});

test("T-FIX-03 ctx.now 在非请求作用域抛错时 nowMs 回退进程时钟", () => {
  const throwingGetter = {
    get now() {
      throw new Error("outside request scope");
    },
  };
  const throwingFunction = {
    now() {
      throw new Error("outside request scope");
    },
  };
  for (const ctx of [throwingGetter, throwingFunction]) {
    const ms = nowMs(ctx);
    assert.ok(Number.isFinite(ms));
    assert.ok(Math.abs(ms - Date.now()) < 5000);
  }
});
