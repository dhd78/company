/**
 * 全链路使用 Asia/Shanghai（固定 UTC+08:00，无夏令时）。
 * 输出统一为带 +08:00 的 ISO-8601；输入另接受 "YYYY-MM-DD HH:mm"。
 */

import { invalidArgument } from "./errors.js";

const OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

export function formatShanghai(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw invalidArgument("时间不合法");
  const shifted = new Date(date.getTime() + OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`;
}

export function parseShanghaiTime(value, field = "时间") {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidArgument(`${field}必须是 ISO-8601 字符串`);
  }
  const text = value.trim();
  const match = DATE_TIME_RE.exec(text);
  if (!match) throw invalidArgument(`${field}格式不合法`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const millisecond = Number((match[7] ?? "0").padEnd(3, "0"));
  const zone = match[8];

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw invalidArgument(`${field}超出合法范围`);
  }

  let date;
  if (zone === undefined) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    date = new Date(wall - OFFSET_MS);
    const back = new Date(date.getTime() + OFFSET_MS);
    if (
      back.getUTCFullYear() !== year ||
      back.getUTCMonth() + 1 !== month ||
      back.getUTCDate() !== day ||
      back.getUTCHours() !== hour ||
      back.getUTCMinutes() !== minute
    ) {
      throw invalidArgument(`${field}不是有效日期时间`);
    }
  } else {
    const offsetText = zone === "Z" ? "+00:00" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    date = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(millisecond, 3)}${offsetText}`);
    if (Number.isNaN(date.getTime())) throw invalidArgument(`${field}不是有效日期时间`);
    const sign = offsetText.startsWith("-") ? -1 : 1;
    const [offsetHour, offsetMinute] = offsetText.slice(1).split(":").map(Number);
    const wall = new Date(date.getTime() + sign * (offsetHour * 60 + offsetMinute) * 60 * 1000);
    if (
      wall.getUTCFullYear() !== year ||
      wall.getUTCMonth() + 1 !== month ||
      wall.getUTCDate() !== day ||
      wall.getUTCHours() !== hour ||
      wall.getUTCMinutes() !== minute ||
      wall.getUTCSeconds() !== second
    ) {
      throw invalidArgument(`${field}不是有效日期时间`);
    }
  }

  return {
    date,
    ms: date.getTime(),
    iso: formatShanghai(date),
  };
}

export function nowMs(ctx) {
  try {
    if (ctx && typeof ctx.now === "function") {
      const value = ctx.now();
      const ms = value instanceof Date ? value.getTime() : Number(value);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // Some hosts expose ctx.now but throw outside a live request scope;
    // fall back to the process clock instead of surfacing an internal error.
  }
  return Date.now();
}

export function nowIso(ctx) {
  return formatShanghai(new Date(nowMs(ctx)));
}

export function secondsBetween(laterMs, earlierMs) {
  if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) return 0;
  return Math.max(0, Math.floor((laterMs - earlierMs) / 1000));
}
