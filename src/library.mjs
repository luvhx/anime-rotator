import fs from 'node:fs';
import path from 'node:path';
import { mapLimit, shortId, formatBytes } from './util.mjs';
import { probeDuration, containerOf } from './probe.mjs';

export const VIDEO_EXTS = new Set([
  'mkv', 'mp4', 'm4v', 'webm', 'mov', 'avi', 'ts', 'm2ts', 'mts', 'wmv', 'flv', 'rmvb', 'rm', 'mpg', 'mpeg', 'iso',
]);
export const SUBTITLE_EXTS = new Set(['ass', 'ssa', 'srt', 'vtt', 'sub']);

const SEASON_DIR_RE = /^(?:season|s|第)?\s*0*(\d{1,2})\s*(?:季|期)?$/i;

/* ------------------------------------------------------------------ *
 * 文件名字段解析
 * ------------------------------------------------------------------ */

/**
 * 从文件名解析季/集/标题。
 * 支持：冰菓 - S01E02 - 标题.mkv / [Group] Name - 02 [1080p].mkv / 第03话.mkv
 */
export function parseEpisodeName(name, fallbackSeason = 1) {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  let season = null;
  let episode = null;
  let title = '';

  const sxe = /S(\d{1,2})\s*[._ ]?E(\d{1,3})(?:v\d)?/i.exec(base);
  if (sxe) {
    season = Number(sxe[1]);
    episode = Number(sxe[2]);
    title = tailAfter(base, sxe.index + sxe[0].length);
  } else {
    const ep = /(?:^|[\s._\-\[【])(?:EP?|第)\s*0*(\d{1,3})(?:\s*[话話集])?/i.exec(base);
    if (ep) {
      episode = Number(ep[1]);
      title = tailAfter(base, ep.index + ep[0].length);
    } else {
      const bare = /(?:^|[\s._\-\[【])0*(\d{1,3})(?:[\s._\]]|$)/.exec(base);
      if (bare) {
        episode = Number(bare[1]);
        title = tailAfter(base, bare.index + bare[0].length);
      }
    }
    const s = /(?:^|[\s._\-\[【])S(?:eason)?\s*0*(\d{1,2})(?:[\s._\]]|$)/i.exec(base);
    if (s) season = Number(s[1]);
  }

  title = cleanTitle(title);
  return {
    season: season ?? fallbackSeason,
    episode,
    title: title || cleanTitle(base),
  };
}

function tailAfter(str, idx) {
  return String(str).slice(idx).replace(/^[\s\-–._]+/, '');
}

function cleanTitle(t) {
  return String(t)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:1080|720|2160|BD|WEB|HEVC|AVC|x26\d|AAC|FLAC)[^)]*\)/gi, ' ')
    .replace(/\b(1080p|720p|2160p|4k|8bit|10bit|hevc|avc|x264|x265|aac|flac|bluray|bdrip|webrip|web-dl|hdr)\b/gi, ' ')
    .replace(/[\s._]+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * 时长缓存
 * ------------------------------------------------------------------ */

export class DurationCache {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.dirty = false;
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [k, v] of Object.entries(raw.entries || raw || {})) this.map.set(k, v);
      } catch {
        /* 缓存损坏则忽略 */
      }
    }
  }

  key(relPath, size) {
    return `${relPath}|${size}`;
  }

  get(relPath, size) {
    return this.map.get(this.key(relPath, size)) || null;
  }

  set(relPath, size, value) {
    this.map.set(this.key(relPath, size), value);
    this.dirty = true;
  }

  save(force = false) {
    if (!this.file || (!this.dirty && !force)) return;
    const entries = Object.fromEntries(this.map);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

/**
 * 递归扫描 WebDAV，构建节目库索引。
 * @param {object} opts
 * @param {import('./webdav.mjs').WebDavClient} opts.dav
 * @param {string} opts.rootRel 动画根目录（相对 baseUrl）
 * @param {string} opts.durationsPath 时长缓存文件
 * @param {number} [opts.concurrency]
 * @param {boolean} [opts.probe] 是否探测时长
 * @param {number} [opts.fallbackDurationMs]
 * @param {(stage:string, done:number, total:number, extra?:string)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function scanLibrary({
  dav,
  rootRel,
  durationsPath,
  concurrency = 6,
  probe = true,
  fallbackDurationMs = 24 * 60 * 1000,
  onProgress = () => {},
  signal,
}) {
  const progress = (stage, done, total, extra) => {
    try {
      onProgress(stage, done, total, extra);
    } catch {
      /* ignore */
    }
  };

  /** @type {Map<string,{season:number, name:string}>} */
  const seasonDirs = new Map();
  /** @type {Array<{relPath:string,name:string,size:number,lastModified:number,seasonDir?:string}>} */
  const rawFiles = [];
  /** 所有文件（含字幕），用于关联同名外挂字幕 */
  const allFiles = [];
  /** @type {Array<{dir:string,name:string}>} */
  const seriesDirs = [];

  progress('list-root', 0, 1, rootRel);
  const rootEntries = await dav.propfind(rootRel, 1);
  for (const e of rootEntries) {
    if (!e.isDir) {
      const ext = e.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
      allFiles.push({ ...e, ext });
      if (ext && VIDEO_EXTS.has(ext)) rawFiles.push({ ...e, seasonDir: '' });
      continue;
    }
    seriesDirs.push({ dir: e.relPath, name: e.name });
  }
  seriesDirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  progress('list-root', 1, 1, `${seriesDirs.length} 个系列目录`);

  // 逐系列列出内容
  let listed = 0;
  await mapLimit(seriesDirs, concurrency, async (s) => {
    if (signal?.aborted) return;
    let entries;
    try {
      entries = await dav.propfind(s.dir, 1);
    } catch (err) {
      progress('list-series-error', listed, seriesDirs.length, `${s.name}: ${err.message}`);
      return;
    }
    for (const e of entries) {
      if (e.isDir) {
        const m = SEASON_DIR_RE.exec(e.name);
        if (m) seasonDirs.set(e.relPath, { season: Number(m[1]), name: e.name });
        else seasonDirs.set(e.relPath, { season: 0, name: e.name }); // 特殊目录（SP/OVA/Movie）
      } else {
        const ext = e.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
        allFiles.push({ ...e, ext });
        if (ext && VIDEO_EXTS.has(ext)) rawFiles.push({ ...e, seasonDir: '' });
      }
    }
    listed++;
    progress('list-series', listed, seriesDirs.length, s.name);
  });

  // 列各季目录
  const seasonList = [...seasonDirs.entries()];
  let seasonsListed = 0;
  await mapLimit(seasonList, concurrency, async ([dir]) => {
    if (signal?.aborted) return;
    try {
      const entries = await dav.propfind(dir, 1);
      for (const e of entries) {
        if (e.isDir) continue;
        const ext = e.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
        allFiles.push({ ...e, ext });
        if (ext && VIDEO_EXTS.has(ext)) rawFiles.push({ ...e, seasonDir: dir });
      }
    } catch (err) {
      progress('list-season-error', seasonsListed, seasonList.length, `${dir}: ${err.message}`);
    }
    seasonsListed++;
    progress('list-season', seasonsListed, seasonList.length, dir);
  });

  // 组装 series -> episodes
  const durations = new DurationCache(durationsPath);
  const seasonMetaByDir = seasonDirs;
  /** @type {Map<string, any>} */
  const seriesMap = new Map();
  const fileIdUsed = new Map();

  for (const f of rawFiles) {
    // 找到所属系列：取 seasonDir 的父目录，或文件自身父目录
    const parent = f.seasonDir || f.relPath.split('/').slice(0, -1).join('/');
    const seriesDir = f.seasonDir ? parent.split('/').slice(0, -1).join('/') : parent;
    const seriesName = seriesDir.split('/').pop();
    let series = seriesMap.get(seriesDir);
    if (!series) {
      series = {
        id: seriesDir,
        dir: seriesDir,
        name: seriesName,
        tmdbId: parseTmdb(seriesName),
        displayName: seriesName.replace(/\s*\{tmdb-\d+\}\s*/, '').trim(),
        episodes: [],
      };
      seriesMap.set(seriesDir, series);
    }
    const seasonInfo = f.seasonDir ? seasonMetaByDir.get(f.seasonDir) : null;
    const parsed = parseEpisodeName(f.name, seasonInfo?.season || 1);
    const season = seasonInfo ? seasonInfo.season : parsed.season;
    const subtitle = findSubtitle(f.relPath, allFiles);
    let fileId = shortId(f.relPath, 10);
    let n = 1;
    while (fileIdUsed.has(fileId) && fileIdUsed.get(fileId) !== f.relPath) {
      fileId = shortId(f.relPath + '#' + n++, 10);
    }
    fileIdUsed.set(fileId, f.relPath);
    series.episodes.push({
      fileId,
      season,
      episode: parsed.episode ?? 0,
      title: parsed.title,
      name: f.name,
      relPath: f.relPath,
      size: f.size,
      lastModified: f.lastModified,
      subtitle,
      container: containerOf(f.relPath),
    });
  }

  // 排序：季 -> 集 -> 文件名
  for (const s of seriesMap.values()) {
    s.episodes.sort(
      (a, b) => a.season - b.season || a.episode - b.episode || a.name.localeCompare(b.name, 'zh-Hans-CN'),
    );
    // 集号缺失时按顺序补齐
    let prev = 0;
    let seasonPrev = -1;
    for (const ep of s.episodes) {
      if (ep.season !== seasonPrev) {
        seasonPrev = ep.season;
        prev = 0;
      }
      if (!ep.episode) ep.episode = prev + 1;
      prev = Math.max(prev, ep.episode);
    }
  }

  // 探测时长
  const all = [...seriesMap.values()].flatMap((s) => s.episodes);
  let probed = 0;
  let estimated = 0;
  const probeQueue = all.filter((ep) => !durations.get(ep.relPath, ep.size));
  progress('probe', 0, probeQueue.length, `共 ${all.length} 个视频`);

  if (probe) {
    await mapLimit(probeQueue, Math.max(2, Math.min(12, concurrency * 2)), async (ep) => {
      if (signal?.aborted) return;
      try {
        const r = await probeDuration(dav, ep.relPath, ep.size);
        if (r) durations.set(ep.relPath, ep.size, { ms: r.durationMs, source: r.source, container: r.container });
      } catch (err) {
        durations.set(ep.relPath, ep.size, { ms: null, source: 'error', error: String(err.message || err) });
      }
      probed++;
      if (probed % 10 === 0) progress('probe', probed, probeQueue.length, ep.name);
      // 定期落盘，避免长时间扫描中断后白跑
      if (probed % 200 === 0) durations.save();
    });
  }

  for (const ep of all) {
    const cached = durations.get(ep.relPath, ep.size);
    if (cached && cached.ms) {
      ep.durationMs = cached.ms;
      ep.durationSource = cached.source;
    } else {
      ep.durationMs = 0;
      ep.durationSource = 'unknown';
    }
  }

  // 兜底推算：优先用同系列已解析时长的中位数，其次按码率估算
  for (const s of seriesMap.values()) {
    const known = s.episodes
      .filter((e) => e.durationMs > 0 && e.durationSource !== 'estimate' && e.durationSource !== 'series-median')
      .map((e) => e.durationMs)
      .sort((a, b) => a - b);
    const median = known.length > 0 ? known[Math.floor(known.length / 2)] : 0;
    for (const ep of s.episodes) {
      if (ep.durationMs > 0) continue;
      if (median > 0) {
        ep.durationMs = median;
        ep.durationSource = 'series-median';
      } else {
        ep.durationMs = estimateDurationMs(ep.size, fallbackDurationMs);
        ep.durationSource = 'estimate';
      }
      estimated++;
    }
  }
  durations.save();

  const series = [...seriesMap.values()].filter((s) => s.episodes.length > 0);
  series.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'));
  const totalMs = series.reduce((acc, s) => acc + s.episodes.reduce((a, e) => a + e.durationMs, 0), 0);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    webdav: { baseUrl: dav.baseUrl, root: rootRel },
    stats: {
      series: series.length,
      episodes: all.length,
      parsed: all.filter((ep) => !/estimate|series-median|unknown/.test(ep.durationSource || '')).length,
      estimated: all.filter((ep) => /estimate|series-median|unknown/.test(ep.durationSource || '')).length,
      probedThisRun: probed,
      totalDurationMs: totalMs,
      totalSize: series.reduce((a, s) => a + s.episodes.reduce((x, e) => x + e.size, 0), 0),
    },
    series,
  };
}

