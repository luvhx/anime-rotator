import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 转封装服务
 * ------------------------------------------------------------------
 * iOS / iPadOS 的 Safari（以及 iOS 上所有浏览器）**不支持 MKV 容器**，
 * 哪怕里面的视频轨是 HEVC 也放不出来，表现就是一直转圈。
 *
 * 这里用 ffmpeg 把 MKV 无损转封装成 MP4（视频流 direct copy，音频转 AAC），
 * 结果按集缓存到 data/remux/，之后和普通 mp4 一样支持 Range 拖动。
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
   * @param {string} [opts.ffmpegPath]
   * @param {string} [opts.ffprobePath]
   * @param {number} [opts.maxBytes]
   * @param {boolean} [opts.enabled]
   */
  constructor({
    dav,
    cacheDir,
    ffmpegPath = 'ffmpeg',
    ffprobePath = 'ffprobe',
    maxBytes = 20 * GB,
    enabled = true,
  } = {}) {
    this.dav = dav;
    this.cacheDir = cacheDir;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.maxBytes = maxBytes;
    this.enabled = enabled;
    this.available = false;
    this.checked = false;
    this.jobs = new Map();
    this.queue = Promise.resolve();
  }

  get ready() {
    return this.enabled && this.available;
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

  /** 查询状态 */
  status(ep) {
    if (!this.enabled) return { state: 'disabled' };
    const file = this.fileFor(ep);
    try {
      const st = fs.statSync(file);
      if (st.size > 0) return { state: 'ready', bytes: st.size };
    } catch {
      /* 未缓存 */
    }
    if (!this.available) return { state: 'unavailable', reason: '当前镜像没有 ffmpeg，请使用 :latest-ffmpeg 镜像' };
    const job = this.jobs.get(ep.fileId);
    if (job) return { state: job.state, progress: job.progress, bytes: job.bytes, error: job.error };
    return { state: 'idle' };
  }

  /** 启动（幂等） */
  start(ep) {
    if (!this.ready) return this.status(ep);
    const cached = this.status(ep);
    if (cached.state === 'ready') return cached;
    if (this.jobs.has(ep.fileId)) return this.status(ep);

    const job = { state: 'working', progress: 0, bytes: 0, error: null, startedAt: Date.now() };
    this.jobs.set(ep.fileId, job);
    this.queue = this.queue
      .then(() => this.#run(ep, job))
      .catch((err) => {
        job.state = 'error';
        job.error = err.message;
      })
      .finally(() => {
        // 保留一段时间让前端读到结果，再清理
        setTimeout(() => this.jobs.delete(ep.fileId), 60000);
      });
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

  /** 统计缓存占用 */
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
    return { count, bytes, maxBytes: this.maxBytes, available: this.available };
  }
}
