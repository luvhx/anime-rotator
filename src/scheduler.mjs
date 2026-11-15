/**
 * 编排引擎
 * ------------------------------------------------------------------
 * 概念：
 *   channel   一个频道（一条播出时间轴）
 *   program   编排规则列表，每段 (segment) 用一条规则生成一段节目
 *   entry     时间轴上的一个节目项（= 一个视频文件 + 时长 + 绝对起止时间）
 *
 * 时间轴有两种模式：
 *   loop   固定循环：从 anchor 起把 program 展开成一个「循环」，之后无限重复。
 *          位置 = (now - anchor) mod cycleLen，O(1) 定位，与时刻无关。
 *   daily  按自然日编排：每天 00:00 重新开始，program 填满 24 小时，跨零点节目被截断。
 *          适合「黄金档 / 深夜档」这类与墙上时钟绑定的规则。
 *
 * 所有「随机」都使用确定性 PRNG：同一频道 + 同一天/同一循环永远得到同一编排。
 */

import {
  rng,
  hash32,
  shuffleInPlace,
  localDayIndex,
  dayStartMs,
  localParts,
  parseClock,
  fmtDuration,
} from './util.mjs';

const DAY_MS = 86400000;
const DEFAULT_SEGMENT_COUNT = 12;

/* ------------------------------------------------------------------ *
 * 规则工厂
 * ------------------------------------------------------------------ */

function seriesOfEarly(library, channel) {
  const filter = channel.library || {};
  let list = library.series.slice();
  if (Array.isArray(filter.series) && filter.series.length > 0) {
    const picked = [];
    for (const sel of filter.series) picked.push(...library.resolve(sel));
    const uniq = new Map(picked.map((s) => [s.id, s]));
    list = [...uniq.values()];
  }
  if (Array.isArray(filter.exclude) && filter.exclude.length > 0) {
    const drop = new Set();
    for (const sel of filter.exclude) for (const s of library.resolve(sel)) drop.add(s.id);
    list = list.filter((s) => !drop.has(s.id));
  }
  if (filter.minEpisodes) list = list.filter((s) => s.episodes.length >= filter.minEpisodes);
  list = list.filter((s) => s.episodes.length > 0);
  return list;
}

function selectSeries(rule, ctx) {
  const base = ctx.series;
  if (!rule.series) return base.slice();
  const wanted = Array.isArray(rule.series) ? rule.series : [rule.series];
  const out = [];
  for (const sel of wanted) {
    const hits = ctx.library.resolve(sel);
    for (const s of hits) if (base.some((b) => b.id === s.id)) out.push(s);
  }
  return out;
}

function weightOf(ctx, series) {
  const w = ctx.channel.weights;
  if (!w) return 1;
  const v = w[series.displayName] ?? w[series.name] ?? w[series.id];
  return typeof v === 'number' && v > 0 ? v : 1;
}

/** 顺序：每部播完再下一部（binge 的行为）；order=shuffle 时先打散系列 */
function makeSequential(rule, ctx) {
  const order = rule.order || 'config';
  let list = selectSeries(rule, ctx);
  if (order === 'shuffle') list = shuffleInPlace(list.slice(), rng(hash32(ctx.seedPrefix + ':series')));
  if (order === 'name') list = list.slice().sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'));
  if (rule.shuffleEpisodes) {
    let si = 0;
    let cur = null;
    let curIdx = 0;
    return {
      endless: false,
      next() {
        while (si < list.length) {
          if (!cur) {
            cur = shuffleInPlace(
              ctx.library.episodesOf(list[si].id).slice(),
              rng(hash32(`${ctx.seedPrefix}:ep:${list[si].id}`)),
            );
            curIdx = 0;
            si++;
          }
          if (curIdx < cur.length) return cur[curIdx++];
          cur = null;
        }
        return null;
      },
    };
  }
  let si = 0;
  let ei = 0;
  return {
    endless: false,
    next() {
      while (si < list.length) {
        const eps = ctx.library.episodesOf(list[si].id);
        if (ei < eps.length) return eps[ei++];
        si++;
        ei = 0;
      }
      return null;
    },
  };
}

