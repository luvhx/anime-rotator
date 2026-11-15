/**
 * 视频时长探测：不依赖 ffprobe，直接解析容器头。
 *
 *  - Matroska (.mkv/.webm)：EBML 递归找 Segment > Info > Duration + TimecodeScale
 *  - MP4/MOV (.mp4/.m4v/.mov)：顶层 box 中找 moov > mvhd
 *  - 其它（.avi/.rmvb/...）：交给调用方按码率估算
 *
 * 只需 HTTP Range 读取头部/尾部若干 KB，因此对 WebDAV 上的大文件也非常快。
 */

const EBML_ID = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
  TRACKS: 0x1654ae6b,
  VOID: 0xec,
  SEEKHEAD: 0x114d9b74,
  ATTACHMENTS: 0x1941a469,
  CHAPTERS: 0x1043a770,
  TAGS: 0x1254c367,
  CUES: 0x1c53bb6b,
};

/** 读 EBML 变长整数 */
function readVint(buf, offset, stripMarker) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (first & mask) === 0) {
    mask >>= 1;
    len++;
  }
  if (len > 8 || offset + len > buf.length) return null;
  let value = stripMarker ? first & (mask - 1) : first;
  for (let i = 1; i < len; i++) value = value * 256 + buf[offset + i];
  return { value, len };
}

const isMaster = (id) =>
  [
    EBML_ID.SEGMENT,
    EBML_ID.INFO,
    EBML_ID.TRACKS,
    EBML_ID.CLUSTER,
    EBML_ID.SEEKHEAD,
    EBML_ID.ATTACHMENTS,
    EBML_ID.CHAPTERS,
    EBML_ID.TAGS,
    EBML_ID.CUES,
  ].includes(id);

/**
 * 解析 MKV，返回 { durationMs, timecodeScale, muxer } 或 null
 */
export function parseMatroska(buf) {
  const state = { duration: null, timecodeScale: 1000000, muxer: null, scannedClusters: 0 };
  let notes = 0;

  const walk = (start, end, depth) => {
    let off = start;
    while (off < end - 2 && depth < 6 && notes++ < 20000) {
      const id = readVint(buf, off, false);
      if (!id) return;
      const size = readVint(buf, off + id.len, true);
      if (!size) return;
      const dataStart = off + id.len + size.len;
      const unknownSize = size.value === 2 ** (7 * size.len) - 1;
      let dataEnd = unknownSize ? end : dataStart + size.value;
      if (dataEnd > end) dataEnd = end; // 头部截断，尽力而为
      const idNum = id.value;

      if (idNum === EBML_ID.INFO || idNum === EBML_ID.SEGMENT) {
        walk(dataStart, dataEnd, depth + 1);
      } else if (idNum === EBML_ID.TIMECODE_SCALE) {
        let v = 0;
        for (let i = dataStart; i < dataEnd; i++) v = v * 256 + buf[i];
        if (v > 0) state.timecodeScale = v;
      } else if (idNum === EBML_ID.DURATION) {
        const len = dataEnd - dataStart;
        if (len === 4) state.duration = buf.readFloatBE(dataStart);
        else if (len === 8) state.duration = buf.readDoubleBE(dataStart);
        if (state.duration != null && state.duration <= 0) state.duration = null;
      } else if (idNum === 0x4d80) {
        // MuxingApp
        state.muxer = buf.subarray(dataStart, Math.min(dataEnd, dataStart + 64)).toString('utf8').replace(/\0.*$/, '');
      } else if (isMaster(idNum)) {
        // 跳过无法提供时长的大块（Cluster/Attachments...）
        state.scannedClusters++;
        if (idNum === EBML_ID.CLUSTER) return;
      }

      if (dataEnd <= off) return;
      off = dataEnd;
      if (state.duration != null && state.scannedClusters > 0) return;
    }
  };

  walk(0, buf.length, 0);

  if (state.duration == null) return null;
  // Duration 的单位是 TimecodeScale 纳秒
  const durationMs = (state.duration * state.timecodeScale) / 1e6;
  if (!(durationMs > 1000 && durationMs < 24 * 3600 * 1000)) return null;
  return { durationMs: Math.round(durationMs), container: 'matroska', muxer: state.muxer };
}

