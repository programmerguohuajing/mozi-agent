/**
 * 5 字段标准 cron + Intl 时区。
 * 语义遵循 Vixie cron：标准字段 与 周字段都显式限定时取「或」（domOk || dowOk）。
 */

/** 解析后的 cron 字段（集合形式，便于匹配） */
export interface CronFields {
  minute: Set<number>; // 0-59
  hour: Set<number>; // 0-23
  dom: Set<number>; // 1-31
  month: Set<number>; // 1-12
  dow: Set<number>; // 0=周日 .. 6=周六
  domSpecified: boolean;
  dowSpecified: boolean;
}

export interface LocalParts {
  y: number;
  mo: number; // 1-12
  d: number; // 1-31
  dow: number; // 0=周日
  h: number;
  mi: number;
}

const SHORT_DOW: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsAt(ts: number, tz: string | undefined): LocalParts {
  const key = tz ?? 'local';
  let fmt = fmtCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    fmtCache.set(key, fmt);
  }
  const map = new Map<string, string>(fmt.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  const n = (t: string): number => Number(map.get(t) ?? NaN);
  const w = (map.get('weekday') ?? '').toLowerCase();
  return { y: n('year'), mo: n('month'), d: n('day'), dow: SHORT_DOW[w] ?? 0, h: n('hour'), mi: n('minute') };
}

/** 将「时区本地时刻」转 UTC 时间戳（按显示偏移迭代校正，最多 4 次） */
function tzToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string | undefined): number {
  let ts = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 4; i++) {
const p = partsAt(ts, tz);
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) return ts;
    // 当前 ts 在 tz 下显示为 p（相对目标偏差 Δ 分钟）；反向修正一次即可收敛
    ts += (h - p.h) * 3_600_000 + (mi - p.mi) * 60_000;
  }
  return ts;
}

/** 集合内 >= from 的最小值（不超过 max；没有则 undefined） */
function nextIn(set: Set<number>, from: number, max: number): number | undefined {
  for (let v = from; v <= max; v++) if (set.has(v)) return v;
  return undefined;
}

/** 解析单字段：'*' | 步进 | 范围 | 列表 */
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  if (field === '*') {
    for (let i = min; i <= max; i++) out.add(i);
    return out;
  }
  for (const piece of field.split(',')) {
    const p = piece.trim();
    if (!p) continue;
    const stepMatch = /^(.+)\/(\d+)$/.exec(p);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const range = stepMatch ? (stepMatch[1] ?? '') : p;
    let from = min;
    let to = max;
    if (range !== '*') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!m) throw new Error(`invalid cron field: ${field}`);
      from = Number(m[1]);
      // 'a-b/n' 区间步进；'a/n' 或 'a' 单值：step>1 时延伸至字段上限（如 5/15 → 5,20,35,50）
      to = m[2] ? Number(m[2]) : step > 1 ? max : from;
    }
    if (from < min || to > max || from > to) throw new Error(`cron field out of bounds: ${field}`);
    for (let i = from; i <= to; i += step) out.add(i);
  }
  return out;
}

/** 解析 5 字段 cron 表达式（分 时 日 月 周；周 0/7 均视为周日） */
export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 需要 5 个字段，实际 ${fields.length}: ${expression}`);
  const [minS, hourS, domS, monthS, dowS] = fields as [string, string, string, string, string];
  const dom = parseField(domS, 1, 31);
  const dow = parseField(dowS, 0, 7);
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: parseField(minS, 0, 59),
    hour: parseField(hourS, 0, 23),
    dom,
    month: parseField(monthS, 1, 12),
    dow,
    domSpecified: domS !== '*',
    dowSpecified: dowS !== '*',
  };
}

function dayMatches(c: CronFields, d: number, dow: number): boolean {
  const domOk = c.dom.has(d);
  const dowOk = c.dow.has(dow);
  if (c.domSpecified && c.dowSpecified) return domOk || dowOk; // Vixie OR 语义
  if (c.domSpecified) return domOk;
  if (c.dowSpecified) return dowOk;
  return true;
}

/**
 * 求严格晚于 from 的下一个匹配时刻（单位：毫秒时间戳）。
 * 时区用 Intl（零依赖），DST 间隙自动跳过。
 */
export function nextRunAfter(from: Date, c: CronFields, timeZone?: string): Date {
  // 对齐到 from 之后的首个整分钟
  const base = from.getTime();
  const mod = base % 60_000;
  let ts = base - mod + 60_000; // 严格 > from
  for (let iter = 0; iter < 4096; iter++) {
    const p = partsAt(ts, timeZone);
    // 1) 月份
    if (!c.month.has(p.mo)) {
      const ny = p.mo === 12 ? p.y + 1 : p.y;
      const nm = p.mo === 12 ? 1 : p.mo + 1;
      ts = tzToUtc(ny, nm, 1, 0, 0, timeZone);
      continue;
    }
    // 2) 日期（日/周）
    if (!dayMatches(c, p.d, p.dow)) {
      ts = tzToUtc(p.y, p.mo, p.d + 1, 0, 0, timeZone); // Date.UTC 自动跨月进位
      continue;
    }
    // 3) 小时
    if (!c.hour.has(p.h)) {
      const nh = nextIn(c.hour, p.h + 1, 23);
      if (nh === undefined) ts = tzToUtc(p.y, p.mo, p.d + 1, 0, 0, timeZone);
      else ts = tzToUtc(p.y, p.mo, p.d, nh, 0, timeZone);
      continue;
    }
    // 4) 分钟
    if (!c.minute.has(p.mi)) {
      const nm = nextIn(c.minute, p.mi + 1, 59);
      if (nm !== undefined) {
        ts = tzToUtc(p.y, p.mo, p.d, p.h, nm, timeZone);
      } else {
        const nh = nextIn(c.hour, p.h + 1, 23);
        ts = nh === undefined ? tzToUtc(p.y, p.mo, p.d + 1, 0, 0, timeZone) : tzToUtc(p.y, p.mo, p.d, nh, 0, timeZone);
      }
      continue;
    }
    // 5) 全部匹配 → 校验 DST 间隙（gap 内真实字段 ≠ 目标字段）
    const real = tzToUtc(p.y, p.mo, p.d, p.h, p.mi, timeZone);
    const rp = partsAt(real, timeZone);
    if (rp.y === p.y && rp.mo === p.mo && rp.d === p.d && rp.h === p.h && rp.mi === p.mi) {
      return new Date(real);
    }
    ts = real + 60_000; // gap：跳到下一分钟继续
  }
  throw new Error(`cron 求解超过迭代上限：${JSON.stringify(c)}`);
}