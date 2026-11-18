import fs from 'node:fs';
import path from 'node:path';
import { buildFileUrl } from './stream.mjs';

/**
 * 兼容产物存储
 * ------------------------------------------------------------------
 * 转封装出来的 MP4 可以：
 *   local  —— 只存在服务器本地（默认，走 /stream 代理）
 *   webdav —— 上传到（可以和原片不同的）WebDAV 服务，之后客户端 302 直连
 *
 * 产物配额：
 *   maxFiles / maxBytes（0 = 不限制）按「最久未播放」淘汰远端产物，
 *   同时删掉对应的本地副本。索引落在 data/compat-index.json。
 */

export class CompatStore {
  /**
   * @param {object} opts
   * @param {import('./webdav.mjs').WebDavClient} opts.dav
   * @param {string} [opts.root]
   * @param {string} [opts.urlPrefix]
   * @param {boolean} [opts.keepLocal]
   * @param {number} [opts.maxFiles]
   * @param {number} [opts.maxBytes]
   * @param {string} [opts.indexFile]
   */
  constructor({ dav, root = 'compat', urlPrefix = '', keepLocal = true, maxFiles = 0, maxBytes = 0, indexFile = null } = {}) {
    this.dav = dav;
    this.root = String(root || 'compat').replace(/^\/+|\/+$/g, '');
    this.urlPrefix = urlPrefix || '';
    this.keepLocal = keepLocal;
    this.maxFiles = Number(maxFiles) || 0;
    this.maxBytes = Number(maxBytes) || 0;
    this.indexFile = indexFile;
    this.index = new Map(); // fileId -> { relPath, size, at }
    this.mkcolDone = new Set();
    this.#loadIndex();
  }

  #loadIndex() {
    if (!this.indexFile || !fs.existsSync(this.indexFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      for (const [k, v] of Object.entries(raw.entries || {})) this.index.set(k, v);
    } catch {
      /* 索引损坏忽略 */
    }
  }

  #saveIndex() {
    if (!this.indexFile) return;
    const entries = Object.fromEntries(this.index);
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, this.indexFile);
  }

  get limits() {
    return { maxFiles: this.maxFiles, maxBytes: this.maxBytes };
  }

  stats() {
    let bytes = 0;
    for (const v of this.index.values()) bytes += v.size || 0;
    return { count: this.index.size, bytes, maxFiles: this.maxFiles, maxBytes: this.maxBytes };
  }

  /** 兼容产物在 WebDAV 上的相对路径：compat/<系列>/<原名>.mp4 */
  relPathFor(ep) {
    const series = String(ep.seriesName || 'unknown')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim();
    const base = String(ep.name || ep.relPath.split('/').pop() || 'video').replace(/\.[^.]+$/, '');
    return [this.root, series, `${base}.mp4`].filter(Boolean).join('/');
  }

  directUrl(ep) {
    if (!this.urlPrefix) return null;
    return buildFileUrl({
      prefix: this.urlPrefix,
      relPath: this.relPathFor(ep),
      root: this.root,
    });
  }

  async ensureDir(relPath) {
    const dir = relPath.split('/').slice(0, -1).join('/');
    if (!dir || this.mkcolDone.has(dir)) return;
    await this.dav.mkcol(dir);
    this.mkcolDone.add(dir);
  }

  async exists(ep) {
    try {
      const st = await this.dav.stat(this.relPathFor(ep));
      return st.exists;
    } catch {
      return false;
    }
  }

  async upload(ep, localPath, { onProgress = null } = {}) {
    const relPath = this.relPathFor(ep);
    await this.ensureDir(relPath);
    const result = await this.dav.putFile(relPath, localPath, { onProgress });
    return { relPath, bytes: result.bytes, directUrl: this.directUrl(ep), size: result.bytes };
  }

  async remove(ep) {
    try {
      await this.dav.delete(this.relPathFor(ep));
      this.index.delete(ep.fileId);
      this.#saveIndex();
      return true;
    } catch {
      return false;
    }
  }

  /** 记录已发布产物 */
  record(ep, remote) {
    this.index.set(ep.fileId, {
      relPath: remote.relPath || this.relPathFor(ep),
      size: remote.size || remote.bytes || 0,
      at: Date.now(),
    });
    this.#saveIndex();
  }

  /** 命中配额时，从最久未播放的开始删（远端 + 本地） */
  async evict(localFileFor) {
    if (this.maxFiles <= 0 && this.maxBytes <= 0) return 0;
    const items = [...this.index.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    let count = items.length;
    let bytes = items.reduce((a, [, v]) => a + (v.size || 0), 0);
    let removed = 0;
    for (const [fileId, v] of items) {
      const overFiles = this.maxFiles > 0 && count > this.maxFiles;
      const overBytes = this.maxBytes > 0 && bytes > this.maxBytes;
      if (!overFiles && !overBytes) break;
      try {
        await this.dav.delete(v.relPath);
      } catch {
        /* 远端删不掉也继续 */
      }
      this.index.delete(fileId);
      count--;
      bytes -= v.size || 0;
      removed++;
      if (localFileFor) {
        try {
          const p = localFileFor(fileId);
          if (p && fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    if (removed > 0) this.#saveIndex();
    return removed;
  }
}
