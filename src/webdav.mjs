import { joinUrl } from './util.mjs';

/**
 * 极简 WebDAV 客户端：只用到 PROPFIND + 带 Range 的 GET。
 * 无第三方依赖，Node 20+ 内置 fetch。
 */
export class WebDavClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  例：http://192.168.124.3:19798/dav/115/Media
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.retries]
   */
  constructor({ baseUrl, username = '', password = '', timeoutMs = 20000, retries = 2 } = {}) {
    // 允许空 baseUrl（首次启动尚未配置）：真正发起请求时才会报错
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.rootPath = this.baseUrl ? new URL(this.baseUrl).pathname.replace(/\/+$/, '') : '';
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  get authHeader() {
    if (!this.username && !this.password) return null;
    return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
  }

  url(relPath = '') {
    if (!this.baseUrl) throw new Error('还没有配置 WebDAV 地址');
    return joinUrl(this.baseUrl, relPath);
  }

  headers(extra = {}) {
    const h = { 'User-Agent': 'anime-rotator/1.0', ...extra };
    const a = this.authHeader;
    if (a) h.Authorization = a;
    return h;
  }

  async #fetch(url, init = {}, { retries = this.retries } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: ac.signal, redirect: 'follow' });
        clearTimeout(timer);
        if (res.status >= 500 && attempt < retries) {
          lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /**
   * PROPFIND 列目录
   * @param {string} relPath 相对 baseUrl 的路径，'' 表示根
   * @param {number} depth
   * @returns {Promise<Array<{relPath:string,name:string,isDir:boolean,size:number,lastModified:number}>>}
   */
  async propfind(relPath = '', depth = 1) {
    const res = await this.#fetch(this.url(relPath), {
      method: 'PROPFIND',
      headers: this.headers({ Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }),
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:propfind xmlns:D="DAV:"><D:prop>' +
        '<D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:getcontenttype/>' +
        '</D:prop></D:propfind>',
    });
    if (res.status === 404) throw Object.assign(new Error(`404 路径不存在：${relPath}`), { status: 404 });
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`认证失败 ${res.status}：请检查 WebDAV 账号密码`), { status: res.status });
    }
    if (!res.ok && res.status !== 207) throw new Error(`PROPFIND 失败 ${res.status} ${res.statusText} @ ${relPath}`);
    const xml = await res.text();
    return parseMultiStatus(xml, this.rootPath, relPath);
  }

  /** 读取指定字节区间 */
  async readRange(relPath, start, endInclusive) {
    const res = await this.#fetch(this.url(relPath), {
      headers: this.headers({ Range: `bytes=${start}-${endInclusive}` }),
    });
    if (res.status === 206) return Buffer.from(await res.arrayBuffer());
    if (res.status === 200) {
      // 服务器忽略了 Range：只读到需要的长度就断开，避免整集文件被拖下来
      const limit = endInclusive - start + 1;
      if (!res.body) return Buffer.alloc(0);
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = value.length > limit - total ? value.subarray(0, limit - total) : value;
        chunks.push(Buffer.from(take));
        total += take.length;
      }
      if (total >= limit) reader.cancel().catch(() => {});
      return Buffer.concat(chunks);
    }
    throw new Error(`Range 读取失败 ${res.status} @ ${relPath}`);
  }

  /** 发一个 HEAD/GET 探测（用于 stream 代理模式） */
  async open(relPath, { method = 'GET', range = null } = {}) {
    const headers = this.headers();
    if (range) headers.Range = range;
    return this.#fetch(this.url(relPath), { method, headers }, { retries: 1 });
  }

  /** 直接可播放的 URL（含账号密码时嵌入 URL —— 仅在需要 302 直链给播放器时使用） */
  directUrl(relPath = '', { embedCredentials = false } = {}) {
    const u = new URL(this.url(relPath));
    if (embedCredentials && this.username) {
      u.username = encodeURIComponent(this.username);
      u.password = encodeURIComponent(this.password);
    }
    return u.toString();
  }
}

/** 把 href 解析为相对 baseUrl 根路径的相对路径 */
export function hrefToRelPath(href, rootPath, selfRel = '') {
  let p = href;
  try {
    p = decodeURIComponent(href);
  } catch {
    /* 保持原样 */
  }
  // 去掉协议+主机（如果有）
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
      p = decodeURIComponent(p);
    } catch {
      /* ignore */
    }
  }
  const root = (rootPath || '').replace(/\/+$/, '');
  if (root && p.startsWith(root)) p = p.slice(root.length);
  p = p.replace(/^\/+/, '');
  return p.replace(/\/+$/, '');
}

/** 解析 207 Multi-Status（对命名空间前缀做归一化，兼容 D: / d: / 无前缀） */
export function parseMultiStatus(xml, rootPath, requestRel = '') {
  const norm = String(xml)
    .replace(/<\?xml[\s\S]*?\?>/i, '')
    .replace(/<(\/?)[A-Za-z0-9_.-]+:/g, '<$1');
  const responses = [...norm.matchAll(/<response>([\s\S]*?)<\/response>/gi)].map((m) => m[1]);
  const out = [];
  const self = requestRel.replace(/\/+$/, '');
  for (const block of responses) {
    const hrefMatch = /<href[^>]*>([\s\S]*?)<\/href>/i.exec(block);
    if (!hrefMatch) continue;
    const relPath = hrefToRelPath(hrefMatch[1].trim(), rootPath, self);
    if (isSelfEntry(relPath, self)) continue;
    const isDir = /<collection\s*\/?>/i.test(block) || /<collection>/i.test(block);
    const sizeMatch = /<getcontentlength>([\s\S]*?)<\/getcontentlength>/i.exec(block);
    const lmMatch = /<getlastmodified>([\s\S]*?)<\/getlastmodified>/i.exec(block);
    const ctMatch = /<getcontenttype>([\s\S]*?)<\/getcontenttype>/i.exec(block);
    const name = relPath.split('/').filter(Boolean).pop() || relPath;
    out.push({
      relPath,
      name,
      isDir,
      size: sizeMatch ? Number(sizeMatch[1]) || 0 : 0,
      contentType: ctMatch ? ctMatch[1].trim() : '',
      lastModified: lmMatch ? Date.parse(lmMatch[1]) || 0 : 0,
    });
  }
  return out;
}

function isSelfEntry(relPath, self) {
  const a = relPath.replace(/\/+$/, '');
  const b = (self || '').replace(/\/+$/, '');
  return a === b || (b === '' && a === '');
}
