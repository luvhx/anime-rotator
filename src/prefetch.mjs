/**
 * 预封装调度
 * ------------------------------------------------------------------
 * 轮播的时间轴是确定的：任意时刻都能算出「正在播」和「下一集」。
 * 所以不需要等客户端点开、发现播不了再来转封装——这里提前把它们转好并上传。
 *
 *   - 每个频道取 current + 后面的 N 集（默认只取下一集）
 *   - 跨频道按 fileId 去重
 *   - 已经转好/已发布的直接跳过（幂等）
 *   - 串行执行，不抢 CPU
 */
export class PrefetchWorker {
  /**
   * @param {object} opts
   * @param {{ channelId: string, startsAt: number, episode: { fileId: string } } => any} opts.getNow
   * @param {(ep: object) => boolean} opts.needsWork
   * @param {(ep: object) => void} opts.enqueue
   * @param {string[]} [opts.channelIds]
   * @param {number} [opts.ahead]      预取后面几集（1 = 当前 + 下一集）
   * @param {number} [opts.intervalMs]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ getNow, needsWork, enqueue, channelIds = [], ahead = 1, intervalMs = 20000, log = null }) {
    this.getNow = getNow;
    this.needsWork = needsWork;
    this.enqueue = enqueue;
    this.channelIds = channelIds;
    this.ahead = Math.max(0, Number(ahead) || 0);
    this.intervalMs = Math.max(5000, Number(intervalMs) || 20000);
    this.log = log || (() => {});
    this.timer = null;
    this.lastQueued = new Map(); // fileId -> 时间戳，避免短时间内重复入队
    this.skipped = 0;
    this.queued = 0;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 跑一轮：把每个频道的「当前 + 接下来 N 集」安排掉 */
  tick() {
    const seen = new Set();
    for (const channelId of this.channelIds) {
      let snapshot;
      try {
        snapshot = this.getNow(channelId);
      } catch {
        continue; // 频道还没准备好/没有库
      }
      if (!snapshot) continue;
      const items = [snapshot.current, ...(snapshot.upcoming || []).slice(0, this.ahead)].filter(Boolean);
      for (const item of items) {
        const fileId = item.episode?.fileId;
        if (!fileId || seen.has(fileId)) continue;
        seen.add(fileId);
        if (!this.needsWork(item.episode)) {
          this.skipped++;
          continue;
        }
        const last = this.lastQueued.get(fileId) || 0;
        if (Date.now() - last < 5 * 60_000) continue; // 5 分钟内不重复排队
        this.lastQueued.set(fileId, Date.now());
        this.queued++;
        this.log(`预封装：${item.episode.seriesName} S${item.episode.season}E${item.episode.episode}`);
        try {
          this.enqueue(item.episode);
        } catch {
          /* 单集失败不影响其他 */
        }
      }
    }
    // 清理过期的去重记录
    const cutoff = Date.now() - 30 * 60_000;
    for (const [k, v] of this.lastQueued) if (v < cutoff) this.lastQueued.delete(k);
  }

  stats() {
    return {
      running: Boolean(this.timer),
      intervalMs: this.intervalMs,
      ahead: this.ahead,
      channels: this.channelIds,
      queued: this.queued,
      skipped: this.skipped,
    };
  }
}
