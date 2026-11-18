import path from 'node:path';
import { buildFileUrl } from './stream.mjs';

/**
 * 兼容产物存储
 * ------------------------------------------------------------------
 * 转封装出来的 MP4 可以：
 *   local  —— 只存在服务器本地（默认，走 /stream 代理）
 *   webdav —— 上传到（可以和原片不同的）WebDAV 服务，之后客户端 302 直连
 *
 * 之所以允许「另一套 WebDAV + 另一套 302 前缀」：
 *   - 原片库通常是只读的，兼容产物需要可写目录
 *   - 兼容产物常常放在回源更快 / 免鉴权的同一条 CDN 路径上
 */

export class CompatStore {
  /**
   * @param {object} opts
   * @param {import('./webdav.mjs').WebDavClient} opts.dav        写目标
   * @param {string} [opts.root]                                   目标根目录（相对 dav.baseUrl）
   * @param {string} [opts.urlPrefix]                              302 前缀（空则用 stream.urlPrefix）
   * @param {boolean} [opts.keepLocal]                             上传后是否保留本地副本
   */
  constructor({ dav, root = 'compat', urlPrefix = '', keepLocal = true } = {}) {
    this.dav = dav;
    this.root = String(root || 'compat').replace(/^\/+|\/+$/g, '');
    this.urlPrefix = urlPrefix || '';
    this.keepLocal = keepLocal;
    this.mkcolDone = new Set();
  }

  /** 兼容产物在 WebDAV 上的相对路径：compat/<系列>/<原名>.mp4 */
  relPathFor(ep) {
    const series = String(ep.seriesName || 'unknown')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim();
    const base = String(ep.name || ep.relPath.split('/').pop() || 'video').replace(/\.[^.]+$/, '');
    return [this.root, series, `${base}.mp4`].filter(Boolean).join('/');
  }

  /** 302 地址（prefix 为空时返回 null，表示走本地） */
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

  /** 是否已上传过 */
  async exists(ep) {
    try {
      const st = await this.dav.stat(this.relPathFor(ep));
      return st.exists;
    } catch {
      return false;
    }
  }

  /**
   * 上传本地转封装产物
   * @param {object} ep
   * @param {string} localPath
   * @param {(sent:number,total:number)=>void} [onProgress]
   */
  async upload(ep, localPath, { onProgress = null } = {}) {
    const relPath = this.relPathFor(ep);
    await this.ensureDir(relPath);
    const result = await this.dav.putFile(relPath, localPath, { onProgress });
    return { relPath, bytes: result.bytes, directUrl: this.directUrl(ep) };
  }

  async remove(ep) {
    try {
      await this.dav.delete(this.relPathFor(ep));
      return true;
    } catch {
      return false;
    }
  }
}