function parseTmdb(name) {
  const m = /\{tmdb-(\d+)\}/.exec(name);
  return m ? Number(m[1]) : null;
}

function findSubtitle(relPath, files) {
  const stem = relPath.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const hit = files.find((f) => {
    if (f.ext && !SUBTITLE_EXTS.has(f.ext)) return false;
    const s = f.relPath.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    return s === stem;
  });
  return hit ? hit.relPath : null;
}

/** 无法探测时按码率估算：假设 2.2 Mbps 视频+音频 */
export function estimateDurationMs(size, fallbackMs = 24 * 60 * 1000) {
  if (!size) return fallbackMs;
  const guess = (size * 8) / (2.2 * 1000 * 1000) * 1000; // ms
  if (!Number.isFinite(guess) || guess < 60 * 1000) return fallbackMs;
  return Math.round(Math.min(guess, 3 * 3600 * 1000));
}

/* ------------------------------------------------------------------ *
 * 库对象
 * ------------------------------------------------------------------ */

/** 正片季在前，Season 0（OVA/SP/剧场版）在后 */
function seasonRank(season) {
  return season === 0 ? 9999 : season;
}

export class Library {
  constructor(data) {
    this.raw = data;
    this.series = data.series || [];
    this.seriesById = new Map(this.series.map((s) => [s.id, s]));
    this.seriesByName = new Map();
    this.episodes = [];
    this.byFileId = new Map();
    for (const s of this.series) {
      // 播放顺序约定：正片季优先，Season 0（OVA/SP）排在最后
      s.episodes.sort(
        (a, b) =>
          seasonRank(a.season) - seasonRank(b.season) ||
          a.episode - b.episode ||
          a.name.localeCompare(b.name, 'zh-Hans-CN'),
      );
      this.seriesByName.set(s.displayName, s);
      this.seriesByName.set(s.name, s);
      for (const ep of s.episodes) {
        const full = { ...ep, seriesId: s.id, seriesName: s.displayName, seriesDir: s.dir, tmdbId: s.tmdbId, seriesRef: s };
        this.episodes.push(full);
        this.byFileId.set(ep.fileId, full);
        s.__full = s.__full || [];
        s.__full.push(full);
      }
    }
    this.stats = { ...(data.stats || {}) };
    if (this.stats.parsed == null) {
      this.stats.parsed = this.episodes.filter((e) => e.durationSource !== 'estimate').length;
      this.stats.estimated = this.episodes.length - this.stats.parsed;
    }
  }

