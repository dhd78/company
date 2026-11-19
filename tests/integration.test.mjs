/**
 * 可选集成用例。默认 skip；只在显式 DSH_DISPATCH_INTEGRATION=1 时运行。
 * 这些用例仍使用假 ctx，不联网、不连接真实 DSH；真实实例冒烟由 WS-PL-03 执行。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { makeHarness } from "./helpers/harness.mjs";

const ENABLED = process.env.DSH_DISPATCH_INTEGRATION === "1";
const skip = ENABLED ? false : "set DSH_DISPATCH_INTEGRATION=1 to run";

test("T-INT-01 非活跃顶层会话唤醒后 dispatch 1s 内返回", { skip }, async (t) => {
  const h = await makeHarness({ resolvedTarget: true });
  t.after(() => h.cleanup());
  const started = Date.now();
  const result = await h.call("dispatch_task", h.dispatchArgs());
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `dispatch took ${elapsed}ms`);
  assert.equal(result.wake.mode, "resolved");
  assert.equal(h.followups.length, 1);
  const message = h.followups[0].message;
  assert.equal(message.source.kind, "agent-message");
  assert.match(message.content[0].text, /TSK-20261119-01/);
});

test("T-INT-02 连续 3 目标互不阻塞，单次写台账 <50ms", { skip }, async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const targets = ["R-101", "R-102", "R-103"];
  const durations = [];
  for (let index = 0; index < targets.length; index += 1) {
    const started = Date.now();
    const result = await h.call(
      "dispatch_task",
      h.dispatchArgs({
        to: targets[index],
        taskId: `TSK-20261119-${String(index + 1).padStart(2, "0")}`,
      }),
    );
    durations.push(Date.now() - started);
    assert.equal(result.status, "delivered");
  }
  assert.equal(h.followups.length, 3);
  assert.equal(h.runtime.store.count(), 3);
  for (const duration of durations) assert.ok(duration < 50, `write took ${duration}ms`);
});

test("T-INT-03 dedupeKey 不重复唤醒", { skip }, async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const first = await h.call("dispatch_task", h.dispatchArgs());
  const second = await h.call("dispatch_task", h.dispatchArgs());
  assert.equal(second.duplicate, true);
  assert.equal(second.dispatchId, first.dispatchId);
  assert.equal(h.followups.length, 1);
  assert.equal(h.runtime.store.count(), 1);
});
