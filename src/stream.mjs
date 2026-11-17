import fs from 'node:fs';
import { Readable } from 'node:stream';
import { encodePath } from './util.mjs';

/**
 * 视频地址构造与转发。
 *
 * 支持两种模式：
 *   redirect  302 直链 —— 浏览器/播放器直接向 WebDAV（或自定义前缀）取流，
 *             后端零带宽、零延迟，天然支持 Range 拖动。
 *   proxy     后端代理 —— 需要注入鉴权、或前端跨域/跨网络访问不到 WebDAV 时使用。
 */

/**
 * 拼接「前端读取前缀」与文件相对路径。
 * 前缀可以是：
 *   - 绝对 URL（http://host/dav/115/Media、https://cdn.example.com/anime）
 *   - 站内路径（/dav/115/Media）
 * 会自动处理前缀已经包含根目录名的情况（例如前缀以 /动画 结尾）。
 */
export function buildFileUrl({ prefix, relPath, root = '', token = null, embedCredentials = false, dav = null }) {
  const raw = String(prefix || '');
  let origin = '';
  let basePath = raw;
  try {
    const u = new URL(raw);
    origin = `${u.protocol}//${u.host}`;
    basePath = u.pathname;
  } catch {
    /* 相对路径前缀（如 /dav/...） */
  }
  const baseDecoded = safeDecode(basePath).replace(/\/+$/g, '');
  const rootSeg = String(root || '')
    .split('/')
    .filter(Boolean)
    .pop();
  let rel = String(relPath || '').replace(/^\/+/, '');
  if (rootSeg && rel.startsWith(rootSeg + '/') && baseDecoded.endsWith('/' + rootSeg)) {
    rel = rel.slice(rootSeg.length + 1); // 前缀已指向根目录内，避免重复
  }
  const fullPath = [baseDecoded, rel].filter(Boolean).join('/');
  let url = `${origin}/${encodePath(fullPath)}`;
  if (token) {
    url += token.startsWith('?') || token.startsWith('&') ? token : `?token=${encodeURIComponent(token)}`;
  }
  if (embedCredentials && dav?.username) {
    try {
      const u = new URL(url);
      u.username = dav.username;
      u.password = dav.password;
      url = u.toString();
    } catch {
      /* prefix 不是绝对 URL 时忽略 */
    }
  }
  return url;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 302 直链响应 */
export function sendRedirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end();
}

/**
 * 输出本地文件，支持 Range（用于转封装后的 mp4）
 */
export function sendFileWithRange(req, res, filePath, { contentType = 'video/mp4', extraHeaders = {} } = {}) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const base = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (!m || Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, 'Content-Length': size });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * 代理转发（保留 Range / 206 语义）
 */
export async function proxyFile(req, res, { dav, relPath, extraHeaders = {}, downloadName = null }) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

  const upstream = await dav.open(relPath, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', range: headers.Range });
  const passHeaders = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  };
  for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) passHeaders[h.replace(/(^|-)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase())] = v;
  }
  if (downloadName) {
    passHeaders['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }

  res.writeHead(upstream.status, passHeaders);
  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body)
    .on('error', () => res.destroy())
    .pipe(res);
}