/** 轮播：每个系列轮流各出一集（A 第1集 → B 第1集 → C 第1集 → A 第2集 …） */
function makeInterleave(rule, ctx) {
  const list = selectSeries(rule, ctx);
  let round = 0;
  let pos = 0;
  return {
    endless: false,
    next() {
      if (list.length === 0) return null;
      let guard = 0;
      while (guard++ <= list.length + 1) {
        if (pos >= list.length) {
          pos = 0;
          round++;
        }
        const eps = ctx.library.episodesOf(list[pos].id);
        if (round >= eps.length) {
          // 该系列本季已播完，看这一轮还有没有别的系列可播
          const anyLeft = list.some((s) => ctx.library.episodesOf(s.id).length > round);
          if (!anyLeft) return null;
          pos++;
          continue;
        }
        const ep = eps[round];
        pos++;
        return ep;
      }
      return null;
    },
  };
}

/** 随机：整库（或指定系列）全集打散，播完一轮即结束（由编排引擎决定是否重来） */
function makeShuffle(rule, ctx) {
  const pool = selectSeries(rule, ctx).flatMap((s) => ctx.library.episodesOf(s.id));
  const random = rng(hash32(`${ctx.seedPrefix}:shuffle`));
  const deck = shuffleInPlace(pool.slice(), random);
  let cursor = 0;
  return {
    endless: false,
    next() {
      if (pool.length === 0) return null;
      if (cursor >= deck.length) return null;
      return deck[cursor++];
    },
  };
}

/** 加权随机：系列权重 × 集，可无限抽取 */
function makeWeighted(rule, ctx) {
  const list = selectSeries(rule, ctx);
  const weights = list.map((s) => weightOf(ctx, s));
  const total = weights.reduce((a, b) => a + b, 0);
  const random = rng(hash32(`${ctx.seedPrefix}:weighted`));
  const pickSeries = () => {
    let x = random() * total;
    for (let i = 0; i < list.length; i++) {
      x -= weights[i];
      if (x <= 0) return list[i];
    }
    return list[list.length - 1];
  };
  return {
    endless: true,
    next() {
      if (list.length === 0) return null;
      const s = pickSeries();
      const eps = ctx.library.episodesOf(s.id);
      if (eps.length === 0) return null;
      return eps[Math.floor(random() * eps.length)];
    },
  };
}

/** 日切：每天（本地日）换一部系列，集序当天随机 */
function makeDaily(rule, ctx) {
  const list = selectSeries(rule, ctx);
  const random = rng(hash32(`${ctx.seedPrefix}:daily`));
  let curDay = -1;
  let deck = [];
  let idx = 0;
  return {
    endless: true,
    next(cursorMs) {
      if (list.length === 0) return null;
      const day = localDayIndex(cursorMs, ctx.tz);
      if (day !== curDay) {
        curDay = day;
        const dayRng = rng(hash32(`${ctx.seedPrefix}:day:${day}`));
        const series = list[Math.floor(dayRng() * list.length)];
        deck = shuffleInPlace(ctx.library.episodesOf(series.id).slice(), dayRng);
        idx = 0;
      }
      if (deck.length === 0) return null;
      if (idx >= deck.length) deck = shuffleInPlace(deck.slice(), random), (idx = 0);
      return deck[idx++];
    },
  };
}

