/** 最小 cron（5 段）+ next 求解。dom/dow 双受限取并集；spring-forward 空档在拨快边界触发，fall-back 重复时刻取最早一次。 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  months: Set<number>;
  daysOfMonth: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const parseField = (field: string, min: number, max: number, label: string): Set<number> => {
  const out = new Set<number>();
  for (const term of field.split(",")) {
    const match = term.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!match) throw new Error(`invalid cron ${label} field: ${JSON.stringify(term)}`);
    const stepRaw = match[3];
    const step = stepRaw !== undefined ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron ${label} step: ${JSON.stringify(stepRaw)}`);
    }
    let lower: number;
    let upper: number;
    if (match[1] === "*") {
      if (match[2] !== undefined) throw new Error(`invalid cron ${label} range with *`);
      lower = min;
      upper = max;
    } else {
      lower = Number(match[1]);
      upper = match[2] !== undefined ? Number(match[2]) : lower;
    }
    if (
      !Number.isInteger(lower) ||
      !Number.isInteger(upper) ||
      lower < min ||
      upper > max ||
      lower > upper
    ) {
      throw new Error(`cron ${label} value out of range ${min}-${max}: ${term}`);
    }
    for (let value = lower; value <= upper; value += step) out.add(value);
  }
  if (out.size === 0) throw new Error(`empty cron ${label} field`);
  return out;
};

export const parseCron = (expression: string): CronFields => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (min hour dom mon dow): ${expression}`);
  }
  const minutes = parseField(fields[0]!, 0, 59, "minute");
  const hours = parseField(fields[1]!, 0, 23, "hour");
  const daysOfMonth = parseField(fields[2]!, 1, 31, "day-of-month");
  const months = parseField(fields[3]!, 1, 12, "month");
  const daysOfWeek = parseField(fields[4]!, 0, 7, "day-of-week");
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);
  return {
    minutes,
    hours,
    months,
    daysOfMonth,
    daysOfWeek,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
};

const dayMatches = (date: Date, fields: CronFields): boolean => {
  const domOk = fields.daysOfMonth.has(date.getDate());
  const dowOk = fields.daysOfWeek.has(date.getDay());
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const SCAN_LIMIT_MINUTES = 366 * 24 * 60;
/** 墙钟日循环上限：覆盖任一年（含闰年）的全部日历日。 */
const TZ_SCAN_LIMIT_DAYS = 367;

/** 严格大于 from 的下一个触发时刻；一年无匹配抛错。tz 缺省 = 本机时区。 */
export const nextRunAfter = (expression: string, from: Date, timeZone?: string): Date => {
  if (timeZone === undefined) return nextRunAfterLocal(expression, from);
  return nextRunAfterInTz(expression, from, timeZone);
};

/** v1 路径：按本机时区逐分钟扫描（保留原实现，行为逐字节不变）。 */
const nextRunAfterLocal = (expression: string, from: Date): Date => {
  const fields = parseCron(expression);
  let cursor = new Date(Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  for (let i = 0; i < SCAN_LIMIT_MINUTES; i += 1) {
    if (
      fields.months.has(cursor.getMonth() + 1) &&
      dayMatches(cursor, fields) &&
      fields.hours.has(cursor.getHours()) &&
      fields.minutes.has(cursor.getMinutes())
    ) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + MINUTE_MS);
  }
  throw new Error(`cron expression never fires within a year: ${expression}`);
};


const wallFormatters = new Map<string, Intl.DateTimeFormat>();

const wallFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = wallFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallFormatters.set(timeZone, formatter);
  }
  return formatter;
};

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    wallFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
};

/** 非空字符串且 Intl 可解析；返回 trim 后的值落账。 */
export const validateTimeZone = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("schedule.tz must be a non-empty IANA time zone name");
  }
  const timeZone = value.trim();
  if (!isValidTimeZone(timeZone)) throw new Error(`unknown IANA time zone: ${timeZone}`);
  return timeZone;
};

