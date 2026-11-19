/**
 * 花名册：工号 → 会话 / 部门 / 角色 / 启用状态。
 * 白名单只来自 config.json，本模块不参与授权。
 */

import { existsSync, readFileSync } from "node:fs";

import { DispatchError, ERROR_CODES } from "./errors.js";

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeRoster(input) {
  const source = input && typeof input === "object" ? input : {};
  const list = Array.isArray(source.employees) ? source.employees : [];
  const employees = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const employeeId = clean(item.employeeId);
    const sessionId = clean(item.sessionId);
    if (!employeeId || !sessionId || seen.has(employeeId)) continue;
    seen.add(employeeId);
    employees.push({
      employeeId,
      name: clean(item.name) || employeeId,
      department: clean(item.department) || "未分组",
      sessionId,
      roles: Array.isArray(item.roles) ? item.roles.filter((role) => typeof role === "string") : [],
      enabled: item.enabled !== false,
    });
  }
  return { version: 1, employees };
}

export function loadRoster(config) {
  const path = config?.rosterPath;
  if (!path || !existsSync(path)) return normalizeRoster({ employees: [] });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new DispatchError(ERROR_CODES.INTERNAL_ERROR, "花名册不是合法 JSON");
  }
  return normalizeRoster(parsed);
}

export class Roster {
  constructor(input) {
    const normalized = normalizeRoster(input);
    this.employees = normalized.employees;
    this.byEmployeeId = new Map();
    this.bySessionId = new Map();
    for (const employee of this.employees) {
      this.byEmployeeId.set(employee.employeeId, employee);
      this.bySessionId.set(employee.sessionId, employee);
    }
  }

  getByEmployeeId(employeeId) {
    return this.byEmployeeId.get(employeeId) ?? null;
  }

  getBySessionId(sessionId) {
    return this.bySessionId.get(sessionId) ?? null;
  }

  requireEnabled(employeeId) {
    const employee = this.getByEmployeeId(employeeId);
    if (!employee) throw new DispatchError(ERROR_CODES.UNKNOWN_EMPLOYEE, "工号未登记");
    if (employee.enabled !== true) throw new DispatchError(ERROR_CODES.EMPLOYEE_DISABLED, "员工已停用");
    return employee;
  }
}

export function loadRosterIndex(config) {
  return new Roster(loadRoster(config));
}

/**
 * 顶层会话判定：子会话、subagent、delegationDepth>0 均不是顶层。
 */
export function isTopLevelHeader(header) {
  if (!header || typeof header !== "object") return false;
  return (
    !header.parentSession &&
    header.origin !== "subagent" &&
    !(Number(header.delegationDepth ?? 0) > 0)
  );
}

/**
 * 从宿主 workspaceRegistry 读取 archivedSessionIds；兼容 Set/Array/函数。
 */
export function archivedSessionSet(ctx) {
  try {
    const registry = ctx?.get?.("workspaceRegistry");
    let ids = registry?.archivedSessionIds;
    if (typeof ids === "function") ids = ids();
    if (ids instanceof Set) return ids;
    if (Array.isArray(ids)) return new Set(ids.filter((id) => typeof id === "string"));
  } catch {
    return new Set();
  }
  return new Set();
}

