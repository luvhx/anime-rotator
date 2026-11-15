import crypto from 'node:crypto';

/* ------------------------------------------------------------------ *
 * 路径 / URL 编码
 * ------------------------------------------------------------------ */

/**
 * 把 WebDAV 相对路径（未转义、用 / 分隔）编码成 URL 路径。
 * 逐段 encodeURIComponent，保留斜杠。
 */
export function encodePath(relPath) {
  return String(relPath)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/** 拼接 baseUrl 与相对路径，不产生重复/缺失斜杠 */
export function joinUrl(baseUrl, relPath = '') {
  const base = String(baseUrl).replace(/\/+$/, '');
  const rel = encodePath(relPath);
  return rel ? `${base}/${rel}` : base;
}

/** 稳定的短 id（12 位 base36），用于 fileId / channel 内部标识 */
export function shortId(input, len = 10) {
  const h = crypto.createHash('sha1').update(String(input)).digest();
  return BigInt('0x' + h.subarray(0, 8).toString('hex')).toString(36).padStart(len, '0').slice(0, len);
}

export function sha1(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

/* ------------------------------------------------------------------ *
 * 确定性随机（同一 seed 永远得到同一序列，用于「随机」规则可复现）
 * ------------------------------------------------------------------ */

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG */
export function rng(seed) {
  let a = (typeof seed === 'number' ? seed : hash32(String(seed))) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates，使用给定 rng，原地打乱 */
export function shuffleInPlace(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/* ------------------------------------------------------------------ *
 * 时间 / 时区
 * ------------------------------------------------------------------ */

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map();
function dtfFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** 某个绝对时刻在 tz 下的「墙上时间」 */
export function localParts(ms, tz) {
  const parts = dtfFor(tz).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
  };
}

/** tz 相对 UTC 的偏移（毫秒，东为正） */
export function tzOffsetMs(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 本地日序号（自 1970-01-01 起，按 tz 的自然日） */
export function localDayIndex(ms, tz) {
  const p = localParts(ms, tz);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
}

/** 某个本地日 00:00:00 的绝对时间戳 */
export function dayStartMs(dayIndex, tz) {
  const utcMidnight = dayIndex * 86400000;
  let guess = utcMidnight - tzOffsetMs(utcMidnight, tz);
  guess = utcMidnight - tzOffsetMs(guess, tz);
  return guess;
}

/** "20:30" / "20:30:15" -> 当天秒数 */
export function parseClock(str) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(str).trim());
  if (!m) throw new Error(`时间格式应为 HH:MM 或 HH:MM:SS，收到 "${str}"`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] || 0);
  if (hh > 24 || mm > 59 || ss > 59) throw new Error(`时间越界："${str}"`);
  return hh * 3600 + mm * 60 + ss;
}

export function isValidDate(ms) {
  return typeof ms === 'number' && Number.isFinite(ms);
}

/** 允许 ISO 字符串 / 数字 / Date 输入 */
export function toMs(input, fallback = Date.now()) {
  if (input == null) return fallback;
  if (input instanceof Date) return input.getTime();
  if (typeof input === 'number') return input;
  const n = Date.parse(String(input));
  if (Number.isNaN(n)) throw new Error(`无法解析时间：${input}`);
  return n;
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLocal(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function weekdayOf(ms, tz) {
  return localParts(ms, tz).weekday;
}

export { WD as WEEKDAYS };

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 简易并发限制器 */
export function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= concurrency || queue.length === 0) return;
    const job = queue.shift();
    active++;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  };
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}

export async function mapLimit(items, concurrency, fn) {
  const limit = createLimiter(concurrency);
  const out = new Array(items.length);
  await Promise.all(
    items.map((item, i) =>
      limit(async () => {
        out[i] = await fn(item, i);
      }),
    ),
  );
  return out;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
