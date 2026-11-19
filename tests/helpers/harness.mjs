/**
 * 测试替身：真插件 apply 到假 ctx；临时 DSH_HOME；stub sessionQuery/agents。
 * 不联网、不写真实 %DSH_HOME%、不依赖真 DSH 进程。
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../../index.js";

const BASE_TIME = Date.parse("2026-11-19T12:00:00+08:00");

export async function makeHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-task-dispatch-test-"));
  const home = join(root, "dsh-home");
  const dataDir = join(home, "task-dispatch");
  const taskRoot = join(root, "tasks");
  const evidenceRoot = join(root, "evidence");
  await mkdir(dataDir, { recursive: true });
  await mkdir(taskRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });

  const briefPath = join(taskRoot, "brief.md");
  await writeFile(briefPath, "# brief\n", "utf8");

  let current = BASE_TIME;
  let followupFailure = false;
  const followups = [];
  const agentObjects = new Map();
  const liveAgents = new Map();

  const makeAgent = (sessionId) => {
    const agent = {
      id: sessionId,
      async followup(message) {
        if (followupFailure) throw new Error("stub-followup-failed");
        followups.push({ sessionId, message });
      },
    };
    agentObjects.set(sessionId, agent);
    liveAgents.set(sessionId, agent);
    return agent;
  };

  const sessions = [
    { id: "session-issuer", parentSession: null, origin: "agent", delegationDepth: 0 },
    { id: "session-assistant", parentSession: null, origin: "agent", delegationDepth: 0 },
    { id: "session-quality", parentSession: null, origin: "agent", delegationDepth: 0 },
    { id: "session-target-1", parentSession: null, origin: "agent", delegationDepth: 0 },
    { id: "session-target-2", parentSession: null, origin: "agent", delegationDepth: 0 },
    { id: "session-target-3", parentSession: null, origin: "agent", delegationDepth: 0 },
    { id: "session-target-disabled", parentSession: null, origin: "agent", delegationDepth: 0 },
    { id: "session-target-sub", parentSession: "session-target-1", origin: "subagent", delegationDepth: 1 },
    { id: "session-target-archived", parentSession: null, origin: "agent", delegationDepth: 0 },
  ];

  for (const id of ["session-target-1", "session-target-2", "session-target-3"]) makeAgent(id);

  const roster = {
    version: 1,
    employees: [
      { employeeId: "R-101", name: "鱼图", department: "研发部", sessionId: "session-target-1", roles: ["部长"], enabled: true },
      { employeeId: "R-102", name: "鱼码", department: "产品部", sessionId: "session-target-2", roles: ["部长"], enabled: true },
      { employeeId: "R-103", name: "鱼测", department: "测试部", sessionId: "session-target-3", roles: ["部长"], enabled: true },
      { employeeId: "R-104", name: "鱼停", department: "研发部", sessionId: "session-target-disabled", roles: ["部长"], enabled: false },
      { employeeId: "R-105", name: "鱼子", department: "研发部", sessionId: "session-target-sub", roles: ["部长"], enabled: true },
      { employeeId: "R-106", name: "鱼档", department: "研发部", sessionId: "session-target-archived", roles: ["部长"], enabled: true },
    ],
  };

  const config = {
    version: 1,
    timeZone: "Asia/Shanghai",
    maxPayloadBytes: 102400,
    whitelist: [
      { sessionId: "session-issuer", employeeId: "C-001", name: "鱼书", kind: "issuer" },
      { sessionId: "session-assistant", employeeId: "C-002", name: "调度助理", kind: "assistant" },
      { sessionId: "session-quality", employeeId: "Q-401", name: "质控", kind: "quality" },
    ],
    rosterPath: "roster.json",
    taskRoots: [taskRoot],
    evidenceRoots: [evidenceRoot],
    mirror: {
      enabled: options.mirrorEnabled === true,
      path: options.mirrorPath ?? join(dataDir, "ledger.md"),
    },
    wake: { timeoutMs: options.wakeTimeoutMs ?? 200 },
    ...(options.config ?? {}),
  };
  await writeFile(join(dataDir, "config.json"), JSON.stringify(config, null, 2), "utf8");
  await writeFile(join(dataDir, "roster.json"), JSON.stringify(options.roster ?? roster, null, 2), "utf8");

  const archived = new Set(options.archived ?? ["session-target-archived"]);
  const tools = new Map();
  const effects = [];
  const ctx = {
    now: () => current,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(name) {
      if (name === "workspaceRegistry") return { archivedSessionIds: archived };
      if (name === "sessionController") {
        return {
          async resolveAgent(sessionId) {
            const agent = agentObjects.get(sessionId);
            return agent ? { agent } : null;
          },
        };
      }
      if (name === "logger") return logger;
      return undefined;
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === "function") effects.push(disposer);
    },
    sessionQuery: {
      async listSessions() {
        return sessions.map((header) => ({ header }));
      },
      async readTitleSnapshots(ids = []) {
        return ids.map((sessionId) => ({
          status: "fulfilled",
          sessionId,
          value: { title: { title: `测试会话 ${sessionId}` } },
        }));
      },
    },
    agents: {
      get(sessionId) {
        return liveAgents.get(sessionId);
      },
    },
  };

  const logger = { warnings: [], errors: [], warn(code, detail) { this.warnings.push({ code, detail }); }, error(code, detail) { this.errors.push({ code, detail }); } };

  if (options.resolvedTarget) liveAgents.delete("session-target-1");

  const applied = apply(ctx, { home, ...(options.pluginConfig ?? {}) });

  async function call(toolName, args, caller = "session-issuer") {
    const tool = tools.get(toolName);
    if (!tool) throw new Error(`tool not registered: ${toolName}`);
    return tool.execute(args, caller ? { agent: { id: caller } } : {});
  }

  async function readRawJsonl() {
    try {
      return await readFile(join(dataDir, "dispatches.jsonl"), "utf8");
    } catch {
      return "";
    }
  }

  async function readJsonl() {
    const text = await readRawJsonl();
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }

  async function readIndex() {
    return JSON.parse(await readFile(join(dataDir, "index.json"), "utf8"));
  }

  function dispatchArgs(overrides = {}) {
    return {
      to: "R-101",
      taskId: "TSK-20261119-01",
      title: "实现样例任务",
      priority: "P1",
      deadline: "2026-11-20T18:00:00+08:00",
      briefPath,
      acceptance: "单测全绿",
      ...overrides,
    };
  }

  function advance(ms) {
    current += ms;
  }

  function setFollowupFailure(value) {
    followupFailure = value === true;
  }

  async function cleanup() {
    for (const dispose of effects.splice(0)) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    try {
      await applied.runtime.store.close();
    } catch {
      // ignore
    }
    await rm(root, { recursive: true, force: true });
  }

  return {
    root,
    home,
    dataDir,
    taskRoot,
    evidenceRoot,
    briefPath,
    sessions,
    roster,
    archived,
    followups,
    liveAgents,
    agentObjects,
    logger,
    tools,
    ctx,
    runtime: applied.runtime,
    call,
    dispatchArgs,
    advance,
    setFollowupFailure,
    readRawJsonl,
    readJsonl,
    readIndex,
    cleanup,
    jsonlPath: join(dataDir, "dispatches.jsonl"),
    indexPath: join(dataDir, "index.json"),
    corruptPath: join(dataDir, "dispatches.corrupt.jsonl"),
  };
}

/**
 * 规格 §8 约定的测试替身入口别名。
 */
export async function makeCtx(options = {}) {
  return makeHarness(options);
}

