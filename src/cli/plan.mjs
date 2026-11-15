#!/usr/bin/env node
/**
 * 预览 / 调试播出时间表（不启动 HTTP 服务）
 *
 *   node src/cli/plan.mjs --channel main --hours 6
 *   node src/cli/plan.mjs --channel daily --date 2026-11-15
 *   node src/cli/plan.mjs --channel mix --at "2026-11-15T21:30:00+08:00"
 *   node src/cli/plan.mjs --stats
 */
import { loadConfig } from '../config.mjs';
import { Library } from '../library.mjs';
import { ChannelTimeline } from '../scheduler.mjs';
import { dayStartMs, fmtDuration, fmtLocal, toMs, formatBytes } from '../util.mjs';

function parseArgs(argv) {
  const out = { config: null, channel: null, hours: 6, date: null, at: null, limit: 30, stats: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') out.config = argv[++i];
    else if (a === '--channel' || a === '-ch') out.channel = argv[++i];
    else if (a === '--hours' || a === '-h2') out.hours = Number(argv[++i]);
    else if (a === '--date' || a === '-d') out.date = argv[++i];
    else if (a === '--at' || a === '-t') out.at = argv[++i];
    else if (a === '--limit' || a === '-n') out.limit = Number(argv[++i]);
    else if (a === '--stats') out.stats = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help') {
      console.log('用法: node src/cli/plan.mjs [--channel id] [--hours N | --date YYYY-MM-DD | --at ISO] [--limit N] [--stats] [--json]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
if (!config.webdav.baseUrl) {
  console.error('✗ 还没有配置 WebDAV 地址：先运行 npm start 打开 /admin 完成配置');
  process.exit(1);
}
const library = Library.load(config.paths.library);

if (args.stats) {
  console.log(`节目库：${library.series.length} 部 / ${library.episodes.length} 集 / ${formatBytes(library.episodes.reduce((a, e) => a + e.size, 0))}`);
  console.log(`总时长：${fmtDuration(library.episodes.reduce((a, e) => a + e.durationMs, 0))}`);
  for (const ch of config.channels) {
    const tl = new ChannelTimeline({ channel: ch, library, tz: config.timezone });
    try {
      const st = tl.stats();
      const len = st.mode === 'daily' ? `${st.dayEntries} 条/天` : `${st.cycleEntries} 条 ≈ ${(st.cycleDurationMs / 86400000).toFixed(2)} 天`;
      console.log(`  ${ch.id.padEnd(8)} ${ch.name.padEnd(10)} [${st.mode}] ${len}  池 ${st.poolSeries} 部/${st.poolEpisodes} 集`);
    } catch (err) {
      console.log(`  ${ch.id.padEnd(8)} ${ch.name.padEnd(10)} ✗ ${err.message}`);
    }
  }
  process.exit(0);
}

const channelId = args.channel || config.channels[0].id;
const def = config.channels.find((c) => c.id === channelId);
if (!def) {
  console.error(`频道不存在：${channelId}（可用：${config.channels.map((c) => c.id).join(', ')}）`);
  process.exit(1);
}
const tl = new ChannelTimeline({ channel: def, library, tz: config.timezone });
const tz = config.timezone;

const atMs = args.at ? toMs(args.at) : Date.now();
const resolved = tl.resolve(atMs);

console.log(`频道 ${def.name} (${def.id})  模式 ${def.mode}  时区 ${tz}`);
console.log(`当前时刻 ${fmtLocal(atMs, tz)}  →  ${resolved.episode.seriesName} S${String(resolved.episode.season).padStart(2, '0')}E${String(resolved.episode.episode).padStart(2, '0')} ${resolved.episode.title}`);
console.log(`  进度 ${fmtDuration(resolved.offsetMs)} / ${fmtDuration(resolved.durationMs)}（${(resolved.progress * 100).toFixed(1)}%），剩余 ${fmtDuration(resolved.remainingMs)}${resolved.truncated ? ' [跨零点截断]' : ''}`);
console.log(`  文件 ${resolved.episode.relPath}`);
console.log('');

let from;
let to;
if (args.date) {
  const [y, m, d] = args.date.split('-').map(Number);
  const day = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  from = dayStartMs(day, tz);
  to = from + 86400000;
} else {
  from = atMs;
  to = atMs + args.hours * 3600000;
}

const items = tl.schedule(from, to, args.limit);
if (args.json) {
  console.log(JSON.stringify(items, null, 2));
  process.exit(0);
}
console.log(`${fmtLocal(from, tz)} 起的节目单：`);
for (const it of items) {
  const live = atMs >= it.startsAt && atMs < it.endsAt ? '▶' : ' ';
  const ep = it.episode;
  console.log(
    `${live} ${fmtLocal(it.startsAt, tz)} - ${fmtDuration(it.durationMs).padStart(6)}  ${ep.seriesName} S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}${ep.title ? ' ' + ep.title : ''}${it.truncated ? ' [截断]' : ''}`,
  );
}
console.log('');
console.log(`共 ${items.length} 条，覆盖 ${fmtDuration(items.reduce((a, i) => a + i.durationMs, 0))}`);
