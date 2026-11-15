#!/usr/bin/env node
/**
 * 扫描 WebDAV 动画库，生成 data/library.json（含时长）。
 *
 *   node src/cli/scan.mjs [--config config.json] [--no-probe] [--concurrency 8] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { WebDavClient } from '../webdav.mjs';
import { scanLibrary } from '../library.mjs';
import { fmtDuration, formatBytes } from '../util.mjs';

function parseArgs(argv) {
  const out = { config: null, probe: true, concurrency: null, quiet: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') out.config = argv[++i];
    else if (a === '--no-probe') out.probe = false;
    else if (a === '--probe') out.probe = true;
    else if (a === '--concurrency' || a === '-j') out.concurrency = Number(argv[++i]);
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node src/cli/scan.mjs [--config 配置] [--no-probe] [--concurrency N] [--out 文件] [--quiet]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
const dav = new WebDavClient(config.webdav);
const rootRel = config.webdav.root || '';
const outFile = args.out ? path.resolve(args.out) : config.paths.library;

const t0 = Date.now();
let lastLine = '';

function onProgress(stage, done, total, extra) {
  if (args.quiet) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const line = `[${stage}] ${done}/${total} ${total ? `(${pct}%)` : ''} ${extra || ''}`;
  if (line === lastLine) return;
  lastLine = line;
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line}`);
  else if (done === total || done % 25 === 0) process.stderr.write(line + '\n');
}

console.log(`扫描 ${dav.baseUrl}/${rootRel}`);
console.log(`时长探测: ${args.probe ? '开启（解析 MKV/MP4 容器头）' : '关闭（按码率估算）'}`);

const data = await scanLibrary({
  dav,
  rootRel,
  durationsPath: config.paths.durations,
  concurrency: args.concurrency || 6,
  probe: args.probe,
  fallbackDurationMs: config.library.fallbackDurationMs,
  onProgress,
});

const outDir = path.dirname(outFile);
fs.mkdirSync(outDir, { recursive: true });
const tmp = outFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
fs.renameSync(tmp, outFile);

const s = data.stats;
console.log('');
console.log(`✓ 索引已写入 ${path.relative(process.cwd(), outFile) || outFile}`);
console.log(`  系列 ${s.series} 部 / 剧集 ${s.episodes} 集`);
console.log(`  总时长 ${fmtDuration(s.totalDurationMs)}（约 ${(s.totalDurationMs / 86400000).toFixed(1)} 天）`);
console.log(`  总容量 ${formatBytes(s.totalSize)}`);
console.log(`  时长来源：容器解析 ${s.parsed} 集，估算 ${s.estimated} 集${s.probedThisRun ? `（本次探测 ${s.probedThisRun} 集）` : '（全部命中缓存）'}`);
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (s.estimated > 0) {
  console.log('  提示：估算时长的剧集会影响时间轴精度，可重新运行 npm run scan 补齐（有缓存的不会重复探测）');
}
