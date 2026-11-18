import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 转封装服务
 * ------------------------------------------------------------------
 * iOS / iPadOS 的 Safari（以及 iOS 上所有浏览器）**不支持 MKV 容器**，
 * 哪怕里面的视频轨是 HEVC 也放不出来，表现就是一直转圈。
 *
 * 这里用 ffmpeg 把 MKV 无损转封装成 MP4（视频流 direct copy，音频转 AAC）：
 *   - 产物先落本地 data/remux/，立即可播
 *   - 配置了 CompatStore 时，后台把产物上传到（可以是另一套的）WebDAV，
 *     上传完成后客户端直接 302 走 CDN，后端不再搬流量
 *
 * 注意：
 *  - 只转封装不转码，CPU 占用很低，耗时基本等于「读一遍 + 写一遍」
 *  - HEVC 需要打 hvc1 标签，Apple 才认；HEVC 10bit 在 iOS 11+ 可以播
 *  - 音频统一转 AAC（DTS / FLAC / TrueHD 在 iOS 上放不出来）
 */

const GB = 1024 ** 3;

export class RemuxService {
  /**
   * @param {object} opts
   * @param {import('./webdav.mjs').WebDavClient} opts.dav
   * @param {string} opts.cacheDir
   * @param {import('./compat-store.mjs').CompatStore} [opts.store]
   * @param {string} [opts.ffmpegPath]
   * @param {string} [opts.ffprobePath]
   * @param {number} [opts.maxBytes]
   * @param {boolean} [opts.enabled]
   */
  constructor({
    dav,
    cacheDir,
    store = null,
    ffmpegPath = 'ffmpeg',
    ffprobePath = 'ffprobe',
    maxBytes = 20 * GB,
    enabled = true,
  } = {}) {
    this.dav = dav;
    this.cacheDir = cacheDir;
    this.store = store;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.maxBytes = maxBytes;
    this.enabled = enabled;
    this.available = false;
    this.checked = false;
    this.jobs = new Map();
    this.uploads = new Map();
    this.published = new Map(); // fileId -> { relPath, directUrl, bytes } —— 直链已验证可用
    this.uploaded = new Map(); // fileId -> { relPath, directUrl } —— 已上传，直链待验证
    this.remoteChecked = new Set();
    this.queue = Promise.resolve();
  }

  get ready() {
    return this.enabled && this.available;
  }

  setStore(store) {
    this.store = store;
  }

