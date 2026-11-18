#!/usr/bin/env node
/**
 * 预封装调度自检（不联网、不需要 ffmpeg）
 *   node tools/selftest-prefetch.mjs
 */
import { PrefetchWorker } from '../src/prefetch.mjs';

let fails = 0;
const check = (ok, msg, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};

const ep = (id) => ({ fileId: id, seriesName: `S-${id}`, season: 1, episode: 1 });

function makeWorker({ now, ready = {}, ahead = 1, channels = ['c1'] }) {
  const queued = [];
  const worker = new PrefetchWorker({
    channelIds: channels,
    ahead,
    intervalMs: 1000,
    needsWork: (e) => !ready[e.fileId],
    enqueue: (e) => queued.push(e.fileId),
    getNow: () => now,
  });
  return { worker, queued };
}

/* 1. 取当前 + 下一集 */
{
  const now = {
    current: { episode: ep('a') },
    upcoming: [{ episode: ep('b') }, { episode: ep('c') }],
  };
  const { worker, queued } = makeWorker({ now, ahead: 1 });
  worker.tick();
  check(queued.join(',') === 'a,b', '预取「当前 + 下一集」', queued.join(','));
}

/* 2. ahead=2 时多带一集 */
{
  const now = { current: { episode: ep('a') }, upcoming: [{ episode: ep('b') }, { episode: ep('c') }] };
  const { worker, queued } = makeWorker({ now, ahead: 2 });
  worker.tick();
  check(queued.join(',') === 'a,b,c', 'ahead=2 覆盖后面两集', queued.join(','));
}

/* 3. 已就绪的跳过 */
{
  const now = { current: { episode: ep('a') }, upcoming: [{ episode: ep('b') }] };
  const { worker, queued } = makeWorker({ now, ready: { a: true } });
  worker.tick();
  check(queued.join(',') === 'b', '已封装过的跳过', queued.join(',') || '(无)');
}

/* 4. 多频道去重 */
{
  const now = { current: { episode: ep('a') }, upcoming: [{ episode: ep('b') }] };
  const { worker, queued } = makeWorker({ now, channels: ['c1', 'c2'] });
  worker.tick();
  check(queued.join(',') === 'a,b', '跨频道按 fileId 去重', queued.join(','));
}

/* 5. 5 分钟内不重复排队 */
{
  const now = { current: { episode: ep('a') }, upcoming: [] };
  const { worker, queued } = makeWorker({ now });
  worker.tick();
  worker.tick();
  worker.tick();
  check(queued.length === 1, '同一集短时间内只排一次', `${queued.length} 次`);
}

/* 6. 空频道 / 无节目不炸 */
{
  const worker = new PrefetchWorker({
    channelIds: ['c1'],
    ahead: 1,
    needsWork: () => true,
    enqueue: () => {},
    getNow: () => {
      throw new Error('no library');
    },
  });
  let threw = false;
  try {
    worker.tick();
  } catch {
    threw = true;
  }
  check(!threw, 'getNow 抛错时不影响其他频道');
}

/* 7. start/stop */
{
  const now = { current: { episode: ep('a') }, upcoming: [] };
  const { worker } = makeWorker({ now });
  worker.start();
  const running = worker.stats().running;
  worker.stop();
  check(running && !worker.stats().running, 'start/stop 正常');
}

console.log(fails === 0 ? '\n预封装调度自检通过 ✓' : `\n${fails} 项失败 ✗`);
process.exit(fails ? 1 : 0);
