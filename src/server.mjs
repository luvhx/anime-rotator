import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebDavClient } from './webdav.mjs';
import { Library, DurationCache } from './library.mjs';
import { ChannelTimeline, episodeView } from './scheduler.mjs';
import { buildFileUrl, sendRedirect, proxyFile } from './stream.mjs';
import { dayStartMs, localParts, fmtDuration, toMs } from './util.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 构建应用
 * @param {object} config 已校验配置
 */
export function createApp(config) {
  const dav = new WebDavClient(config.webdav);
  const library = Library.load(config.paths.library);
  /** @type {Map<string,ChannelTimeline>} */
  const timelines = new Map();
  const channelsById = new Map(config.channels.map((c) => [c.id, c]));

  function getTimeline(channelId) {
    const id = channelId || config.channels[0].id;
    let tl = timelines.get(id);
    if (tl) return tl;
    const def = channelsById.get(id);
    if (!def) throw new HttpError(404, `频道不存在：${id}`);
    tl = new ChannelTimeline({ channel: def, library, tz: config.timezone });
    timelines.set(id, tl);
    return tl;
  }

  /* ---------------------------- 视图 ---------------------------- */

  const streamConfig = config.stream;

  function directUrlOf(ep, prefixOverride) {
    return buildFileUrl({
      prefix: prefixOverride || streamConfig.urlPrefix,
      relPath: ep.relPath,
      root: config.webdav.root,
      token: streamConfig.token,
      embedCredentials: streamConfig.embedCredentials,
      dav,
    });
  }

  function streamUrlOf(ep, opts = {}) {
    if (opts.preferDirect) return directUrlOf(ep, opts.prefix);
    return `/stream/${ep.fileId}`;
  }

  function clockText(ms) {
    const p = localParts(ms, config.timezone);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }

  function programView(item, opts = {}) {
    const ep = item.episode;
    const view = episodeView(ep);
    return {
      ...view,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      durationMs: item.durationMs,
      durationText: fmtDuration(item.durationMs),
      truncated: Boolean(item.truncated),
      segmentLabel: item.segmentLabel || null,
      startText: clockText(item.startsAt),
      endText: clockText(item.endsAt),
      streamUrl: streamUrlOf(ep, opts),
      directUrl: directUrlOf(ep, opts.prefix),
    };
  }

  function channelSummary(def) {
    let stats = null;
    let error = null;
    try {
      stats = getTimeline(def.id).stats();
    } catch (err) {
      error = err.message;
    }
    return {
      id: def.id,
      name: def.name,
      description: def.description || '',
      mode: def.mode,
      stats,
      error,
    };
  }

  /* ---------------------------- API ---------------------------- */

  function apiNow(url, res) {
    const channelId = url.searchParams.get('channel') || config.channels[0].id;
    const tl = getTimeline(channelId);
    const now = Date.now();
    const resolved = tl.resolve(now);
    const preferDirect = url.searchParams.get('mode') === 'direct';
    const opts = { preferDirect, prefix: url.searchParams.get('prefix') || null };

    const current = programView(
      {
        episode: resolved.episode,
        startsAt: resolved.startsAt,
        endsAt: resolved.endsAt,
        durationMs: resolved.durationMs,
        truncated: resolved.truncated,
        segmentLabel: resolved.segmentLabel,
      },
      opts,
    );

    const upcoming = tl.schedule(now, now + 36 * 3600 * 1000, 40).filter((i) => i.startsAt > now);
    const next = upcoming.slice(0, 12).map((i) => programView(i, opts));

    return json(res, {
      serverTime: now,
      timezone: config.timezone,
      channel: { id: tl.channel.id, name: tl.channel.name, description: tl.channel.description, mode: tl.channel.mode },
      now: {
        ...current,
        offsetMs: resolved.offsetMs,
        remainingMs: resolved.remainingMs,
        progress: resolved.progress,
      },
      next,
      stream: { mode: streamConfig.mode, urlPrefix: streamConfig.urlPrefix },
    });
  }

  function apiSchedule(url, res) {
    const channelId = url.searchParams.get('channel') || config.channels[0].id;
    const tl = getTimeline(channelId);
    let from;
    let to;
    const date = url.searchParams.get('date');
    if (date) {
      const [y, m, d] = date.split('-').map(Number);
      if (!y || !m || !d) throw new HttpError(400, 'date 参数格式应为 YYYY-MM-DD');
      const dayIdx = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
      from = dayStartMs(dayIdx, config.timezone);
      to = from + 86400000;
    } else {
      from = url.searchParams.has('from') ? toMs(url.searchParams.get('from')) : Date.now();
      to = url.searchParams.has('to') ? toMs(url.searchParams.get('to')) : from + 6 * 3600 * 1000;
    }
    if (to <= from) throw new HttpError(400, 'to 必须晚于 from');
    if (to - from > 32 * 86400000) throw new HttpError(400, '时间窗口过大（最多 32 天）');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 40));
    const items = tl.schedule(from, to, limit);
    return json(res, {
      serverTime: Date.now(),
      timezone: config.timezone,
      channel: { id: tl.channel.id, name: tl.channel.name },
      from,
      to,
      count: items.length,
      items: items.map((i) =>
        programView(i, {
          preferDirect: url.searchParams.get('mode') === 'direct',
          prefix: url.searchParams.get('prefix') || null,
        }),
      ),
    });
  }

  async function apiReportDuration(req, res) {
    const body = await readJson(req);
    const fileId = String(body.fileId || '');
    const durationMs = Number(body.durationMs);
    if (!fileId || !Number.isFinite(durationMs)) throw new HttpError(400, '需要 fileId 与 durationMs');
    if (durationMs < 30 * 1000 || durationMs > 12 * 3600 * 1000) throw new HttpError(400, 'durationMs 超出合理范围');
    const ep = library.getEpisode(fileId);
    if (!ep) throw new HttpError(404, `未知 fileId：${fileId}`);
    const suspiciousSource = /estimate|series-median|unknown/.test(ep.durationSource || '');
    const ratio = ep.durationMs > 0 ? durationMs / ep.durationMs : 1;
    // 索引时长来自容器解析时，只在 0.6x ~ 1.4x 内接受客户端回写，避免被异常播放器带偏时间轴
    if (!suspiciousSource && (ratio < 0.6 || ratio > 1.4)) {
      return json(res, {
        ok: false,
        ignored: true,
        reason: 'outlier',
        durationMs: ep.durationMs,
        reported: Math.round(durationMs),
        note: '客户端上报时长与容器解析值差异过大，已忽略',
      });
    }
    const diff = Math.abs(ep.durationMs - durationMs);
    ep.durationMs = Math.round(durationMs);
    ep.durationSource = 'client';
    const cache = new DurationCache(config.paths.durations);
    cache.set(ep.relPath, ep.size, { ms: ep.durationMs, source: 'client', container: ep.container });
    cache.save(true);
    if (diff > 3000) timelines.clear(); // 时长变化较大时重建时间轴
    return json(res, { ok: true, fileId, durationMs: ep.durationMs, corrected: diff > 1000, invalidated: diff > 3000 });
  }

  function apiLibrary(url, res) {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    const list = library.series
      .filter((s) => !q || s.displayName.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        name: s.displayName,
        tmdbId: s.tmdbId,
        episodes: s.episodes.length,
        seasons: [...new Set(s.episodes.map((e) => e.season))].sort((a, b) => a - b),
        durationMs: s.episodes.reduce((a, e) => a + e.durationMs, 0),
        size: s.episodes.reduce((a, e) => a + e.size, 0),
      }));
    return json(res, { total: library.series.length, matches: list.length, series: list });
  }

  function apiStream(req, res, url, fileId) {
    const ep = library.getEpisode(fileId);
    if (!ep) throw new HttpError(404, `未知文件：${fileId}`);
    if (streamConfig.mode === 'proxy') {
      return proxyFile(req, res, { dav, relPath: ep.relPath, extraHeaders: streamConfig.headers }).catch((err) => {
        if (!res.headersSent) json(res, { error: err.message }, 502);
        else res.destroy();
      });
    }
    const location = buildFileUrl({
      prefix: url.searchParams.get('prefix') || streamConfig.urlPrefix,
      relPath: ep.relPath,
      root: config.webdav.root,
      token: streamConfig.token,
      embedCredentials: streamConfig.embedCredentials,
      dav,
    });
    return sendRedirect(res, location);
  }

  /* ---------------------------- 路由 ---------------------------- */

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Range',
          'Access-Control-Max-Age': '86400',
        });
        return res.end();
      }

      if (pathname === '/api/health') {
        return json(res, {
          ok: true,
          serverTime: Date.now(),
          library: { series: library.series.length, episodes: library.episodes.length, generatedAt: library.stats?.generatedAt || null, stats: library.stats },
          channels: config.channels.map((c) => c.id),
        });
      }

      if (pathname === '/api/config') {
        return json(res, {
          serverTime: Date.now(),
          timezone: config.timezone,
          stream: { mode: streamConfig.mode, urlPrefix: streamConfig.urlPrefix },
          channels: config.channels.map((c) => ({ id: c.id, name: c.name, description: c.description, mode: c.mode })),
          library: { series: library.series.length, episodes: library.episodes.length },
        });
      }

      if (pathname === '/api/channels') {
        return json(res, { channels: config.channels.map(channelSummary) });
      }

      if (pathname === '/api/now') return apiNow(url, res);
      if (pathname === '/api/schedule') return apiSchedule(url, res);
      if (pathname === '/api/library') return apiLibrary(url, res);
      if (pathname === '/api/report-duration' && req.method === 'POST') return await apiReportDuration(req, res);

      if (pathname === '/api/reload' && req.method === 'POST') {
        if (!fs.existsSync(config.paths.library)) throw new HttpError(409, '索引文件不存在，请先执行 scan');
        library.reload(config.paths.library);
        timelines.clear();
        return json(res, { ok: true, series: library.series.length, episodes: library.episodes.length });
      }

      if (pathname.startsWith('/stream/')) {
        const fileId = pathname.slice('/stream/'.length);
        return apiStream(req, res, url, fileId);
      }

      if (pathname.startsWith('/api/')) throw new HttpError(404, `未知接口：${pathname}`);

      return serveStatic(res, config.server.publicDir, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[${req.method} ${pathname}]`, err);
      if (!res.headersSent) json(res, { error: err.message, status }, status);
      else res.destroy();
    } finally {
      if (process.env.LOG_REQUESTS) {
        console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  return { server, library, timelines, dav };
}

/* ---------------------------- 工具 ---------------------------- */

function json(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new HttpError(413, '请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, publicDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(publicDir, rel);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(publicDir))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

export { HttpError };