interface WallFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** 把 UTC 时刻投影到目标时区的墙钟字段（weekday 按墙钟日历日计算）。 */
const projectWall = (
  formatter: Intl.DateTimeFormat,
  instantMs: number,
): WallFields & { second: number; weekday: number } => {
  const parts = formatter.formatToParts(new Date(instantMs));
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)!.value);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return {
    year,
    month,
    day,
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
};

const wallOffsetMs = (formatter: Intl.DateTimeFormat, instantMs: number): number => {
  const wall = projectWall(formatter, instantMs);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - instantMs;
};

const sameWallMinute = (a: WallFields, b: WallFields): boolean =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute;

/** 墙钟字典序 a > b（同一天内用于校验空档边界确实跳过了目标时刻）。 */
const wallAfter = (a: WallFields, b: WallFields): boolean => {
  if (a.year !== b.year) return a.year > b.year;
  if (a.month !== b.month) return a.month > b.month;
  if (a.day !== b.day) return a.day > b.day;
  if (a.hour !== b.hour) return a.hour > b.hour;
  return a.minute > b.minute;
};

const resolveWallMinute = (
  formatter: Intl.DateTimeFormat,
  wall: WallFields,
  notBeforeMs: number,
): number | null => {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  const candidates = new Set<number>();
  for (const probe of [guess - DAY_MS, guess, guess + DAY_MS]) {
    const instant = guess - wallOffsetMs(formatter, probe);
    if (sameWallMinute(projectWall(formatter, instant), wall)) candidates.add(instant);
  }
  if (candidates.size > 0) {
    for (const instant of [...candidates].sort((a, b) => a - b)) {
      if (instant > notBeforeMs) return instant;
    }
    return null;
  }
  // 不存在的墙钟时刻（spring-forward 空档）：二分找偏移跳变点 = 拨快边界。
  const low0 = guess - DAY_MS;
  const high0 = guess + DAY_MS;
  const offsetLow = wallOffsetMs(formatter, low0);
  const offsetHigh = wallOffsetMs(formatter, high0);
  if (offsetLow === offsetHigh) return null; // 无过渡却又反解失败：防御性放弃该候选
  let low = low0;
  let high = high0;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
// 偏移比较容忍 <1s：formatToParts 丢亚秒，严格相等会误判跳变（真过渡 ≥60s）。
    if (Math.abs(wallOffsetMs(formatter, mid) - offsetLow) < 1000) low = mid;
    else high = mid;
  }
// 校验边界确实跳过目标时刻（防病态数据误触发），再套严格大于 from。
  if (wallAfter(projectWall(formatter, high), wall) && high > notBeforeMs) return high;
  return null;
};

const dayMatchesWall = (fields: CronFields, day: { day: number; weekday: number }): boolean => {
  const domOk = fields.daysOfMonth.has(day.day);
  const dowOk = fields.daysOfWeek.has(day.weekday);
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
};

/** `from` 之后（严格大于）的下一个触发时刻，按指定 IANA 时区的墙钟解释 cron 字段。 */
export const nextRunAfterInTz = (expression: string, from: Date, timeZone: string): Date => {
  if (!isValidTimeZone(timeZone)) throw new Error(`unknown IANA time zone: ${timeZone}`);
  const fields = parseCron(expression);
  const formatter = wallFormatter(timeZone);
  const startWall = projectWall(formatter, from.getTime());
  // 日循环锚点固定 UTC 正午：日算术不踩目标时区的过渡时刻（跳变只影响投影，不影响锚点步进）。
  let dayAnchor = Date.UTC(startWall.year, startWall.month - 1, startWall.day, 12, 0, 0, 0);
  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);
  for (let i = 0; i < TZ_SCAN_LIMIT_DAYS; i += 1) {
    const day = projectWall(formatter, dayAnchor);
    if (fields.months.has(day.month) && dayMatchesWall(fields, day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const at = resolveWallMinute(
            formatter,
            { year: day.year, month: day.month, day: day.day, hour, minute },
            from.getTime(),
          );
          if (at !== null) return new Date(at);
        }
      }
    }
    dayAnchor += DAY_MS;
  }
  throw new Error(`cron expression never fires within a year: ${expression}`);
};
