import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sha1 } from './util.mjs';

/**
 * 字幕服务
 * ------------------------------------------------------------------
 * 浏览器只认 WebVTT，而节目字幕多是 ASS/SRT（外挂）或封在 MKV 里（内挂），
 * 所以这里统一转成 WebVTT 再给 <track> 用：
 *
 *   外挂 .ass/.srt  → 从 WebDAV 读文本 → 转 VTT（纯 JS，零依赖）
 *   内挂轨道        → 调 ffmpeg 抽取（仅在带 ffmpeg 的镜像里可用）
 *
 * 转换结果按「文件指纹」缓存在 data/subs/ 下，重复播放不会重复转换。
 */

const ASS_TS = /^(\d+):(\d{2}):(\d{2})[.:](\d{1,3})$/;

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

/** ASS/SSA 时间戳 → WebVTT（H:MM:SS.cc → HH:MM:SS.mmm） */
export function assTimeToVtt(text) {
  const m = ASS_TS.exec(String(text).trim());
  if (!m) return null;
  const [, h, mi, s, frac] = m;
  const ms = frac.length === 2 ? Number(frac) * 10 : frac.length === 1 ? Number(frac) * 100 : Number(frac);
  return `${pad(Number(h))}:${mi}:${s}.${pad(ms, 3)}`;
}

/** 去掉 ASS 的行内覆盖标签、绘图指令，保留台词文本 */
export function cleanAssText(raw) {
  let text = String(raw || '');
  // 整段的绘图命令（\p1 之后的 m/l 路径）直接丢弃
  if (/^\s*\{[^}]*\\p\d[^}]*\}/.test(text)) return '';
  text = text.replace(/\{[^}]*\}/g, '');
  text = text.replace(/\\[Nn]/g, '\n');
  text = text.replace(/\\h/g, ' ');
  // 残留的绘图坐标
  const kept = text
    .split('\n')
    .filter((line) => !/^\s*[ml]\s+(-?\d+(\.\d+)?\s*)+$/i.test(line))
    .join('\n');
  return kept.replace(/\n{3,}/g, '\n\n').trim();
}

/** ASS/SSA → WebVTT */
export function assToVtt(input) {
  const lines = String(input).replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = ['WEBVTT', ''];
  let inEvents = false;
  let format = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      format = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const fmt = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const body = line.slice(line.indexOf(':') + 1);
    const idxStart = fmt.indexOf('start');
    const idxEnd = fmt.indexOf('end');
    const idxText = fmt.indexOf('text') >= 0 ? fmt.indexOf('text') : fmt.length - 1;

    const parts = [];
    let rest = body;
    for (let i = 0; i < idxText; i++) {
      const k = rest.indexOf(',');
      parts.push(k < 0 ? rest : rest.slice(0, k));
      rest = k < 0 ? '' : rest.slice(k + 1);
      if (rest === '' && i < idxText - 1) break;
    }
    parts.push(rest);

    const start = assTimeToVtt(parts[idxStart]);
    const end = assTimeToVtt(parts[idxEnd]);
    const text = cleanAssText(parts[idxText] ?? '');
    if (!start || !end || !text) continue;
    if (start >= end) continue;
    out.push(`${start} --> ${end}`, text.replace(/-->/g, '- - >'), '');
  }

  return out.join('\n');
}

/** SRT → WebVTT */
export function srtToVtt(input) {
  let text = String(input).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  // 去掉纯序号行
  text = text.replace(/^\d+[ \t]*\n(?=\d{2}:\d{2}:\d{2}\.\d{3}\s*-->)/gm, '');
  return `WEBVTT\n\n${text.trim()}\n`;
}

/** 已经是 WebVTT 就直接用 */
export function ensureVtt(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  return /^WEBVTT/.test(text.trimStart()) ? text : `WEBVTT\n\n${text.trim()}\n`;
}

/** 按扩展名转换 */
export function toVtt(content, ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'ass' || e === 'ssa') return assToVtt(content);
  if (e === 'srt' || e === 'sub') return srtToVtt(content);
  if (e === 'vtt') return ensureVtt(content);
  // 未知格式：按内容嗅探
  if (/^\[script info\]/i.test(String(content).trimStart())) return assToVtt(content);
  return ensureVtt(content);
}

