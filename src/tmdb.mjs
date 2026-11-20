import fs from 'node:fs';
import path from 'node:path';

/**
 * 轻量 TMDB 客户端
 * ------------------------------------------------------------------
 * - 支持 v3 api_key 与 v4 read access token（JWT）
 * - 中文优先（language=zh-CN），缺失时回退原语言字段
 * - 磁盘缓存 data/tmdb-cache.json（默认 7 天）
 * - 未配置 key 时 enabled=false，调用方静默降级
 */

const API_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** 全角标点 / 空白归一，便于中文标题匹配 */
export function normalizeTitle(input) {
  return String(input || '')
    .replace(/\{tmdb-\d+\}/g, '')
    .replace(/[：:]/g, ':')
    .replace(/[！!]/g, '!')
    .replace(/[？?]/g, '?')
    .replace(/[，,]/g, ',')
    .replace(/[（）()]/g, '')
    .replace(/[·・]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .trim()
    .toLowerCase();
}

/** 0~1 相似度：最长公共子序列长度 / 平均长度 */
export function similarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const dp = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let prev = 0;
    for (let j = 1; j <= y.length; j++) {
      const tmp = dp[j];
      dp[j] = x[i - 1] === y[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return (2 * dp[y.length]) / (x.length + y.length);
}

export class TmdbClient {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]    v3 key
   * @param {string} [opts.readToken] v4 read token
   * @param {string} [opts.language]
   * @param {string} [opts.cacheFile]
   * @param {number} [opts.ttlMs]
   */
  constructor({
    apiKey = '',
    readToken = '',
    language = 'zh-CN',
    cacheFile = null,
    ttlMs = 7 * 86400_000,
    baseUrl = 'https://api.themoviedb.org/3',
    concurrency = 4,
    minIntervalMs = 120,
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.readToken = String(readToken || '').trim();
    this.language = language || 'zh-CN';
    this.cacheFile = cacheFile;
    this.ttlMs = ttlMs;
    this.memory = new Map();
    this.dirty = false;
    this.lastError = null;
    this.baseUrl = String(baseUrl || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
    this.concurrency = Math.max(1, Number(concurrency) || 4);
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0); // 相邻请求最小间隔
    this._lastAt = 0;
    this._inflight = 0;
    this._waiters = [];
    this._genres = null;
    this._load();
  }

  get enabled() {
    return Boolean(this.apiKey || this.readToken);
  }

  get mode() {
    if (this.readToken) return 'v4-token';
    if (this.apiKey) return 'v3-key';
    return 'off';
  }

  /* ------------------------------ 缓存 ------------------------------ */

  _load() {
    if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const [k, v] of Object.entries(raw.entries || {})) this.memory.set(k, v);
    } catch {
      /* 缓存损坏忽略 */
    }
  }

  save(force = false) {
    if (!this.cacheFile || (!this.dirty && !force)) return;
    const now = Date.now();
    const entries = {};
    for (const [k, v] of this.memory) {
      if (now - v.t < this.ttlMs) entries[k] = v;
    }
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, this.cacheFile);
    this.dirty = false;
  }

  _cached(key) {
    const hit = this.memory.get(key);
    if (!hit) return null;
    if (Date.now() - hit.t > this.ttlMs) return null;
    return hit.v;
  }

  _store(key, value) {
    this.memory.set(key, { t: Date.now(), v: value });
    this.dirty = true;
    if (this.memory.size % 20 === 0) this.save();
  }

  /* ------------------------------ 请求 ------------------------------ */

  async _fetch(pathname, params = {}) {
    const url = new URL(this.baseUrl + pathname);
    url.searchParams.set('language', params.language || this.language);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || k === 'language') continue;
      url.searchParams.set(k, String(v));
    }
    const headers = { Accept: 'application/json' };
    if (this.readToken) headers.Authorization = `Bearer ${this.readToken}`;
    else url.searchParams.set('api_key', this.apiKey);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      if (res.status === 401) {
        this.lastError = 'TMDB 认证失败：请检查 api key / read token';
        throw Object.assign(new Error(this.lastError), { status: 401 });
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
      this.lastError = null;
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async _acquire() {
    if (this._inflight < this.concurrency) {
      this._inflight++;
      return;
    }
    await new Promise((resolve) => this._waiters.push(resolve));
    this._inflight++;
  }

  _release() {
    this._inflight--;
    const next = this._waiters.shift();
    if (next) next();
  }

  /**
   * 并发限流 + 最小间隔的请求调度。
   * 之前是「全局串行 + 260ms 间隔」，158 部剧要 80 秒起步；现在 4 并发、120ms 间隔。
   */
  async _enqueue(fn) {
    await this._acquire();
    try {
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this._lastAt));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastAt = Date.now();
      return await fn();
    } finally {
      this._release();
    }
  }

  /* ------------------------------ 接口 ------------------------------ */

  /** 电视类型 id → 名称（缓存，整轮同步只查一次） */
  async tvGenres() {
    if (this._genres) return this._genres;
    const key = 'genres:tv';
    let list = this._cached(key);
    if (!list) {
      const data = await this._enqueue(() => this._fetch('/genre/tv/list'));
      list = (data?.genres || []).map((g) => ({ id: g.id, name: g.name }));
      this._store(key, list);
    }
    this._genres = new Map(list.map((g) => [g.id, g.name]));
    return this._genres;
  }

  async searchTv(query, { year } = {}) {
    const q = String(query || '').trim();
    if (!q || !this.enabled) return [];
    const key = `search:${q}:${year || ''}`;
    const cached = this._cached(key);
    if (cached) return cached;
    const data = await this._enqueue(() =>
      this._fetch('/search/tv', { query: q, year, include_adult: 'false' }),
    );
    const genreMap = await this.tvGenres().catch(() => new Map());
    const results = (data?.results || []).slice(0, 8).map((r) => ({
      id: r.id,
      name: r.name,
      originalName: r.original_name,
      year: (r.first_air_date || '').slice(0, 4),
      overview: r.overview || '',
      poster: r.poster_path ? this.posterUrl(r.poster_path) : null,
      popularity: r.popularity || 0,
      vote: r.vote_average || 0,
      genres: (r.genre_ids || []).map((id) => genreMap.get(id)).filter(Boolean),
      score: Math.max(similarity(query, r.name), similarity(query, r.original_name || '')),
    }));
    this._store(key, results);
    return results;
  }

  /** 用标题自动匹配（带相似度评分） */
  async matchSeries(name) {
    if (!this.enabled) return { status: 'disabled' };
    const results = await this.searchTv(name);
    if (results.length === 0) return { status: 'none' };
    const best = results.reduce((a, b) => (b.score > a.score ? b : a), results[0]);
    return { status: best.score >= 0.55 ? 'matched' : 'low-confidence', best, candidates: results };
  }

  async tvDetails(id) {
    if (!this.enabled || !id) return null;
    const key = `tv:${id}`;
    const cached = this._cached(key);
    if (cached) return cached;
    const data = await this._enqueue(() => this._fetch(`/tv/${id}`));
    if (!data) return null;
    const out = {
      id: data.id,
      name: data.name,
      originalName: data.original_name,
      overview: data.overview || '',
      year: (data.first_air_date || '').slice(0, 4),
      poster: data.poster_path ? this.posterUrl(data.poster_path) : null,
      backdrop: data.backdrop_path ? this.posterUrl(data.backdrop_path, 'w780') : null,
      vote: data.vote_average || 0,
      status: data.status || '',
      genres: (data.genres || []).map((g) => g.name),
      numberOfSeasons: data.number_of_seasons || 0,
      numberOfEpisodes: data.number_of_episodes || 0,
      seasons: (data.seasons || []).map((s) => ({
        season: s.season_number,
        name: s.name,
        episodes: s.episode_count,
        poster: s.poster_path ? this.posterUrl(s.poster_path) : null,
        year: (s.air_date || '').slice(0, 4),
      })),
    };
    this._store(key, out);
    return out;
  }

  async seasonEpisodes(id, seasonNumber) {
    if (!this.enabled || !id) return [];
    const key = `season:${id}:${seasonNumber}`;
    const cached = this._cached(key);
    if (cached) return cached;
    const data = await this._enqueue(() => this._fetch(`/tv/${id}/season/${seasonNumber}`));
    const list = (data?.episodes || []).map((e) => ({
      episode: e.episode_number,
      season: e.season_number,
      name: e.name || '',
      overview: e.overview || '',
      airDate: e.air_date || '',
      still: e.still_path ? this.posterUrl(e.still_path, 'w300') : null,
      vote: e.vote_average || 0,
      runtime: e.runtime || 0,
    }));
    this._store(key, list);
    return list;
  }

  /** 测试 key 是否可用 */
  async test() {
    if (!this.enabled) return { ok: false, message: '未配置 api key 或 read token' };
    try {
      const data = await this._enqueue(() => this._fetch('/configuration'));
      return { ok: true, message: 'TMDB 连接正常', images: Boolean(data?.images) };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  posterUrl(p, size = 'w300') {
    if (!p) return null;
    if (/^https?:\/\//.test(p)) return p;
    return `${IMAGE_BASE}/${size}${p.startsWith('/') ? '' : '/'}${p}`;
  }
}
