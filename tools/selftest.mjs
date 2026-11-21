#!/usr/bin/env node
/**
 * 编排引擎自检（不联网、不读写磁盘，CI 友好）
 *
 *   node tools/selftest.mjs
 *
 * 校验：时间轴连续性、起止点定位、循环还原、日编排 24h 覆盖与截断、跨零点时段。
 */
import { Library } from '../src/library.mjs';
import { ChannelTimeline, RULE_TYPES, normalizeChannel } from '../src/scheduler.mjs';
import { dayStartMs, localParts, fmtDuration } from '../src/util.mjs';

const TZ = 'Asia/Shanghai';
let failures = 0;

function check(ok, msg, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

/* ------------------------- 造一个合成片库 ------------------------- */

const MIN = 60 * 1000;

function makeLibrary() {
  const series = [];
  const names = ['合成·冰菓', '合成·孤独摇滚', '合成·夏日重现', '合成·命运石之门'];
  names.forEach((name, si) => {
    const episodes = [];
    const count = [3, 5, 4, 2][si];
    // 第 3 部带 Season 0（OVA 应排在正片之后）、第 4 部只有 2 集
    const seasons = si === 2 ? [0, 1] : [1];
    for (const season of seasons) {
      const n = season === 0 ? 2 : count;
      for (let e = 1; e <= n; e++) {
        episodes.push({
          fileId: `f${si}${season}${e}`.padEnd(10, '0').slice(0, 10),
          season,
          episode: e,
          title: `第 ${e} 话`,
          name: `${name} - S0${season}E0${e}.mkv`,
          relPath: `动画/${name}/Season ${season}/${name} - S0${season}E0${e}.mkv`,
          size: 1000 * (e + 1),
          lastModified: 0,
          subtitle: null,
          container: 'matroska',
          durationMs: (20 + si) * MIN + e * 15 * 1000,
          durationSource: 'mkv-info',
        });
      }
    }
    series.push({ id: `/动画/${name}`, dir: `动画/${name}`, name, displayName: name, tmdbId: null, episodes });
  });
  return new Library({ version: 1, series, stats: {} });
}

const library = makeLibrary();

const channels = {
  seq: { id: 'seq', name: '顺序连播', mode: 'loop', anchor: '2026-01-01T00:00:00+08:00', program: [{ rule: { type: 'sequential' } }] },
  mix: {
    id: 'mix',
    name: '混编',
    mode: 'loop',
    anchor: '2026-01-01T00:00:00+08:00',
    program: [
      { rule: { type: 'shuffle' }, hours: 1 },
      { rule: { type: 'interleave' }, count: 3 },
    ],
  },
  daily: {
    id: 'daily',
    name: '日编排',
    mode: 'daily',
    program: [
      {
        fill: true,
        rule: {
          type: 'daypart',
          slots: [
            { from: '22:00', to: '06:00', label: '深夜', rule: { type: 'shuffle' } },
            { from: '06:00', to: '22:00', label: '白天', rule: { type: 'interleave' } },
          ],
        },
      },
    ],
  },
  manual: {
    id: 'manual',
    name: '手动',
    mode: 'loop',
    anchor: '2026-03-01T19:00:00+08:00',
    program: [
      {
        loop: true,
        rule: {
          type: 'manual',
          items: [
            { series: '合成·冰菓', season: 1, episode: 1 },
            { series: '合成·夏日重现', season: 1, episode: 2 },
          ],
        },
      },
    ],
  },
};

/* ------------------------------ 检查 ------------------------------ */

check(RULE_TYPES.length >= 8, '规则类型齐全', RULE_TYPES.join(', '));
check(library.episodes.length === 16, '合成片库集数', `${library.series.length} 部 / ${library.episodes.length} 集`);

// 季排序：Season 0 应排在正片之后
const withOva = library.seriesByName.get('合成·夏日重现');
const order = withOva.__full.map((e) => `S${e.season}E${e.episode}`);
check(order.slice(0, 4).join(',') === 'S1E1,S1E2,S1E3,S1E4', 'OVA 排在正片之后', order.join(' '));

for (const def of Object.values(channels)) {
  const tl = new ChannelTimeline({ channel: def, library, tz: TZ });
  console.log(`\n[${def.id}] ${def.name}（${def.mode}）`);

  if (def.mode === 'loop') {
    const from = Date.parse('2026-06-01T20:00:00+08:00');
    const items = tl.schedule(from, from + 30 * 24 * 3600_000, 100000);
    check(items.length > 0, '产出节目单', `${items.length} 条`);
    let contiguous = true;
    for (let i = 0; i < items.length - 1; i++) {
      if (items[i].endsAt !== items[i + 1].startsAt) {
        contiguous = false;
        check(false, `第 ${i}/${i + 1} 条不连续`);
        break;
      }
    }
    if (contiguous) check(true, '节目首尾相接');

    // 循环还原：一个周期后回到同一位置
    const { cycleDurationMs } = tl.stats();
    const a = tl.resolve(from);
    const b = tl.resolve(from + cycleDurationMs);
    check(a.episode.fileId === b.episode.fileId && a.offsetMs === b.offsetMs, '整周期后回到同一位置', fmtDuration(cycleDurationMs));

    // 起止点定位
    let locateOk = true;
    for (let i = 0; i < Math.min(items.length - 1, 100); i++) {
      const it = items[i];
      const s = tl.resolve(it.startsAt + 1);
      const e = tl.resolve(it.endsAt - 1);
      if (s.episode.fileId !== it.episode.fileId || e.episode.fileId !== it.episode.fileId) {
        locateOk = false;
        check(false, `定位错误 @${i}`);
        break;
      }
    }
    if (locateOk) check(true, '任意条目起止点定位正确');

    // 整库播完（一条不重不漏）——顺序频道
    if (def.id === 'seq') {
      const seen = new Set(items.slice(0, tl.stats().cycleEntries).map((i) => i.episode.fileId));
      check(seen.size === library.episodes.length, '一个循环覆盖全部剧集且不重复', `${seen.size} 集`);
    }
  } else {
    for (const date of ['2026-06-01', '2026-06-02', '2026-12-31']) {
      const [y, m, d] = date.split('-').map(Number);
      const start = dayStartMs(Math.floor(Date.UTC(y, m - 1, d) / 86400000), TZ);
      const items = tl.schedule(start, start + 86400_000, 500);
      const contiguous = items.every((it, i) => i === 0 || it.startsAt === items[i - 1].endsAt);
      const last = items[items.length - 1];
      const covered = (last.endsAt - start) / 3600_000;
      check(
        items.length > 0 && contiguous && last.endsAt <= start + 86400_000 && covered > 23,
        `${date} 覆盖整天且不越界`,
        `${items.length} 条 / ${covered.toFixed(1)}h`,
      );
    }
    // 跨零点时段：00:30 应命中「深夜」规则
    const midnight = dayStartMs(Math.floor(Date.UTC(2026, 5, 1) / 86400000), TZ) + 30 * 60_000;
    const r = tl.resolve(midnight);
    check(r.startsAt <= midnight && r.endsAt > midnight, '凌晨时段可定位', r.episode.seriesName);
  }
}

/* --------------------------- 边界与错误处理 --------------------------- */

// 空库必须给出可读错误，而不是崩在 NaN 上
try {
  const empty = new Library({ version: 1, series: [], stats: {} });
  const tl = new ChannelTimeline({ channel: channels.seq, library: empty, tz: TZ });
  tl.resolve(Date.now());
  check(false, '空库应抛错');
} catch (err) {
  check(/没有产出任何节目/.test(err.message), '空库报错信息可读', err.message.slice(0, 40) + '…');
}

// 锚点之前的时刻也要能定位（负偏移）
const tl = new ChannelTimeline({ channel: channels.seq, library, tz: TZ });
const before = tl.resolve(Date.parse('2025-06-01T12:00:00+08:00'));
check(before.startsAt <= Date.parse('2025-06-01T12:00:00+08:00'), '锚点之前的时间也能定位');

/* --------------------------- 日切时间 --------------------------- */

const dayChannel = (dayStart) => ({
  id: `daily-${dayStart.replace(':', '')}`,
  name: `日切 ${dayStart}`,
  mode: 'daily',
  dayStart,
  program: [
    {
      fill: true,
      rule: {
        type: 'daypart',
        slots: [
          { from: '00:00', to: '06:00', label: '深夜', rule: { type: 'shuffle' } },
          { from: '06:00', to: '18:00', label: '白天', rule: { type: 'interleave' } },
          { from: '18:00', to: '24:00', label: '黄金', rule: { type: 'sequential' } },
        ],
      },
    },
  ],
});

for (const dayStart of ['00:00', '06:00', '04:30']) {
  const tl = new ChannelTimeline({ channel: dayChannel(dayStart), library, tz: TZ });
  const probe = Date.parse('2026-06-02T03:00:00+08:00');
  const plan = tl.dayPlan(tl.dayIndexOf(probe));
  const [hh, mm] = dayStart.split(':').map(Number);

  // 播出日的起点应当正好落在配置的时钟点上
  const p = localParts(plan.dayStart, TZ);
  check(p.hour === hh && p.minute === mm, `日切 ${dayStart}：播出日从该时刻开始`, `${p.hour}:${String(p.minute).padStart(2, '0')}`);

  // 03:00 必须落在该播出日内
  check(plan.dayStart <= probe && probe < plan.dayStart + 86400000, `日切 ${dayStart}：03:00 落在该播出日`, new Date(plan.dayStart).toISOString());

  // 覆盖满 24 小时
  const last = plan.entries[plan.entries.length - 1];
  const covered = (last.absStart + last.durationMs - plan.dayStart) / 3600_000;
  check(Math.abs(covered - 24) < 0.05, `日切 ${dayStart}：播出日覆盖 24h`, `${covered.toFixed(2)}h`);

  // 边界之后（+24h + 1s）必须进入下一个播出日
  const after = tl.resolve(plan.dayStart + 86400000 + 1000);
  check(after.startsAt >= plan.dayStart + 86400000, `日切 ${dayStart}：跨越日切点后进入新播出日`);
}


/* --------------------------- 锚点归一化 --------------------------- */

{
  const once = normalizeChannel({
    id: 'anchor-test',
    name: '锚点',
    anchor: '2026-11-23T00:00:00+08:00',
    program: [{ rule: { type: 'sequential' } }],
  });
  const twice = normalizeChannel(once);
  check(once.anchorMs === twice.anchorMs, '锚点归一化两次不丢失', new Date(twice.anchorMs).toISOString());
}

/* --------------------------- 时间网格（grid） --------------------------- */

{
  const pool = library.series.map((x) => x.displayName); // 合成库共 4 部
  const gridChannel = {
    id: 'grid-test',
    name: '网格',
    mode: 'daily',
    anchor: '2026-11-23T00:00:00+08:00', // 周一
    program: [
      {
        fill: true,
        rule: { type: 'grid', start: '20:00', slotMinutes: 30, seriesPerDay: 2, episodesPerSeries: 2, series: pool },
      },
    ],
  };
  const gtl = new ChannelTimeline({ channel: gridChannel, library, tz: TZ });
  const at = (iso) => Date.parse(iso);
  const dayOf = (iso) => gtl.dayPlan(gtl.dayIndexOf(at(iso)));

  const mon = dayOf('2026-11-23T12:00:00+08:00');
  const tue = dayOf('2026-11-24T12:00:00+08:00');
  const wed = dayOf('2026-11-25T12:00:00+08:00');

  check(mon.entries.length === 4, '网格：每天 2 部 × 2 集', mon.entries.length + ' 条');
  check(tue.entries.length === 4, '网格：周二 2 部 × 2 集', tue.entries.length + ' 条');

  const aligned = mon.entries.every((e) => {
    const p = localParts(e.absStart, TZ);
    return p.minute === 0 || p.minute === 30;
  });
  check(aligned, '网格：每集都从整点或半点开始');

  const monSeries = new Set(mon.entries.map((e) => e.episode.seriesName));
  const tueSeries = new Set(tue.entries.map((e) => e.episode.seriesName));
  check(monSeries.size === 2 && tueSeries.size === 2, '网格：每天 2 部');
  check([...monSeries].every((x) => !tueSeries.has(x)), '网格：周二换成另外 2 部');

  const monEps = [...new Set(mon.entries.map((e) => e.episode.episode))];
  check(monEps.includes(1) && monEps.includes(2), '网格：锚点当天从第 1 集开始', monEps.join(','));
  const wedEps = [...new Set(wed.entries.map((e) => e.episode.episode))];
  check(wedEps.includes(3) && wedEps.includes(4), '网格：再次轮到同一部时继续第 3、4 集', wedEps.join(','));

  const gaps = [];
  for (let i = 0; i + 1 < mon.entries.length; i++) {
    const end = mon.entries[i].absStart + mon.entries[i].durationMs;
    const nextStart = mon.entries[i + 1].absStart;
    if (nextStart > end) gaps.push(Math.round((nextStart - end) / 60000));
  }
  check(gaps.length > 0, '网格：不足一格时留空', '空档 ' + gaps.join('/') + ' 分钟');

  const last = mon.entries[mon.entries.length - 1];
  const inGap = gtl.resolve(last.absStart + last.durationMs + 60000);
  check(inGap.off === true, '网格：空档内返回待机');
  check(inGap.nextAt > last.absStart + last.durationMs, '网格：待机时给出下一档时间');

  const playing = gtl.resolve(mon.entries[0].absStart + 60000);
  check(!playing.off && Boolean(playing.episode), '网格：节目内正常定位');

  const items = gtl.schedule(at('2026-11-23T12:00:00+08:00'), at('2026-11-24T12:00:00+08:00'), 100);
  check(items.some((i) => i.kind === 'gap'), '网格：节目单包含留空行');
}

console.log(failures === 0 ? '\n自检全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
