/**
 * dsh-task-dispatch host half.
 *
 * 4 个 Agent 工具、零第三方运行时依赖、Python/网络/客户端半均不需要。
 * 台账在 %DSH_HOME%/task-dispatch/ 下；测试通过注入临时 DSH_HOME 隔离。
 */

import { DispatchError, ERROR_CODES } from "./lib/errors.js";
import { loadConfig } from "./lib/config.js";
import { loadRosterIndex } from "./lib/roster.js";
import { DispatchStore } from "./lib/store.js";
import { dispatchTask } from "./lib/dispatch.js";
import { ackTask, reportTask } from "./lib/lifecycle.js";
import { dispatchStatus } from "./lib/status.js";

export const name = "task-dispatch";
export const inject = ["tools", "sessionQuery", "agents", "sessionController"];

const DISPATCH_DESCRIPTION =
  "把任务指针 fire-and-forget 派给白名单在册的顶层部长会话，立即返回 dispatchId；不等待目标完成一轮。仅总管/调度助理可派工。";
const ACK_DESCRIPTION =
  "目标部长确认或拒绝派工回执。只有该派工目标会话可调用；返回 ack 状态与时间。";
const REPORT_DESCRIPTION =
  "目标部长报告任务进度（进行中/阻塞/待验收/完成/取消）并可附证据路径。";
const STATUS_DESCRIPTION =
  "按 taskId、dispatchId 或 department 查询派工状态与超期派生；至少给一个过滤条件。质量只读角色也可查询。";

const dispatchParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    to: { type: "string", pattern: "^[A-Z]-[0-9]{3}$" },
    taskId: { type: "string", pattern: "^TSK-[0-9]{8}-[0-9]{2}$" },
    title: { type: "string", minLength: 1, maxLength: 200 },
    priority: { enum: ["P0", "P1", "P2"] },
    deadline: { type: "string", format: "date-time" },
    briefPath: { type: "string", minLength: 1, maxLength: 512 },
    acceptance: { type: "string", minLength: 1, maxLength: 2000 },
    ackBy: { type: "string", format: "date-time" },
    dedupeKey: { type: "string", maxLength: 300 },
  },
  required: ["to", "taskId", "title", "priority", "deadline", "briefPath", "acceptance"],
};

const ackParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    ack: { type: "boolean" },
    note: { type: "string", maxLength: 2000 },
    eta: { type: "string", format: "date-time" },
  },
  required: ["taskId", "ack"],
};

const reportParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    status: { enum: ["进行中", "阻塞", "待验收", "完成", "取消"] },
    evidencePath: { type: "string", maxLength: 512 },
    note: { type: "string", maxLength: 2000 },
  },
  required: ["taskId", "status"],
};

const statusParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    dispatchId: { type: "string" },
    department: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  },
};

function output(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

const objectOutput = output({ type: "object", additionalProperties: true });

function normalizeFailure(error, runtime) {
  if (error instanceof DispatchError) return error;
  try {
    runtime.logger?.error?.("task-dispatch: internal-error", { code: ERROR_CODES.INTERNAL_ERROR });
  } catch {
    // logger is optional
  }
  return new DispatchError(ERROR_CODES.INTERNAL_ERROR, "内部错误");
}

function makeRuntime(ctx, config) {
  const source = config && typeof config === "object" ? config : {};
  const { home, baseDir, ...overrides } = source;
  const resolved = loadConfig({ overrides, home, baseDir });
  const logger = ctx?.logger ?? (typeof ctx?.get === "function" ? ctx.get("logger") : undefined);
  const runtime = {
    ctx,
    config: resolved,
    logger,
    roster: loadRosterIndex(resolved),
    whitelistBySession: new Map(resolved.whitelist.map((entry) => [entry.sessionId, entry])),
    store: new DispatchStore({ baseDir: resolved.baseDir, logger }),
    taskLocks: new Map(),
  };
  runtime.ready = runtime.store.init();
  runtime.ready.catch(() => undefined);
  return runtime;
}

export function apply(ctx, config = {}) {
  if (!ctx?.tools || typeof ctx.tools.register !== "function") {
    throw new Error("task-dispatch requires tools service");
  }
  const runtime = makeRuntime(ctx, config);
  const disposers = [];

  const register = (definition, handler) => {
    disposers.push(
      ctx.tools.register({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: objectOutput,
        async execute(args, exec) {
          try {
            await runtime.ready;
            return await handler(args, exec);
          } catch (error) {
            throw normalizeFailure(error, runtime);
          }
        },
      }),
    );
  };

  register(
    { name: "dispatch_task", description: DISPATCH_DESCRIPTION, parameters: dispatchParameters },
    (args, exec) => dispatchTask(ctx, runtime, args, exec),
  );
  register(
    { name: "ack_task", description: ACK_DESCRIPTION, parameters: ackParameters },
    (args, exec) => ackTask(ctx, runtime, args, exec),
  );
  register(
    { name: "report_task", description: REPORT_DESCRIPTION, parameters: reportParameters },
    (args, exec) => reportTask(ctx, runtime, args, exec),
  );
  register(
    { name: "dispatch_status", description: STATUS_DESCRIPTION, parameters: statusParameters },
    (args, exec) => dispatchStatus(ctx, runtime, args, exec),
  );

  try {
    ctx.effect?.(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          // ignore dispose noise
        }
      }
      void runtime.store.close();
    });
  } catch {
    // effect is optional in a few test doubles
  }

  return { name, runtime };
}

export const __test = {
  dispatchParameters,
  ackParameters,
  reportParameters,
  statusParameters,
};
