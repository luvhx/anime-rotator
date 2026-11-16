#!/usr/bin/env node
/**
 * 前端冒烟测试（无需浏览器）
 *
 * 用最小 DOM 桩加载 public/app.js，验证「取时间轴 → 设置 src → seek 到直播位置 → 漂移重同步」整条链路。
 *   node tools/smoke-frontend.mjs                # 默认 http://127.0.0.1:8088
 *   BASE_URL=http://host:8088 node tools/smoke-frontend.mjs
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8088';

class ClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  add(...c) { c.forEach((x) => this.set.add(x)); this.sync(); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); this.sync(); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : force;
    on ? this.set.add(c) : this.set.delete(c);
    this.sync();
  }
  contains(c) { return this.set.has(c); }
  sync() { this.el.className = [...this.set].join(' '); }
}

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.className = '';
    this.classList = new ClassList(this);
    this.textContent = '';
    this.style = {};
    this.hidden = false;
    this.children = [];
    this.handlers = new Map();
    this._src = '';
    this.muted = false;
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.duration = NaN;
    this.currentTime = 0;
    this.error = null;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.readyState = 0; this.duration = NaN; this.currentTime = 0; this.paused = true; this.ended = false; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  appendChild(n) { this.children.push(n); return n; }
  addEventListener(type, fn) { (this.handlers.get(type) || this.handlers.set(type, []).get(type)).push(fn); }
  dispatch(type) { for (const fn of this.handlers.get(type) || []) fn({ type }); }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    return this.children.filter((c) => c.classList?.contains(cls));
  }
  load() {
    // 模拟浏览器：加载后拿到元数据
    setTimeout(() => {
      this.readyState = 1;
      this.duration = 1400;
      this.dispatch('loadedmetadata');
      setTimeout(() => {
        this.readyState = 4;
        this.dispatch('canplay');
      }, 60);
    }, 30);
  }
  play() {
    this.paused = false;
    this.dispatch('play');
    setTimeout(() => this.dispatch('playing'), 10);
    return Promise.resolve();
  }
  pause() { this.paused = true; this.dispatch('pause'); }
}

const registry = new Map();
const html = await (await fetch(BASE + '/')).text();
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
for (const id of ids) registry.set(id, new El(id === 'player' ? 'video' : 'div', id));

const document = {
  getElementById: (id) => registry.get(id) || null,
  createElement: (tag) => new El(tag),
  addEventListener: () => {},
  visibilityState: 'visible',
  querySelectorAll: () => [],
};
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

globalThis.document = document;
globalThis.localStorage = localStorage;
globalThis.location = { search: '', href: BASE + '/' };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  // 桩里的 video.duration 是假值，别让它回写到真实索引
  if (String(url).includes('/api/report-duration')) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, ignored: true, reason: 'smoke-test' }), { status: 200 }));
  }
  return realFetch(url.startsWith('http') ? url : BASE + url, init);
};
globalThis.window = { location: globalThis.location };

const errors = [];
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e?.message || e)));
process.on('uncaughtException', (e) => errors.push('uncaughtException: ' + (e?.message || e)));

await import('../public/app.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(2500);

const player = registry.get('player');
const q = (id) => registry.get(id);
const log = (ok, msg, extra = '') => console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);

log(!!q('seriesName').textContent, '频道信息渲染', q('seriesName').textContent + ' ' + q('epLabel').textContent);
log(q('epgList').children.length > 0, '节目单渲染', q('epgList').children.length + ' 条');
log(q('statusText').textContent.length > 0, '状态栏', q('statusText').textContent);
log(q('modeBadge').textContent.length > 0, '流模式徽标', q('modeBadge').textContent);

// 点击开播
q('startBtn').dispatch('click');
await wait(1500);

log(!!player.src, '播放器已设置 src', player.src);
log(!q('overlay').classList.contains('hidden') === false, '开始后隐藏遮罩');
log(player.currentTime > 0, '已按时间轴 seek 到当前进度', 'currentTime=' + player.currentTime.toFixed(1) + 's');
const now = await (await fetch('/api/now?channel=main')).json();
const expect = now.now.offsetMs / 1000;
log(Math.abs(player.currentTime - expect) < 6, 'seek 位置与后端偏移一致', `期望≈${expect.toFixed(1)}s 实际=${player.currentTime.toFixed(1)}s`);
log(q('progressFill').style.width?.endsWith('%'), '进度条更新', q('progressFill').style.width);
log(q('syncText').className.includes('sync'), '同步状态', q('syncText').textContent);

// 桩里的 video 不会自己走时间，漂移累积后 tick 应再次 seek 回直播位置
const t0 = player.currentTime;
await wait(6000);
const now2 = await (await fetch('/api/now?channel=main')).json();
const expected2 = now2.now.offsetMs / 1000;
log(Math.abs(player.currentTime - expected2) < 8, '漂移自动重同步', `${t0.toFixed(1)}s → ${player.currentTime.toFixed(1)}s（期望≈${expected2.toFixed(1)}s）`);

if (errors.length) {
  console.log('\n运行时错误：');
  for (const e of errors) console.log('  ✗', e);
}
console.log(errors.length === 0 ? '\n前端冒烟测试通过 ✓' : `\n${errors.length} 个运行时错误 ✗`);
process.exit(errors.length ? 1 : 0);