  /** 空库（首次启动、尚未扫描时使用） */
  static empty() {
    return new Library({ version: 1, series: [], stats: {} });
  }

  static load(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Library(data);
  }

  /** 重新加载索引文件（重扫后热更新，不用重启服务） */
  reload(file) {
    const fresh = Library.load(file);
    this.raw = fresh.raw;
    this.series = fresh.series;
    this.seriesById = fresh.seriesById;
    this.seriesByName = fresh.seriesByName;
    this.episodes = fresh.episodes;
    this.byFileId = fresh.byFileId;
    this.stats = fresh.stats;
    return this;
  }

  /** 某系列的全部剧集（含每集扩展字段） */
  episodesOf(seriesId) {
    return this.seriesById.get(seriesId)?.__full || [];
  }

  findSeries(query) {
    if (!query) return null;
    const q = String(query).trim();
    return this.seriesById.get(q) || this.seriesByName.get(q) || this.series.find((s) => s.displayName === q) || null;
  }

  /** 支持 series:/name: 前缀的模糊匹配 */
  resolve(selector) {
    if (!selector) return [];
    const raw = String(selector).trim();
    if (raw.startsWith('series:')) {
      const s = this.findSeries(raw.slice(7));
      return s ? [s] : [];
    }
    const exact = this.findSeries(raw);
    if (exact) return [exact];
    const lower = raw.toLowerCase();
    return this.series.filter((s) => s.displayName.toLowerCase().includes(lower) || s.name.toLowerCase().includes(lower));
  }

  getEpisode(fileId) {
    return this.byFileId.get(fileId) || null;
  }
}

export { formatBytes };