/** 时段：按「当前节目起始时刻」的墙上时间选择子规则 */
function makeDaypart(rule, ctx) {
  const slots = (rule.slots || [])
    .map((s) => ({ ...s, fromSec: parseClock(s.from), toSec: parseClock(s.to) }))
    .sort((a, b) => a.fromSec - b.fromSec);
  if (slots.length === 0) throw new Error('daypart 规则需要至少一个 slots 项');
  const engines = new Map();
  const engineFor = (i) => {
    if (!engines.has(i)) {
      engines.set(
        i,
        makeRule(slots[i].rule || { type: 'sequential' }, {
          ...ctx,
          seedPrefix: `${ctx.seedPrefix}:slot${i}`,
        }),
      );
    }
    return engines.get(i);
  };
  const pickSlot = (cursorMs) => {
    const p = localParts(cursorMs, ctx.tz);
    const sec = p.hour * 3600 + p.minute * 60 + p.second;
    // 支持跨零点区间（from > to）
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.fromSec <= s.toSec) {
        if (sec >= s.fromSec && sec < s.toSec) return i;
      } else if (sec >= s.fromSec || sec < s.toSec) return i;
    }
    // 落在空档：取最近一个已开始的时段
    let best = -1;
    for (let i = 0; i < slots.length; i++) if (slots[i].fromSec <= sec) best = i;
    return best >= 0 ? best : slots.length - 1;
  };
  return {
    endless: true,
    next(cursorMs) {
      const i = pickSlot(cursorMs);
      const ep = engineFor(i).next(cursorMs);
      if (ep && slots[i].label) return { ...ep, __segmentLabel: slots[i].label };
      return ep;
    },
  };
}

/** 手动：显式节目单 */
function makeManual(rule, ctx) {
  const items = (rule.items || []).map((it) => {
    if (it.fileId) return ctx.library.getEpisode(it.fileId);
    if (it.episode) {
      const series = ctx.library.resolve(it.series)[0];
      if (!series) return null;
      return ctx.library.episodesOf(series.id).find((e) => e.season === (it.season || 1) && e.episode === it.episode) || null;
    }
    return null;
  });
  const list = items.filter(Boolean);
  let i = 0;
  return {
    endless: false,
    next() {
      if (i >= list.length) return null;
      return list[i++];
    },
  };
}

const RULE_FACTORIES = {
  sequential: makeSequential,
  binge: makeSequential,
  interleave: makeInterleave,
  shuffle: makeShuffle,
  weighted: makeWeighted,
  daily: makeDaily,
  daypart: makeDaypart,
  manual: makeManual,
};

export const RULE_TYPES = Object.keys(RULE_FACTORIES);

function makeRule(rule, ctx) {
  const type = rule?.type || 'sequential';
  const factory = RULE_FACTORIES[type];
  if (!factory) throw new Error(`未知的编排规则类型："${type}"（可用：${RULE_TYPES.join(', ')}）`);
  return factory({ ...rule, type }, ctx);
}

/* ------------------------------------------------------------------ *
 * 时间轴
 * ------------------------------------------------------------------ */

export class ChannelTimeline {
  /**
   * @param {object} opts
   * @param {object} opts.channel  频道定义
   * @param {import('./library.mjs').Library} opts.library
   * @param {string} opts.tz
   */
  constructor({ channel, library, tz = 'Asia/Shanghai' }) {
    this.channel = normalizeChannel(channel);
    this.library = library;
    this.tz = tz;
    this.mode = this.channel.mode;
    this._cycle = null;
    this._dayCache = new Map();
    this._series = seriesOfEarly(library, this.channel);
  }

  get anchorMs() {
    return this.channel.anchorMs;
  }