/** 解析 MP4/MOV 的 moov/mvhd（buf 可以是头部或尾部片段） */
/** 从 'mvhd' 类型字段的位置解析时长 */
function readMvhd(buf, p) {
  const version = buf[p];
  let timescale;
  let duration;
  if (version === 1) {
    if (p + 32 > buf.length) return null;
    timescale = buf.readUInt32BE(p + 20);
    duration = Number(buf.readBigUInt64BE(p + 24));
  } else if (version === 0) {
    if (p + 20 > buf.length) return null;
    timescale = buf.readUInt32BE(p + 12);
    duration = buf.readUInt32BE(p + 16);
  } else {
    return null;
  }
  if (!timescale || !duration) return null;
  const durationMs = (duration / timescale) * 1000;
  if (!(durationMs > 1000 && durationMs < 24 * 3600 * 1000)) return null;
  return { durationMs: Math.round(durationMs), container: 'mp4' };
}

/**
 * 解析 MP4/MOV。
 * buf 可以是文件头，也可以是文件尾部的片段（moov 常在末尾）。
 * 优先按 box 链定位 moov；box 长度异常（截断/坏文件）时退化为扫描 moov→mvhd 结构。
 */
export function parseMp4FromBuffer(buf) {
  // 1) 按 box 顺序走（只在从文件头开始时可靠）
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let boxSize = size;
    let headerLen = 8;
    if (size === 1) {
      if (off + 16 > buf.length) break;
      boxSize = Number(buf.readBigUInt64BE(off + 8));
      headerLen = 16;
    } else if (size === 0) {
      boxSize = buf.length - off;
    }
    if (boxSize < headerLen) break;
    if (type === 'moov') {
      const mvhd = buf.indexOf(Buffer.from('mvhd', 'latin1'), off + headerLen);
      const r = mvhd >= 0 && mvhd < off + boxSize + 16 ? readMvhd(buf, mvhd + 4) : null;
      if (r) return r;
      break;
    }
    off += boxSize;
  }

  // 2) 扫描 'moov'，要求紧跟 mvhd（moov 头 8 字节 + 第一个 child 的 type）
  const needle = Buffer.from('moov', 'latin1');
  let idx = buf.indexOf(needle);
  while (idx >= 0) {
    if (buf.toString('latin1', idx + 8, idx + 12) === 'mvhd') {
      const r = readMvhd(buf, idx + 12);
      if (r) return r;
    }
    idx = buf.indexOf(needle, idx + 4);
  }

  // 3) 最后兜底：直接找 mvhd（可能误命中，靠时长范围校验兜住）
  const mv = buf.indexOf(Buffer.from('mvhd', 'latin1'));
  if (mv >= 0) return readMvhd(buf, mv + 4);
  return null;
}

/** 根据扩展名判断可能的容器 */
export function containerOf(relPath) {
  const ext = String(relPath).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (ext === 'mkv' || ext === 'webm') return 'matroska';
  if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') return 'mp4';
  return ext || 'unknown';
}

/**
 * 通过 WebDAV Range 读取并探测时长。
 * @param {import('./webdav.mjs').WebDavClient} dav
 * @param {string} relPath
 * @param {number} size 文件字节数
 * @returns {Promise<{durationMs:number, container:string, source:string}|null>}
 */
export async function probeDuration(dav, relPath, size) {
  const container = containerOf(relPath);
  const attempts = [128 * 1024, 1024 * 1024, 4 * 1024 * 1024];

  if (container === 'matroska') {
    for (const chunk of attempts) {
      const end = Math.min(chunk, size) - 1;
      const buf = await dav.readRange(relPath, 0, end);
      const r = parseMatroska(buf);
      if (r) return { ...r, source: 'mkv-info' };
      if (end + 1 >= size) break;
    }
    return null;
  }

  if (container === 'mp4') {
    const head = await dav.readRange(relPath, 0, Math.min(1024 * 1024, size) - 1);
    const headRes = parseMp4FromBuffer(head);
    if (headRes) return { ...headRes, source: 'mp4-mvhd' };
    for (const tailLen of [2 * 1024 * 1024, 8 * 1024 * 1024]) {
      if (size <= 1024 * 1024) break;
      const len = Math.min(tailLen, size);
      const tail = await dav.readRange(relPath, size - len, size - 1);
      const tailRes = parseMp4FromBuffer(tail);
      if (tailRes) return { ...tailRes, source: 'mp4-mvhd-tail' };
    }
    return null;
  }

  return null;
}