  async detect() {
    if (this.checked) return this.available;
    this.checked = true;
    const probe = (bin, args) =>
      new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        try {
          const p = spawn(bin, args, { stdio: 'ignore' });
          p.on('error', () => finish(false));
          p.on('close', (code) => finish(code === 0));
          setTimeout(() => finish(false), 4000);
        } catch {
          finish(false);
        }
      });
    this.hasFfprobe = await probe(this.ffprobePath, ['-hide_banner', '-version']);
    this.available = await probe(this.ffmpegPath, ['-hide_banner', '-version']);
    return this.available;
  }

  fileFor(ep) {
    return path.join(this.cacheDir, `${ep.fileId}-${ep.size}.mp4`);
  }

  /** 远端是否已有（每个进程生命周期只查一次） */
  async refresh(ep) {
    if (!this.store) return;
    if (this.published.has(ep.fileId) || this.remoteChecked.has(ep.fileId)) return;
    this.remoteChecked.add(ep.fileId);
    try {
      if (await this.store.exists(ep)) {
        this.published.set(ep.fileId, { relPath: this.store.relPathFor(ep), directUrl: this.store.directUrl(ep) });
      }
    } catch {
      /* 远端不可用就当没有 */
    }
  }

  /** 查询状态 */
  status(ep) {
    if (!this.enabled) return { state: 'disabled', playable: false };
    const remote = this.published.get(ep.fileId);
    if (remote) {
      return { state: 'published', playable: true, directUrl: remote.directUrl, relPath: remote.relPath };
    }
    const upload = this.uploads.get(ep.fileId);
    if (upload && upload.state === 'uploading') {
      return { state: 'uploading', playable: true, progress: upload.progress, uploadProgress: upload.progress };
    }
    const file = this.fileFor(ep);
    try {
      const st = fs.statSync(file);
      if (st.size > 0) return { state: 'ready', playable: true, bytes: st.size, uploadError: upload?.error || null };
    } catch {
      /* 未缓存 */
    }
    if (!this.available) return { state: 'unavailable', playable: false, reason: '当前镜像没有 ffmpeg，请使用 :latest-ffmpeg 镜像' };
    const job = this.jobs.get(ep.fileId);
    if (job) return { state: job.state, playable: false, progress: job.progress, bytes: job.bytes, error: job.error };
    return { state: 'idle', playable: false };
  }

  /** 启动（幂等）：远端已有 → 直接 published；本地已有 → 只补上传 */
  start(ep) {
    const st = this.status(ep);
    // 已上传但直链还不可用：只重试验证，不重复上传
    if (this.uploaded.has(ep.fileId) && !this.published.has(ep.fileId)) {
      this.#verifyAndPublish(ep, this.uploaded.get(ep.fileId));
      return st;
    }
    // 本地已有产物：即使没有 ffmpeg，也要把上传补上
    if (st.playable) {
      if (st.state === 'ready') this.#publishInBackground(ep);
      return st;
    }
    if (!this.ready) return st;
    if (this.jobs.has(ep.fileId)) return this.status(ep);

    const job = { state: 'working', progress: 0, bytes: 0, error: null, startedAt: Date.now() };
    this.jobs.set(ep.fileId, job);
    this.queue = this.queue
      .then(() => this.#run(ep, job))
      .catch((err) => {
        job.state = 'error';
        job.error = err.message;
      })
      .finally(() => setTimeout(() => this.jobs.delete(ep.fileId), 60000));
    return this.status(ep);
  }

  async #run(ep, job) {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const out = this.fileFor(ep);
    const tmp = `${out}.part`;
    const codec = await this.#probeCodec(ep).catch(() => null);

    const auth = this.dav.authHeader;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats'];
    if (auth) args.push('-headers', `Authorization: ${auth}\r\n`);
    args.push('-i', this.dav.url(ep.relPath));
    args.push('-map', '0:v:0', '-map', '0:a:0?');
    args.push('-c:v', 'copy');
    if (codec === 'hevc' || codec === 'h265') args.push('-tag:v', 'hvc1');
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    args.push('-sn', '-dn', '-movflags', '+faststart', '-f', 'mp4', tmp);

    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return reject(err);
      }
      let stderr = '';
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const m = /^out_time_ms=(\d+)/.exec(line.trim());
          if (m) {
            const doneMs = Number(m[1]) / 1000;
            job.progress = ep.durationMs ? Math.max(0, Math.min(0.99, doneMs / ep.durationMs)) : 0;
          }
          const b = /^total_size=(\d+)/.exec(line.trim());
          if (b) job.bytes = Number(b[1]);
        }
      });
      child.stderr.on('data', (c) => {
        stderr += c.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg 退出码 ${code}`));
      });
    });

    fs.renameSync(tmp, out);
    job.state = 'ready';
    job.progress = 1;
    job.bytes = fs.statSync(out).size;
    this.#evict();
    this.#publishInBackground(ep);
  }

  /** 后台上传，不阻塞播放 */
  #publishInBackground(ep) {
    if (!this.store || this.published.has(ep.fileId)) return;
    if (this.uploads.get(ep.fileId)?.state === 'uploading') return;
    const local = this.fileFor(ep);
    if (!fs.existsSync(local)) return;

    const upload = { state: 'uploading', progress: 0, error: null, startedAt: Date.now() };
    this.uploads.set(ep.fileId, upload);
    this.store
      .upload(ep, local, {
        onProgress: (sent, total) => {
          upload.progress = total ? sent / total : 0;
        },
      })
      .then((r) => {
        this.uploaded.set(ep.fileId, r);
        return this.#verifyAndPublish(ep, r).then((ok) => {
          upload.state = ok ? 'done' : 'pending-verify';
          if (!ok) upload.error = '已上传，但直链暂不可用（OpenList 可能还没索引新文件），继续走本地';
          if (ok && !this.store.keepLocal) {
            try {
              fs.unlinkSync(local);
            } catch {
              /* ignore */
            }
          }
        });
      })
      .catch((err) => {
        upload.state = 'error';
        upload.error = err.message;
      });
  }

  /**
   * 上传成功 ≠ 直链可用：OpenList/115 对刚上传的文件可能暂时返回 5xx。
   * 只有 HEAD 探测通过才标记 published，否则继续走本地服务。
   */
  async #verifyAndPublish(ep, remote) {
    if (!remote?.directUrl) return false;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      const res = await fetch(remote.directUrl, { method: 'GET', headers: { Range: 'bytes=0-1' }, signal: ac.signal });
      clearTimeout(timer);
      const ok = res.ok || res.status === 206 || res.status === 302 || res.status === 307;
      if (ok) {
        this.published.set(ep.fileId, remote);
        const upload = this.uploads.get(ep.fileId);
        if (upload) {
          upload.state = 'done';
          upload.error = null;
        }
      }
      return ok;
    } catch {
      return false;
    }
  }

  async #probeCodec(ep) {
    if (!this.hasFfprobe) return this.#probeCodecViaFfmpeg(ep);
    const auth = this.dav.authHeader;
    const args = ['-hide_banner', '-loglevel', 'error', '-select_streams', 'v:0'];
    if (auth) args.push('-headers', `Authorization: ${auth}\r\n`);
    args.push('-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', this.dav.url(ep.relPath));
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn(this.ffprobePath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return resolve(null);
      }
      child.stdout.on('data', (c) => (out += c.toString()));
      child.on('close', () => resolve(out.trim().split('\n')[0] || null));
      child.on('error', () => resolve(null));
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve(null);
      }, 20000);
    });
  }

  /** 没有 ffprobe 时，用 ffmpeg -i 的 stderr 解析编码 */
  #probeCodecViaFfmpeg(ep) {
    const auth = this.dav.authHeader;
    const args = ['-hide_banner', '-nostdin'];
    if (auth) args.push('-headers', `Authorization: ${auth}\r\n`);
    args.push('-i', this.dav.url(ep.relPath));
    return new Promise((resolve) => {
      let err = '';
      let child;
      try {
        child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch {
        return resolve(null);
      }
      child.stderr.on('data', (c) => {
        err += c.toString();
        if (err.length > 20000) err = err.slice(-20000);
      });
      child.on('close', () => {
        const m = /Stream #0:\d+.*?: Video: (\w+)/.exec(err);
        resolve(m ? m[1].toLowerCase() : null);
      });
      child.on('error', () => resolve(null));
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve(null);
      }, 25000);
    });
  }

  /** 超出配额时按最久未访问淘汰 */
  #evict() {
    let entries;
    try {
      entries = fs
        .readdirSync(this.cacheDir)
        .filter((f) => f.endsWith('.mp4'))
        .map((f) => {
          const p = path.join(this.cacheDir, f);
          const st = fs.statSync(p);
          return { p, size: st.size, at: st.atimeMs || st.mtimeMs };
        });
    } catch {
      return;
    }
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= this.maxBytes) return;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      try {
        fs.unlinkSync(e.p);
        total -= e.size;
      } catch {
        /* ignore */
      }
    }
  }

  stats() {
    let count = 0;
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(this.cacheDir)) {
        if (!f.endsWith('.mp4')) continue;
        try {
          bytes += fs.statSync(path.join(this.cacheDir, f)).size;
          count++;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 目录还不存在 */
    }
    return {
      count,
      bytes,
      maxBytes: this.maxBytes,
      available: this.available,
      published: this.published.size,
      uploads: [...this.uploads.values()].filter((u) => u.state === 'uploading').length,
    };
  }
}