  /**
   * 展开 program，得到相对 startMs 的节目条目。
   *
   * 关键点：段 (segment) 的目标（count / hours）是「每一轮」的配额，
   * 规则本身的状态会一直延续到跑完为止。于是「2 小时随机 + 6 集轮播」
   * 的含义是：每轮 2 小时随机 + 6 集轮播，反复交替，直到所有规则都播完
   * 整个片库——一个循环 = 整库播一遍，之后才回到开头。
   */
  expand(startMs) {
    const entries = [];
    let cursor = 0; // 相对 startMs 的毫秒
    const dayLimit = this.mode === 'daily' ? DAY_MS : Number.POSITIVE_INFINITY;
    const program = this.channel.program;
    // daily 模式下把「日」编进随机种子，保证每天编排不同但可复现
    const dayTag = this.mode === 'daily' ? '/d' + localDayIndex(startMs, this.tz) : '';

    const units = program.map((seg, segIndex) => {
      const ctx = {
        library: this.library,
        series: this._series,
        channel: this.channel,
        tz: this.tz,
        seedPrefix: `${this.channel.id}/${segIndex}/${this.channel.seed}${dayTag}`,
      };
      const engine = makeRule(seg.rule, ctx);
      return {
        seg,
        segIndex,
        ctx,
        engine,
        target: resolveTarget(seg, engine),
        label: seg.label || seg.rule?.type || `规则 ${segIndex + 1}`,
        done: false,
        restarts: 0,
      };
    });

    let rounds = 0;
    const MAX_ENTRIES = 200000;
    while (rounds++ < 100000 && entries.length < MAX_ENTRIES && cursor < dayLimit) {
      let progressed = false;
      for (const u of units) {
        if (u.done) continue;
        if (cursor >= dayLimit) {
          u.done = true;
          continue;
        }
        let pulled = 0;
        let pulledMs = 0;
        for (;;) {
          if (entries.length >= MAX_ENTRIES || cursor >= dayLimit) {
            u.done = true;
            break;
          }
          if (u.target.kind === 'count' && u.target.value !== Infinity && pulled >= u.target.value) break;
          if (u.target.kind === 'ms' && pulledMs >= u.target.value) break;
          let ep = u.engine.next(startMs + cursor);
          if (!ep) {
            // 规则播完一轮：fill 段（按日编排）或显式 loop 段换新种子重来
            const canRestart = u.seg.loop || u.target.kind === 'fill';
            if (canRestart && u.restarts < 12) {
              u.restarts++;
              u.engine = makeRule(u.seg.rule, { ...u.ctx, seedPrefix: `${u.ctx.seedPrefix}#r${u.restarts}` });
              ep = u.engine.next(startMs + cursor);
            }
            if (!ep) {
              u.done = true;
              break;
            }
          }
          entries.push({
            episode: ep,
            relStart: cursor,
            durationMs: ep.durationMs,
            segmentIndex: u.segIndex,
            segmentLabel: ep.__segmentLabel || u.label,
          });
          cursor += ep.durationMs;
          pulled++;
          pulledMs += ep.durationMs;
          progressed = true;
        }
      }
      if (!progressed) break;
      if (this.mode === 'daily') break; // 日编排只展开一轮，剩余部分交给 dayPlan 截断
      const finite = units.filter((u) => !u.engine.endless);
      if (finite.length === 0) break; // 全是无限规则，只展开一轮避免死循环
      if (finite.every((u) => u.done)) break; // 有限规则全部播完 → 循环结束
    }

    if (entries.length === 0) {
      throw new Error(
        `频道「${this.channel.name}」的编排没有产出任何节目：请检查 library 过滤条件与 program 规则（库内共 ${this.library.series.length} 部 / ${this.library.episodes.length} 集）`,
      );
    }
    return { entries, totalMs: cursor };
  }

  /** loop 模式：固定循环 */
  cycle() {
    if (!this._cycle) {
      const { entries, totalMs } = this.expand(this.anchorMs);
      let acc = 0;
      for (const e of entries) {
        e.absStart = this.anchorMs + acc;
        acc += e.durationMs;
      }
      this._cycle = { entries, totalMs };
    }
    return this._cycle;
  }

  /** daily 模式：某本地日的节目表（跨零点截断） */
  dayPlan(dayIndex) {
    const cached = this._dayCache.get(dayIndex);
    if (cached) return cached;
    const start = dayStartMs(dayIndex, this.tz);
    const { entries } = this.expand(start);
    const out = [];
    let cursor = 0;
    for (const e of entries) {
      if (cursor >= DAY_MS) break;
      const room = DAY_MS - cursor;
      const dur = Math.min(e.durationMs, room);
      if (dur <= 0) break;
      out.push({
        ...e,
        absStart: start + cursor,
        durationMs: dur,
        truncated: dur < e.durationMs,
      });
      cursor += dur;
    }
    const plan = { dayIndex, dayStart: start, entries: out, totalMs: cursor };
    if (this._dayCache.size > 16) this._dayCache.delete(this._dayCache.keys().next().value);
    this._dayCache.set(dayIndex, plan);
    return plan;
  }