function extOf(p) {
  return (String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
}

/**
 * @typedef {{text: string, source: 'external'|'embedded', cached: boolean}} SubtitleResult
 */

export class SubtitleService {
  /**
   * @param {object} opts
   * @param {import('./webdav.mjs').WebDavClient} opts.dav
   * @param {string} opts.cacheDir
   * @param {string} [opts.ffmpegPath]
   * @param {boolean} [opts.enabled]
   */
  constructor({ dav, cacheDir, ffmpegPath = 'ffmpeg', enabled = true, extractTimeoutMs = 180000 }) {
    this.dav = dav;
    this.cacheDir = cacheDir;
    this.ffmpegPath = ffmpegPath;
    this.enabled = enabled;
    this.extractTimeoutMs = extractTimeoutMs;
    this.ffmpegAvailable = false;
    this.ffmpegChecked = false;
    this.inflight = new Map();
  }

  /** 探测 ffmpeg 是否可用（只跑一次） */
  async detectFfmpeg() {
    if (this.ffmpegChecked) return this.ffmpegAvailable;
    this.ffmpegChecked = true;
    this.ffmpegAvailable = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      try {
        const p = spawn(this.ffmpegPath, ['-hide_banner', '-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
        p.on('error', () => finish(false));
        p.on('close', (code) => finish(code === 0));
        setTimeout(() => finish(false), 4000);
      } catch {
        finish(false);
      }
    });
    return this.ffmpegAvailable;
  }

  cachePath(ep) {
    const key = sha1(`${ep.fileId}|${ep.relPath}|${ep.size}|2`);
    return path.join(this.cacheDir, `${key.slice(0, 20)}.vtt`);
  }

  /**
   * 取某集字幕的 WebVTT
   * @param {object} ep 库里的剧集对象
   * @returns {Promise<SubtitleResult|null>}
   */
  async get(ep) {
    if (!this.enabled || !ep) return null;
    const cacheFile = this.cachePath(ep);
    if (fs.existsSync(cacheFile)) {
      const text = fs.readFileSync(cacheFile, 'utf8');
      if (text.trim().length > 0) return { text, source: ep.subtitle ? 'external' : 'embedded', cached: true };
    }
    if (this.inflight.has(cacheFile)) return this.inflight.get(cacheFile);

    const task = (async () => {
      const result = ep.subtitle ? await this.#fromExternal(ep) : await this.#fromEmbedded(ep);
      if (!result) return null;
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, result.text);
      fs.renameSync(tmp, cacheFile);
      return { ...result, cached: false };
    })().finally(() => this.inflight.delete(cacheFile));

    this.inflight.set(cacheFile, task);
    return task;
  }

  async #fromExternal(ep) {
    const ext = extOf(ep.subtitle);
    const res = await this.dav.open(ep.subtitle, { method: 'GET' });
    if (!res.ok) throw new Error(`读取外挂字幕失败 HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
    const text = toVtt(raw, ext);
    if (!/-->/.test(text)) return null;
    return { text, source: 'external' };
  }

  async #fromEmbedded(ep) {
    if (!(await this.detectFfmpeg())) return null;
    const text = await this.#runFfmpeg(ep);
    if (!text || !/-->/.test(text)) return null;
    return { text, source: 'embedded' };
  }

  #runFfmpeg(ep) {
    const url = this.dav.url(ep.relPath);
    const auth = this.dav.authHeader;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (auth) args.push('-headers', `Authorization: ${auth}\r\n`);
    args.push('-i', url, '-map', '0:s:0', '-f', 'webvtt', '-c:s', 'webvtt', 'pipe:1');

    return new Promise((resolve) => {
      const chunks = [];
      let finished = false;
      const done = (v) => {
        if (finished) return;
        finished = true;
        resolve(v);
      };
      let child;
      try {
        child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        return done(null);
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done(null);
      }, this.extractTimeoutMs);
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', () => {});
      child.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return done(null);
        done(Buffer.concat(chunks).toString('utf8'));
      });
    });
  }
}
