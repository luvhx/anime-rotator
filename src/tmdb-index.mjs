import fs from 'node:fs';
import path from 'node:path';

/**
 * TMDB 信息索引
 * ------------------------------------------------------------------
 * 把每部剧的 TMDB 元数据（年份、评分、类型、状态、海报…）落在
 * data/tmdb-index.json 里，这样：
 *   - 管理界面可以按年份/评分/类型筛选
 *   - 频道编排可以按 TMDB 条件选片（时间轴构建是同步的，必须查本地索引）
 *
 * 同步走 TMDB 客户端自带的磁盘缓存，重复同步很快。
 */

export class TmdbIndex {
  /**
   * @param {object} opts
   * @param {string} opts.file
   * @param {import('./tmdb.mjs').TmdbClient} opts.tmdb
   * @param {number} [opts.ttlMs]  多久算过期（默认 30 天）
   */
  constructor({ file, tmdb = null, ttlMs = 30 * 86400_000 } = {}) {
    this.file = file;
    this.tmdb = tmdb;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.#load();
  }

  #load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw.entries || {})) this.map.set(k, v);
    } catch {
      /* 索引损坏忽略 */
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.map) }));
    fs.renameSync(tmp, this.file);
  }

  get(seriesId) {
    return this.map.get(seriesId) || null;
  }

  set(seriesId, entry) {
    this.map.set(seriesId, { ...entry, at: entry.at || Date.now() });
  }

  isStale(seriesId) {
    const e = this.map.get(seriesId);
    if (!e) return true;
    return Date.now() - (e.at || 0) > this.ttlMs;
  }

  stats(total) {
    let matched = 0;
    let unmatched = 0;
    for (const v of this.map.values()) {
      if (v.tmdbId) matched++;
      else unmatched++;
    }
    return { total: total ?? this.map.size, matched, unmatched, entries: this.map.size };
  }

  /** 类型分布（用于筛选下拉） */
  facets(seriesList) {
    const genres = new Map();
    const years = new Map();
    let matched = 0;
    let unmatched = 0;
    for (const s of seriesList) {
      const e = this.map.get(s.id);
      if (!e || !e.tmdbId) {
        unmatched++;
        continue;
      }
      matched++;
      for (const g of e.genres || []) genres.set(g, (genres.get(g) || 0) + 1);
      if (e.year) years.set(e.year, (years.get(e.year) || 0) + 1);
    }
    return {
      matched,
      unmatched,
      genres: [...genres.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      years: [...years.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year),
    };
  }

  /**
   * 按 TMDB 条件筛选
   * @param {object[]} seriesList
   * @param {{yearFrom?:number,yearTo?:number,minVote?:number,genres?:string[],requireMatch?:boolean}} filter
   */
  filterSeries(seriesList, filter = {}) {
    const active =
      filter &&
      (filter.yearFrom || filter.yearTo || filter.minVote || (filter.genres && filter.genres.length) || filter.requireMatch);
    if (!active) return seriesList;
    const genres = (filter.genres || []).map((g) => String(g).toLowerCase());
    return seriesList.filter((s) => {
      const e = this.map.get(s.id);
      // 有筛选条件时，没拿到 TMDB 信息的剧无法判断是否命中，直接排除
      if (!e || !e.tmdbId) return false;
      if (filter.yearFrom && (!e.year || Number(e.year) < Number(filter.yearFrom))) return false;
      if (filter.yearTo && (!e.year || Number(e.year) > Number(filter.yearTo))) return false;
      if (filter.minVote && (!e.vote || e.vote < Number(filter.minVote))) return false;
      if (genres.length > 0) {
        const own = (e.genres || []).map((g) => String(g).toLowerCase());
        if (!genres.some((g) => own.includes(g))) return false;
      }
      return true;
    });
  }

  /**
   * 同步一部剧的 TMDB 信息
   * @param {object} series 库里的系列对象
   */
  async syncSeries(series, { force = false } = {}) {
    if (!this.tmdb?.enabled) return null;
    if (!force && !this.isStale(series.id)) return this.map.get(series.id);

    // 1) 目录名里带 {tmdb-ID}：直接查详情
    if (series.tmdbId) {
      const details = await this.tmdb.tvDetails(series.tmdbId).catch(() => null);
      if (!details) {
        this.set(series.id, { tmdbId: series.tmdbId, source: 'tag', error: 'details-failed' });
        return this.map.get(series.id);
      }
      this.set(series.id, {
        tmdbId: details.id,
        name: details.name,
        originalName: details.originalName,
        year: details.year,
        vote: details.vote,
        genres: details.genres || [],
        status: details.status,
        poster: details.poster,
        overview: details.overview,
        seasons: details.numberOfSeasons,
        episodes: details.numberOfEpisodes,
        source: 'tag',
      });
      return this.map.get(series.id);
    }

    // 2) 按中文名搜索匹配：搜索结果已包含年份/评分/类型/海报，省掉一次详情请求
    const match = await this.tmdb.matchSeries(series.displayName || series.name).catch(() => null);
    if (!match || (match.status !== 'matched' && match.status !== 'low-confidence') || !match.best) {
      this.set(series.id, { tmdbId: null, source: 'none' });
      return this.map.get(series.id);
    }
    const best = match.best;
    this.set(series.id, {
      tmdbId: best.id,
      name: best.name,
      originalName: best.originalName,
      year: best.year,
      vote: best.vote,
      genres: best.genres || [],
      poster: best.poster,
      overview: best.overview,
      source: match.status === 'matched' ? 'auto' : 'low-confidence',
    });
    return this.map.get(series.id);
  }

  /**
   * 批量同步（带进度）
   * @param {object[]} seriesList
   * @param {{onProgress?:Function, concurrency?:number, force?:boolean}} opts
   */
  async syncAll(seriesList, { onProgress = () => {}, concurrency = 4, force = false } = {}) {
    if (!this.tmdb?.enabled) throw new Error('还没有配置 TMDB API Key');
    let done = 0;
    let failed = 0;
    const queue = seriesList.slice();
    const worker = async () => {
      while (queue.length > 0) {
        const series = queue.shift();
        try {
          await this.syncSeries(series, { force });
        } catch {
          failed++;
        }
        done++;
        if (done % 5 === 0 || done === seriesList.length) {
          onProgress(done, seriesList.length, series.displayName, failed);
          if (done % 20 === 0) this.save();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    this.save();
    if (this.tmdb?.dirty) this.tmdb.save();
    return { done, failed, total: seriesList.length };
  }
}