  /** 定位：给定时刻返回当前节目 + 进度 */
  resolve(nowMs) {
    if (this.mode === 'daily') {
      const day = localDayIndex(nowMs, this.tz);
      let plan = this.dayPlan(day);
      let offset = nowMs - plan.dayStart;
      if (offset < 0 || offset >= DAY_MS) {
        plan = this.dayPlan(day + 1);
        offset = nowMs - plan.dayStart;
      }
      const hit = findEntryByTime(plan.entries, nowMs, 'absStart');
      if (!hit) {
        // 落在当天节目之外（规则产出不足一天）：顺延到相邻日的首条
        const nextPlan = nowMs < plan.entries[0].absStart ? plan : this.dayPlan(day + 1);
        const first = nextPlan.entries[0];
        return makeResolved(this, first, first.absStart, nowMs, first.truncated);
      }
      return makeResolved(this, hit.entry, hit.entry.absStart, nowMs, hit.entry.truncated);
    }

    const { entries, totalMs } = this.cycle();
    const delta = nowMs - this.anchorMs;
    const k = Math.floor(delta / totalMs);
    const pos = delta - k * totalMs;
    const hit = findEntryByTime(entries, pos, 'relStart');
    const entry = hit ? hit.entry : entries[entries.length - 1];
    const startsAt = this.anchorMs + k * totalMs + entry.relStart;
    return makeResolved(this, entry, startsAt, nowMs, false);
  }

  /**
   * 节目单：从 fromMs 起，最多 limit 条或到 toMs 为止
   */
  schedule(fromMs, toMs, limit = 50) {
    const out = [];
    if (this.mode === 'daily') {
      let day = localDayIndex(fromMs, this.tz);
      let guard = 0;
      while (out.length < limit && guard++ < 400) {
        const plan = this.dayPlan(day);
        for (const e of plan.entries) {
          const ends = e.absStart + e.durationMs;
          if (ends <= fromMs) continue;
          if (out.length >= limit) break;
          out.push(toProgramItem(e, e.absStart, e.durationMs, e.truncated));
          if (ends >= toMs) return out;
        }
        day++;
        if (dayStartMs(day, this.tz) > toMs) break;
      }
      return out;
    }

    const { entries, totalMs } = this.cycle();
    const delta = fromMs - this.anchorMs;
    let k = Math.floor(delta / totalMs);
    let pos = delta - k * totalMs;
    let guard = 0;
    // 从当前位置开始顺序遍历
    let idx = entries.findIndex((e) => pos >= e.relStart && pos < e.relStart + e.durationMs);
    if (idx < 0) idx = 0;
    while (out.length < limit && guard++ < 100000) {
      const e = entries[idx];
      const startsAt = this.anchorMs + k * totalMs + e.relStart;
      if (startsAt >= toMs) break;
      out.push(toProgramItem(e, startsAt, e.durationMs, false));
      idx++;
      if (idx >= entries.length) {
        idx = 0;
        k++;
      }
    }
    return out;
  }

