/**
 * 配置加载与归一化。
 *
 * 权威配置：%DSH_HOME%/task-dispatch/config.json。
 * apply(config) 可以作为测试/测试 profile 的显式覆盖；文件优先于代码默认值。
 * 本模块不创建任何目录，不写生产数据。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { DispatchError, ERROR_CODES } from "./errors.js";

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  timeZone: "Asia/Shanghai",
  maxPayloadBytes: 102400,
  whitelist: [],
  rosterPath: "roster.json",
  taskRoots: [],
  evidenceRoots: [],
  mirror: { enabled: false, path: "task-ledger.md" },
  wake: { timeoutMs: 2000 },
});

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    throw new DispatchError(ERROR_CODES.INTERNAL_ERROR, "配置文件不是合法 JSON");
  }
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePath(value, baseDir) {
  const text = asString(value);
  if (!text) return "";
  return isAbsolute(text) ? resolve(text) : resolve(baseDir, text);
}

function normalizeRoots(value, baseDir) {
  const list = Array.isArray(value) ? value : [];
  const roots = [];
  for (const item of list) {
    const path = normalizePath(item, baseDir);
    if (path && !roots.includes(path)) roots.push(path);
  }
  return roots;
}

function normalizeWhitelist(value) {
  const list = Array.isArray(value) ? value : [];
  const entries = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const sessionId = asString(item.sessionId);
    const employeeId = asString(item.employeeId);
    const kind = asString(item.kind);
    if (!sessionId || !employeeId || !["issuer", "assistant", "quality"].includes(kind)) continue;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    entries.push({
      sessionId,
      employeeId,
      name: asString(item.name) || employeeId,
      kind,
    });
  }
  return entries;
}

function normalizeMaxPayload(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1024) return DEFAULT_CONFIG.maxPayloadBytes;
  return Math.min(102400, Math.floor(number));
}

function normalizeWake(value) {
  const source = value && typeof value === "object" ? value : {};
  const number = Number(source.timeoutMs);
  const timeoutMs = Number.isFinite(number) && number >= 100 ? Math.min(30000, Math.floor(number)) : 2000;
  return { timeoutMs };
}

function normalizeMirror(value, baseDir) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    path: normalizePath(source.path, baseDir) || join(baseDir, "task-ledger.md"),
  };
}

export function resolveDshHome(env = process.env) {
  const configured = asString(env.DSH_HOME);
  if (configured) return configured;
  const userHome = asString(env.USERPROFILE) || asString(env.HOME) || process.cwd();
  return join(userHome, ".dsh");
}

export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const home = resolve(options.home || resolveDshHome(env));
  const baseDir = resolve(options.baseDir || join(home, "task-dispatch"));
  const configFile = join(baseDir, "config.json");
  const fileConfig = readJson(configFile) ?? {};
  const overrides = options.overrides && typeof options.overrides === "object" ? options.overrides : {};
  const merged = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...overrides,
    mirror: {
      ...DEFAULT_CONFIG.mirror,
      ...(fileConfig.mirror && typeof fileConfig.mirror === "object" ? fileConfig.mirror : {}),
      ...(overrides.mirror && typeof overrides.mirror === "object" ? overrides.mirror : {}),
    },
    wake: {
      ...DEFAULT_CONFIG.wake,
      ...(fileConfig.wake && typeof fileConfig.wake === "object" ? fileConfig.wake : {}),
      ...(overrides.wake && typeof overrides.wake === "object" ? overrides.wake : {}),
    },
  };

  const timeZone = asString(merged.timeZone) || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone }).format(new Date());
  } catch {
    throw new DispatchError(ERROR_CODES.INVALID_ARGUMENT, "timeZone 不是有效时区");
  }
  if (timeZone !== "Asia/Shanghai") {
    throw new DispatchError(ERROR_CODES.INVALID_ARGUMENT, "v0 仅支持 Asia/Shanghai");
  }

  const rosterText = asString(merged.rosterPath) || "roster.json";
  const rosterPath = isAbsolute(rosterText) ? resolve(rosterText) : resolve(baseDir, rosterText);
  const taskRoots = normalizeRoots(merged.taskRoots, baseDir);
  const evidenceRoots = normalizeRoots(merged.evidenceRoots, baseDir);

  return {
    version: 1,
    timeZone,
    home,
    baseDir,
    configFile,
    maxPayloadBytes: normalizeMaxPayload(merged.maxPayloadBytes),
    whitelist: normalizeWhitelist(merged.whitelist),
    rosterPath,
    taskRoots: taskRoots.length ? taskRoots : [baseDir],
    evidenceRoots: evidenceRoots.length ? evidenceRoots : [baseDir],
    mirror: normalizeMirror(merged.mirror, baseDir),
    wake: normalizeWake(merged.wake),
  };
}