  stats() {
    if (this.mode === 'daily') {
      const today = localDayIndex(Date.now(), this.tz);
      const plan = this.dayPlan(today);
      return {
        mode: 'daily',
        dayEntries: plan.entries.length,
        dayDurationMs: plan.totalMs,
        poolSeries: this._series.length,
        poolEpisodes: this._series.reduce((a, s) => a + s.episodes.length, 0),
      };
    }
    const { entries, totalMs } = this.cycle();
    return {
      mode: 'loop',
      cycleEntries: entries.length,
      cycleDurationMs: totalMs,
      poolSeries: this._series.length,
      poolEpisodes: this._series.reduce((a, s) => a + s.episodes.length, 0),
      cycleDays: totalMs / DAY_MS,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function resolveTarget(seg, engine) {
  if (seg.count != null) return { kind: 'count', value: Math.max(1, Math.floor(seg.count)) };
  if (seg.fill) return { kind: 'fill', value: 0 };
  if (seg.hours != null) return { kind: 'ms', value: seg.hours * 3600000 };
  if (seg.minutes != null) return { kind: 'ms', value: seg.minutes * 60000 };
  if (seg.durationMs != null) return { kind: 'ms', value: seg.durationMs };
  if (seg.all) return { kind: 'count', value: Number.POSITIVE_INFINITY };
  // 未指定：有限规则播完一轮；无限规则给个默认段长
  if (engine.endless) return { kind: 'count', value: DEFAULT_SEGMENT_COUNT };
  return { kind: 'count', value: Number.POSITIVE_INFINITY };
}

function findEntryByTime(entries, t, key) {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid];
    const start = e[key];
    if (t < start) hi = mid - 1;
    else if (t >= start + e.durationMs) lo = mid + 1;
    else return { entry: e, index: mid };
  }
  return null;
}

function makeResolved(tl, entry, startsAt, nowMs, truncated) {
  const endsAt = startsAt + entry.durationMs;
  return {
    entry,
    episode: entry.episode,
    startsAt,
    endsAt,
    durationMs: entry.durationMs,
    offsetMs: Math.max(0, Math.min(entry.durationMs, nowMs - startsAt)),
    remainingMs: Math.max(0, endsAt - nowMs),
    progress: entry.durationMs > 0 ? Math.max(0, Math.min(1, (nowMs - startsAt) / entry.durationMs)) : 0,
    truncated: Boolean(truncated),
    segmentLabel: entry.segmentLabel,
    channel: tl.channel,
  };
}

function toProgramItem(entry, startsAt, durationMs, truncated) {
  return {
    startsAt,
    endsAt: startsAt + durationMs,
    durationMs,
    truncated: Boolean(truncated),
    segmentLabel: entry.segmentLabel,
    episode: entry.episode,
  };
}

/** 复用已解析的剧集对象，避免每次重新 bind */
export function episodeView(ep) {
  return {
    fileId: ep.fileId,
    seriesId: ep.seriesId,
    series: ep.seriesName,
    season: ep.season,
    episode: ep.episode,
    title: ep.title,
    name: ep.name,
    relPath: ep.relPath,
    size: ep.size,
    durationMs: ep.durationMs,
    durationText: fmtDuration(ep.durationMs),
    subtitle: ep.subtitle || null,
    container: ep.container,
  };
}

/* ------------------------------------------------------------------ *
 * 频道定义归一化
 * ------------------------------------------------------------------ */

export function normalizeChannel(def, tz = 'Asia/Shanghai') {
  if (!def || !def.id) throw new Error('频道定义缺少 id');
  const program = def.program || def.rules || [];
  const norm = {
    id: String(def.id),
    name: def.name || def.id,
    description: def.description || '',
    mode: def.mode === 'daily' ? 'daily' : 'loop',
    seed: def.seed ?? def.id,
    library: def.library || {},
    weights: def.weights || null,
    anchorMs: def.anchor ? Date.parse(def.anchor) : Date.parse('2024-01-01T00:00:00+08:00'),
    program: program.length > 0 ? program : [{ rule: { type: 'sequential' } }],
  };
  if (Number.isNaN(norm.anchorMs)) throw new Error(`频道 ${norm.id} 的 anchor 时间无法解析：${def.anchor}`);
  norm.program = norm.program.map((seg, i) => {
    if (!seg || !seg.rule) throw new Error(`频道 ${norm.id} 第 ${i + 1} 段缺少 rule`);
    return seg;
  });
  return norm;
}
