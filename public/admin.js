/**
 * 管理界面
 * ------------------------------------------------------------------
 * 纯原生实现，无构建步骤：
 *   - 配置（WebDAV / 取流 / 时区 / TMDB）
 *   - 番剧库（勾选参与编排的番剧，封面/简介来自 TMDB）
 *   - 编排（频道 + 规则段编辑，含模板）
 *   - 预览（用未保存的草稿实时试算节目单）
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  state: null,
  draft: null,
  tab: 'overview',
  dirty: { config: false, series: false, channels: false },
  posters: new Map(),
  selected: new Set(),
  allSeries: [],
  allIds: [],
  activeChannel: null,
  preview: null,
  scanTimer: null,
  posterQueue: new Set(),
  posterTimer: null,
};

const RULE_META = {
  sequential: { label: '顺序连播', desc: '按系列顺序，一部播完接下一部' },
  binge: { label: '整部连播', desc: '同 sequential，语义上一口气播完一部' },
  interleave: { label: '跨系列轮播', desc: 'A 第1集 → B 第1集 → A 第2集…' },
  shuffle: { label: '随机打散', desc: '全库打散，一轮播完再洗' },
  weighted: { label: '加权随机', desc: '按频道权重随机抽取' },
  daily: { label: '每日换番', desc: '每天换一部，当天集序随机' },
  daypart: { label: '分时段', desc: '按墙上时间切换子规则（支持跨零点）' },
  manual: { label: '手动节目单', desc: '显式列出要播的集' },
};

const TARGETS = [
  { value: 'count', label: '按集数', unit: '集' },
  { value: 'hours', label: '按小时', unit: '小时' },
  { value: 'minutes', label: '按分钟', unit: '分钟' },
  { value: 'fill', label: '填满当天（日编排）' },
  { value: 'all', label: '播完一轮规则' },
];

/* ------------------------------ 基础工具 ------------------------------ */

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

const fmtDur = (ms) => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
};

const fmtDay = (ms, tz) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return '';
  }
};

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    cache: 'no-store',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(msg, type = 'ok') {
  const box = $('#toast');
  box.textContent = msg;
  box.className = `toast ${type}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, type === 'err' ? 6000 : 3000);
}

const setStatusPill = (state) => {
  const pill = $('#statusPill');
  const lib = state.library;
  if (!state.configured) {
    pill.textContent = '未配置 WebDAV';
    pill.className = 'pill warn';
  } else if (!lib.loaded) {
    pill.textContent = '未扫描媒体库';
    pill.className = 'pill warn';
  } else if (state.scan.running) {
    pill.textContent = '扫描中…';
    pill.className = 'pill warn';
  } else {
    pill.textContent = `就绪 · ${lib.series} 部 / ${lib.episodes} 集`;
    pill.className = 'pill ok';
  }
};

/* ------------------------------ 状态加载 ------------------------------ */

function buildDraft(state) {
  const cfg = state.config;
  const st = state.settings || {};
  const channels = st.channels?.length
    ? clone(st.channels)
    : (state.channels || []).map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        mode: c.mode,
        anchor: c.anchor,
        program: clone(c.program),
      }));
  return {
    webdav: {
      baseUrl: st.webdav?.baseUrl ?? cfg.webdav.baseUrl,
      root: st.webdav?.root ?? cfg.webdav.root,
      username: st.webdav?.username ?? cfg.webdav.username,
      password: '',
      timeoutMs: st.webdav?.timeoutMs ?? cfg.webdav.timeoutMs,
    },
    stream: {
      mode: st.stream?.mode ?? cfg.stream.mode,
      urlPrefix: st.stream?.urlPrefix ?? cfg.stream.urlPrefix ?? '',
      token: '',
      embedCredentials: st.stream?.embedCredentials ?? cfg.stream.embedCredentials,
    },
    timezone: st.timezone ?? cfg.timezone,
    tmdb: { apiKey: '', readToken: '', language: st.tmdb?.language ?? cfg.tmdb.language },
    channels,
    selection: normalizeSelection(st.selection ?? state.selection),
  };
}

const normalizeSelection = (sel) => ({
  mode: sel?.mode === 'include' ? 'include' : 'all',
  series: Array.isArray(sel?.series) ? [...sel.series] : [],
});

async function loadState({ keepDraft = false } = {}) {
  const state = await api('/api/admin/state');
  S.state = state;
  if (!keepDraft) S.draft = buildDraft(state);
  S.activeChannel = S.draft.channels.some((c) => c.id === S.activeChannel)
    ? S.activeChannel
    : S.draft.channels[0]?.id || null;
  setStatusPill(state);
  return state;
}

/* ------------------------------ 概览 ------------------------------ */

function renderOverview() {
  const st = S.state;
  const lib = st.library;
  const tmdb = st.tmdb;
  const cards = [
    { k: '媒体库', v: `${lib.series} 部`, s: `${lib.episodes} 集 · ${fmtDur(lib.totalDurationMs)}` },
    { k: '频道', v: `${S.draft.channels.length} 个`, s: S.draft.channels.map((c) => c.name).join(' / ') || '—' },
    {
      k: '参与编排',
      v: S.draft.selection.mode === 'include' ? `已选 ${S.draft.selection.series.length} 部` : '全部番剧',
      s: S.draft.selection.mode === 'include' ? '在「番剧库」里调整' : '取消勾选即可只播指定的番剧',
    },
    {
      k: 'TMDB',
      v: tmdb.enabled ? '已启用' : '未配置',
      s: tmdb.enabled ? `语言 ${st.config.tmdb.language} · ${tmdb.mode}` : '填 API Key 后显示封面与简介',
    },
  ];
  const box = $('#overviewCards');
  box.innerHTML = '';
  for (const c of cards) {
    box.append(
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'k' }, c.k),
        el('div', { class: 'v' }, c.v),
        el('div', { class: 's' }, c.s || ''),
      ),
    );
  }
  renderNowPlaying();
  renderScan();
}

async function renderNowPlaying() {
  const box = $('#nowPlaying');
  if (!S.state.ready) {
    box.innerHTML = '';
    box.append(el('span', {}, '媒体库还没准备好：先在「配置」里填 WebDAV，再点「开始扫描」。'));
    return;
  }
  try {
    const data = await api(`/api/now?channel=${encodeURIComponent(S.draft.channels[0]?.id || 'main')}`);
    const n = data.now;
    const poster = S.posters.get(n.seriesId)?.poster;
    box.innerHTML = '';
    if (poster) box.append(el('img', { class: 'np-poster', src: poster, alt: n.series }));
    box.append(
      el(
        'div',
        { class: 'np-main' },
        el('div', { class: 'np-title' }, `${n.series} · S${String(n.season).padStart(2, '0')}E${String(n.episode).padStart(2, '0')}`),
        el('div', { class: 'np-sub' }, n.title || n.name),
        el('div', { class: 'np-sub' }, `${n.startText} — ${n.endText} · 已播 ${Math.round(n.offsetMs / 1000)}s / 进度 ${(n.progress * 100).toFixed(1)}%`),
      ),
    );
  } catch (err) {
    box.textContent = `读取当前节目失败：${err.message}`;
  }
}

function renderScan() {
  const scan = S.state.scan;
  const bar = $('#scanBar');
  const status = $('#scanStatus');
  const btn = $('#btnScan');
  if (scan.running) {
    const total = scan.total || 0;
    const done = scan.done || 0;
    const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 3;
    bar.style.width = `${pct}%`;
    status.textContent = `扫描中：${scan.stage || ''} ${total ? `${done}/${total}（${pct}%）` : ''} ${scan.extra || ''}`;
    btn.disabled = true;
    btn.textContent = '扫描中…';
  } else {
    btn.disabled = false;
    btn.textContent = '开始扫描';
    if (scan.error) {
      bar.style.width = '100%';
      bar.style.background = 'var(--danger)';
      status.textContent = `扫描失败：${scan.error}`;
    } else if (scan.finishedAt) {
      bar.style.width = '100%';
      bar.style.background = 'linear-gradient(90deg, var(--accent), var(--accent-2))';
      status.textContent = `上次扫描：${new Date(scan.finishedAt).toLocaleString()} · ${scan.extra || ''}`;
    } else {
      bar.style.width = '0';
      status.textContent = S.state.library.loaded
        ? `已有索引：${S.state.library.series} 部 / ${S.state.library.episodes} 集（${new Date(S.state.library.scannedAt).toLocaleString()}）`
        : '尚未扫描';
    }
  }
}

async function startScan() {
  try {
    await api('/api/admin/scan', { method: 'POST', body: { probe: $('#scanProbe').checked } });
    toast('扫描已启动，进度会实时刷新');
    pollScan();
  } catch (err) {
    toast(`启动扫描失败：${err.message}`, 'err');
  }
}

function pollScan() {
  clearTimeout(S.scanTimer);
  S.scanTimer = setTimeout(async () => {
    try {
      const state = await api('/api/admin/state');
      S.state = state;
      setStatusPill(state);
      renderOverview();
      if (state.scan.running) pollScan();
      else if (!state.scan.error) {
        toast('扫描完成');
        await loadState();
        renderAll();
      }
    } catch {
      pollScan();
    }
  }, 2000);
}

/* ------------------------------ 配置 ------------------------------ */

function fillConfigForm() {
  const d = S.draft;
  $('#cfg-baseUrl').value = d.webdav.baseUrl || '';
  $('#cfg-root').value = d.webdav.root || '';
  $('#cfg-username').value = d.webdav.username || '';
  $('#cfg-password').value = '';
  $('#cfg-password').placeholder = S.state.config.webdav.passwordSet ? '已设置，留空则不修改' : '未设置';
  $('#cfg-timeout').value = d.webdav.timeoutMs || 20000;
  $('#cfg-mode').value = d.stream.mode || 'proxy';
  $('#cfg-prefix').value = d.stream.urlPrefix || '';
  $('#cfg-token').value = '';
  $('#cfg-token').placeholder = S.state.config.stream.tokenSet ? '已设置，留空则不修改' : '可选';
  $('#cfg-embed').checked = Boolean(d.stream.embedCredentials);
  $('#cfg-timezone').value = d.timezone || 'Asia/Shanghai';
  $('#cfg-tmdb-lang').value = d.tmdb.language || 'zh-CN';
  $('#cfg-tmdb-key').value = '';
  $('#cfg-tmdb-key').placeholder = S.state.config.tmdb.enabled ? '已设置，留空则不修改' : '未配置';
  $('#cfg-tmdb-token').value = '';
  $('#cfg-playerUrl').value = `${location.origin}/`;
  updateSaveHints();
}

function bindConfigForm() {
  const read = () => {
    S.draft.webdav.baseUrl = $('#cfg-baseUrl').value.trim();
    S.draft.webdav.root = $('#cfg-root').value.trim();
    S.draft.webdav.username = $('#cfg-username').value.trim();
    S.draft.webdav.timeoutMs = Number($('#cfg-timeout').value) || 20000;
    S.draft.stream.mode = $('#cfg-mode').value;
    S.draft.stream.urlPrefix = $('#cfg-prefix').value.trim();
    S.draft.stream.embedCredentials = $('#cfg-embed').checked;
    S.draft.timezone = $('#cfg-timezone').value.trim() || 'Asia/Shanghai';
    S.draft.tmdb.language = $('#cfg-tmdb-lang').value;
    const pass = $('#cfg-password').value;
    if (pass) S.draft.webdav.password = pass;
    const token = $('#cfg-token').value;
    if (token) S.draft.stream.token = token;
    const key = $('#cfg-tmdb-key').value.trim();
    if (key) S.draft.tmdb.apiKey = key;
    const rt = $('#cfg-tmdb-token').value.trim();
    if (rt) S.draft.tmdb.readToken = rt;
    markDirty('config');
  };
  for (const id of ['cfg-baseUrl', 'cfg-root', 'cfg-username', 'cfg-password', 'cfg-timeout', 'cfg-mode', 'cfg-prefix', 'cfg-token', 'cfg-timezone', 'cfg-tmdb-lang', 'cfg-tmdb-key', 'cfg-tmdb-token']) {
    $(`#${id}`).addEventListener('input', read);
    $(`#${id}`).addEventListener('change', read);
  }
  $('#cfg-embed').addEventListener('change', read);

  $('#btnTmdbTest').addEventListener('click', async () => {
    const btn = $('#btnTmdbTest');
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const body = {};
      const key = $('#cfg-tmdb-key').value.trim();
      const rt = $('#cfg-tmdb-token').value.trim();
      if (key) body.apiKey = key;
      if (rt) body.readToken = rt;
      const r = await api('/api/admin/tmdb/test', { method: 'POST', body });
      $('#tmdbHint').textContent = r.ok ? '✓ TMDB 连接正常' : `✗ ${r.message}`;
      toast(r.ok ? 'TMDB 可用' : r.message, r.ok ? 'ok' : 'err');
    } catch (err) {
      toast(`测试失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '测试 TMDB';
    }
  });

  $('#btnScan').addEventListener('click', startScan);
}

/* ------------------------------ 番剧库 ------------------------------ */

async function loadSeries({ q = '' } = {}) {
  const data = await api(`/api/admin/series?limit=500&q=${encodeURIComponent(q)}`);
  S.allSeries = data.series;
  S.allIds = data.series.map((s) => s.id);
  const sel = normalizeSelection(S.draft.selection);
  S.selected = new Set(sel.mode === 'include' ? sel.series : data.series.map((s) => s.id));
  renderSeries();
  updateSelCount();
}

function renderSeries() {
  const grid = $('#seriesGrid');
  grid.innerHTML = '';
  if (S.allSeries.length === 0) {
    grid.append(el('div', { class: 'empty' }, '媒体库里还没有番剧：先完成扫描。'));
    return;
  }
  for (const s of S.allSeries) {
    const selected = S.selected.has(s.id);
    const card = el(
      'div',
      {
        class: `series-card${selected ? ' selected' : ''}`,
        dataset: { id: s.id },
        onclick: () => toggleSeries(s.id),
        title: s.name,
      },
      el('div', { class: 'tick' }, '✓'),
      el('div', { class: 'poster-empty' }, '▶'),
      el(
        'div',
        { class: 'body' },
        el('div', { class: 'name' }, s.name),
        el(
          'div',
          { class: 'meta' },
          el('span', {}, `${s.episodes} 集`),
          el('span', {}, fmtDur(s.durationMs)),
        ),
      ),
    );
    grid.append(card);
    const cached = S.posters.get(s.id);
    if (cached?.poster) applyPoster(card, cached);
  }
  observePosters();
}

function applyPoster(card, info) {
  if (!info?.poster) return;
  const img = card.querySelector('img.poster');
  if (img) return;
  const placeholder = card.querySelector('.poster-empty');
  const image = el('img', { class: 'poster', src: info.poster, alt: '', loading: 'lazy' });
  if (placeholder) placeholder.replaceWith(image);
  else card.prepend(image);
  if (info.source === 'auto') card.append(el('div', { class: 'badge auto' }, 'TMDB'));
  else if (info.source === 'tag' || info.source === 'manual') card.append(el('div', { class: 'badge' }, 'TMDB'));
}

function observePosters() {
  if (!S.posterObserver) {
    S.posterObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = e.target.dataset.id;
          if (id && !S.posters.has(id)) S.posterQueue.add(id);
          S.posterObserver.unobserve(e.target);
        }
        schedulePosterFetch();
      },
      { rootMargin: '200px' },
    );
  }
  for (const card of $$('.series-card')) S.posterObserver.observe(card);
}

function schedulePosterFetch() {
  clearTimeout(S.posterTimer);
  S.posterTimer = setTimeout(flushPosters, 200);
}

async function flushPosters() {
  const ids = [...S.posterQueue].slice(0, 24);
  if (ids.length === 0) return;
  for (const id of ids) S.posterQueue.delete(id);
  try {
    const data = await api(`/api/admin/posters?ids=${encodeURIComponent(ids.join(','))}`);
    for (const [id, info] of Object.entries(data.posters || {})) {
      S.posters.set(id, info);
      const card = $(`.series-card[data-id="${CSS.escape(id)}"]`);
      if (card) applyPoster(card, info);
    }
    if (!data.tmdb?.enabled) {
      const hint = $('#tmdbHint');
      if (hint && !hint.dataset.warned) {
        hint.textContent = '未配置 TMDB API Key：只显示本地信息，配置后自动补封面与简介。';
        hint.dataset.warned = '1';
      }
    }
  } catch (err) {
    console.warn('封面加载失败', err);
  }
  if (S.posterQueue.size > 0) schedulePosterFetch();
}

function toggleSeries(id) {
  if (S.draft.selection.mode === 'all') {
    // 从「全选」切换到「只选这些」：先全选再去掉一个
    S.draft.selection = { mode: 'include', series: [...S.allIds] };
  }
  const set = new Set(S.draft.selection.series);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  S.draft.selection = { mode: 'include', series: [...set] };
  S.selected = set;
  const card = $(`.series-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.toggle('selected', set.has(id));
  updateSelCount();
  markDirty('series');
}

function updateSelCount() {
  const total = S.allIds.length;
  const n = S.draft.selection.mode === 'include' ? S.draft.selection.series.length : total;
  $('#selCount').textContent = `参与编排：${n} / ${total} 部`;
}

/* ------------------------------ 编排 ------------------------------ */

function renderChannelList() {
  const box = $('#channelList');
  box.innerHTML = '';
  for (const ch of S.draft.channels) {
    const stats = S.state.channels.find((c) => c.id === ch.id)?.stats;
    const sub = stats
      ? stats.mode === 'daily'
        ? `${stats.dayEntries} 条/天`
        : `${stats.cycleEntries} 条 / 约 ${(stats.cycleDurationMs / 86400000).toFixed(1)} 天`
      : '未生效';
    box.append(
      el(
        'button',
        {
          class: `channel-item${ch.id === S.activeChannel ? ' active' : ''}`,
          onclick: () => {
            S.activeChannel = ch.id;
            renderChannelList();
            renderChannelEditor();
          },
        },
        el('span', { class: 'cn' }, ch.name || ch.id),
        el('span', { class: 'cm' }, `${ch.mode === 'daily' ? '按日编排' : '循环'} · ${sub}`),
      ),
    );
  }
}

function targetOf(seg) {
  for (const t of ['count', 'hours', 'minutes', 'fill', 'all']) {
    if (seg[t] !== undefined && seg[t] !== null && seg[t] !== false) return t;
  }
  return 'count';
}

function renderChannelEditor() {
  const box = $('#channelEditor');
  const ch = S.draft.channels.find((c) => c.id === S.activeChannel);
  if (!ch) {
    box.innerHTML = '';
    box.append(el('p', { class: 'hint' }, '还没有频道，点左侧「+ 新建」。'));
    return;
  }
  box.innerHTML = '';

  const head = el(
    'div',
    {},
    el(
      'div',
      { class: 'form-grid' },
      el('label', {}, '频道名称', el('input', { value: ch.name || '', oninput: (e) => { ch.name = e.target.value; renderChannelList(); markDirty('channels'); } })),
      el(
        'label',
        {},
        '编排模式',
        el(
          'select',
          {
            onchange: (e) => {
              ch.mode = e.target.value;
              renderChannelList();
              renderChannelEditor();
              markDirty('channels');
            },
          },
          el('option', { value: 'loop', selected: ch.mode !== 'daily' }, '循环（整库播完回到开头）'),
          el('option', { value: 'daily', selected: ch.mode === 'daily' }, '按日编排（00:00 重排 / 24:00 截断）'),
        ),
      ),
      el('label', {}, '描述', el('input', { value: ch.description || '', oninput: (e) => { ch.description = e.target.value; markDirty('channels'); } })),
      el('label', {}, '时间轴锚点（loop 模式的起点）', el('input', { value: toLocalInput(ch.anchor), type: 'datetime-local', onchange: (e) => { ch.anchor = new Date(e.target.value).toISOString(); markDirty('channels'); } })),
    ),
    el(
      'div',
      { class: 'row-gap mt' },
      el('button', { class: 'btn ghost small', onclick: () => addSegment(ch) }, '+ 添加编排段'),
      el('button', { class: 'btn ghost small', onclick: () => gotoPreview(ch.id) }, '预览这个频道'),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn ghost small danger', onclick: () => removeChannel(ch) }, '删除频道'),
    ),
  );
  box.append(head);

  const list = el('div', { class: 'mt' });
  ch.program.forEach((seg, i) => list.append(renderSegment(ch, seg, i)));
  box.append(list);
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSegment(ch, seg, index) {
  const type = seg.rule?.type || 'sequential';
  const meta = RULE_META[type] || { label: type, desc: '' };
  const target = targetOf(seg);

  const typeSelect = el(
    'select',
    {
      onchange: (e) => {
        seg.rule = { type: e.target.value, ...(e.target.value === 'daypart' ? { slots: defaultSlots() } : {}) };
        markDirty('channels');
        renderChannelEditor();
      },
    },
    ...Object.entries(RULE_META).map(([k, v]) => el('option', { value: k, selected: k === type }, `${v.label}（${k}）`)),
  );

  const targetSelect = el(
    'select',
    {
      onchange: (e) => {
        clearTargets(seg);
        const t = e.target.value;
        if (t === 'count') seg.count = 12;
        else if (t === 'hours') seg.hours = 2;
        else if (t === 'minutes') seg.minutes = 60;
        else if (t === 'fill') seg.fill = true;
        else if (t === 'all') seg.all = true;
        markDirty('channels');
        renderChannelEditor();
      },
    },
    ...TARGETS.map((t) => el('option', { value: t.value, selected: t.value === target }, t.label)),
  );

  const numInput = () => {
    if (target === 'count') return el('input', { type: 'number', min: 1, value: seg.count ?? 12, oninput: (e) => { seg.count = Number(e.target.value) || 1; markDirty('channels'); } });
    if (target === 'hours') return el('input', { type: 'number', min: 0.1, step: 0.5, value: seg.hours ?? 2, oninput: (e) => { seg.hours = Number(e.target.value) || 1; markDirty('channels'); } });
    if (target === 'minutes') return el('input', { type: 'number', min: 1, value: seg.minutes ?? 60, oninput: (e) => { seg.minutes = Number(e.target.value) || 30; markDirty('channels'); } });
    return el('span', { class: 'hint' }, target === 'fill' ? '一直填到当天 24:00' : '规则跑完一轮为止');
  };

  const extras = [];
  if (type === 'sequential' || type === 'binge') {
    extras.push(
      el(
        'label',
        {},
        '系列顺序',
        el(
          'select',
          { onchange: (e) => { seg.rule.order = e.target.value; markDirty('channels'); } },
          el('option', { value: 'config', selected: (seg.rule.order || 'config') === 'config' }, '按片库顺序'),
          el('option', { value: 'name', selected: seg.rule.order === 'name' }, '按名称排序'),
          el('option', { value: 'shuffle', selected: seg.rule.order === 'shuffle' }, '每次随机排序'),
        ),
      ),
    );
  }
  if (type === 'daypart') {
    extras.push(renderSlots(ch, seg));
  }
  if (type === 'manual') {
    extras.push(
      el(
        'label',
        {},
        '节目项（JSON）',
        el('textarea', {
          rows: 4,
          value: JSON.stringify(seg.rule.items || [], null, 2),
          oninput: (e) => {
            try {
              seg.rule.items = JSON.parse(e.target.value);
              markDirty('channels');
            } catch {
              /* 输入过程中允许中间态 */
            }
          },
        }),
      ),
    );
  }

  return el(
    'div',
    { class: 'seg' },
    el(
      'div',
      { class: 'seg-head' },
      el('span', { class: 'idx' }, String(index + 1)),
      el('input', { value: seg.label || '', placeholder: '段名称（展示用）', oninput: (e) => { seg.label = e.target.value; markDirty('channels'); } }),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn ghost small', disabled: index === 0, onclick: () => moveSegment(ch, index, -1) }, '↑'),
      el('button', { class: 'btn ghost small', disabled: index === ch.program.length - 1, onclick: () => moveSegment(ch, index, 1) }, '↓'),
      el('button', { class: 'btn ghost small danger', onclick: () => { ch.program.splice(index, 1); markDirty('channels'); renderChannelEditor(); } }, '删除'),
    ),
    el(
      'div',
      { class: 'seg-grid' },
      el('label', {}, '规则', typeSelect),
      el('label', {}, '段长度', targetSelect),
      el('label', {}, '数量', numInput()),
      el('label', {}, '说明', el('span', { class: 'hint' }, meta.desc)),
    ),
    extras.length ? el('div', { class: 'seg-grid mt' }, ...extras) : null,
  );
}

function renderSlots(ch, seg) {
  const wrap = el('div', { style: 'grid-column: 1 / -1' });
  const slots = seg.rule.slots || [];
  slots.forEach((slot, si) => {
    wrap.append(
      el(
        'div',
        { class: 'slot-row' },
        el('input', { value: slot.from, placeholder: '22:00', oninput: (e) => { slot.from = e.target.value; markDirty('channels'); } }),
        el('input', { value: slot.to, placeholder: '06:00', oninput: (e) => { slot.to = e.target.value; markDirty('channels'); } }),
        el(
          'select',
          { onchange: (e) => { slot.rule = { ...(slot.rule || {}), type: e.target.value }; markDirty('channels'); } },
          ...Object.entries(RULE_META).map(([k, v]) => el('option', { value: k, selected: (slot.rule?.type || 'shuffle') === k }, v.label)),
        ),
        el('input', { value: slot.label || '', placeholder: '档位名', oninput: (e) => { slot.label = e.target.value; markDirty('channels'); } }),
        el(
          'button',
          {
            class: 'btn ghost small danger',
            onclick: () => {
              slots.splice(si, 1);
              markDirty('channels');
              renderChannelEditor();
            },
          },
          '×',
        ),
      ),
    );
  });
  wrap.append(
    el(
      'div',
      { class: 'row-gap mt' },
      el(
        'button',
        {
          class: 'btn ghost small',
          onclick: () => {
            slots.push({ from: '22:00', to: '06:00', label: '新时段', rule: { type: 'shuffle' } });
            markDirty('channels');
            renderChannelEditor();
          },
        },
        '+ 添加时段',
      ),
      el('span', { class: 'hint' }, '时段可跨零点（如 22:00 → 06:00）'),
    ),
  );
  return wrap;
}

function defaultSlots() {
  return [
    { from: '00:00', to: '06:00', label: '深夜档', rule: { type: 'shuffle' } },
    { from: '06:00', to: '12:00', label: '早间档', rule: { type: 'interleave' } },
    { from: '12:00', to: '18:00', label: '午后档', rule: { type: 'weighted' } },
    { from: '18:00', to: '24:00', label: '黄金档', rule: { type: 'sequential', order: 'shuffle' } },
  ];
}

function clearTargets(seg) {
  for (const k of ['count', 'hours', 'minutes', 'durationMs', 'all', 'fill']) delete seg[k];
}

function addSegment(ch) {
  ch.program.push({ label: '新编排段', rule: { type: 'shuffle' }, hours: 2 });
  markDirty('channels');
  renderChannelEditor();
}

function moveSegment(ch, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= ch.program.length) return;
  const [item] = ch.program.splice(i, 1);
  ch.program.splice(j, 0, item);
  markDirty('channels');
  renderChannelEditor();
}

function addChannel() {
  const id = prompt('频道 id（英文字母/数字/短横线）', `ch${S.draft.channels.length + 1}`);
  if (!id) return;
  if (S.draft.channels.some((c) => c.id === id)) {
    toast('频道 id 已存在', 'err');
    return;
  }
  S.draft.channels.push({
    id,
    name: id,
    description: '',
    mode: 'loop',
    anchor: new Date().toISOString(),
    program: [{ label: '系列连播', rule: { type: 'sequential', order: 'name' } }],
  });
  S.activeChannel = id;
  markDirty('channels');
  renderChannelList();
  renderChannelEditor();
}

function removeChannel(ch) {
  if (S.draft.channels.length <= 1) {
    toast('至少保留一个频道', 'err');
    return;
  }
  if (!confirm(`删除频道「${ch.name || ch.id}」？`)) return;
  S.draft.channels = S.draft.channels.filter((c) => c.id !== ch.id);
  S.activeChannel = S.draft.channels[0]?.id || null;
  markDirty('channels');
  renderChannelList();
  renderChannelEditor();
}

/* ------------------------------ 预览 ------------------------------ */

function gotoPreview(channelId) {
  switchTab('preview');
  if (channelId) $('#previewChannel').value = channelId;
  runPreview();
}

function fillPreviewChannels() {
  const sel = $('#previewChannel');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const ch of S.draft.channels) {
    sel.append(el('option', { value: ch.id, selected: ch.id === (cur || S.activeChannel) }, ch.name || ch.id));
  }
}

async function runPreview() {
  const body = $('#previewBody');
  body.innerHTML = '';
  body.append(el('div', { class: 'empty' }, '计算中…'));
  try {
    const data = await api('/api/admin/preview', {
      method: 'POST',
      body: {
        channel: $('#previewChannel').value,
        hours: Number($('#previewRange').value),
        settings: { channels: S.draft.channels, selection: S.draft.selection, timezone: S.draft.timezone },
      },
    });
    S.preview = data;
    renderPreview(data);
  } catch (err) {
    body.innerHTML = '';
    body.append(el('div', { class: 'empty' }, `预览失败：${err.message}`));
  }
}

function renderPreview(data) {
  const meta = $('#previewMeta');
  meta.innerHTML = '';
  const st = data.stats;
  const statsText = st.mode === 'daily' ? `按日编排 · ${st.dayEntries} 条/天` : `循环编排 · ${st.cycleEntries} 条 ≈ ${(st.cycleDurationMs / 86400000).toFixed(1)} 天`;
  meta.append(
    el('span', { class: 'pill ok' }, `${data.channel.name} · ${statsText}`),
    el('span', { class: 'pill' }, `选片池 ${st.poolSeries} 部 / ${st.poolEpisodes} 集`),
    el('span', { class: 'pill' }, `当前：${data.now.startText} — ${data.now.endText}`),
  );

  const tz = data.timezone;
  const table = el(
    'table',
    { class: 'epg' },
    el('thead', {}, el('tr', {}, el('th', {}, '时间'), el('th', {}, '节目'), el('th', {}, '档位'), el('th', {}, '时长'))),
  );
  const tbody = el('tbody', {});
  const nowMs = Date.now();
  for (const item of data.items) {
    const live = nowMs >= item.startsAt && nowMs < item.endsAt;
    tbody.append(
      el(
        'tr',
        { class: live ? 'live' : '' },
        el('td', { class: 'time' }, `${fmtDay(item.startsAt, tz)} ${item.startText}`),
        el(
          'td',
          {},
          el('div', { class: 'name' }, `${item.series} · S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`),
          el('div', { class: 'sub' }, item.title || item.name),
        ),
        el('td', {}, el('span', { class: 'seg-tag' }, item.segmentLabel || '—')),
        el('td', { class: 'time' }, `${Math.round(item.durationMs / 60000)} 分${item.truncated ? '（截断）' : ''}`),
      ),
    );
  }
  table.append(tbody);
  const body = $('#previewBody');
  body.innerHTML = '';
  body.append(table);
  if (data.items.length === 0) body.append(el('div', { class: 'empty' }, '这个时间窗口没有节目'));
}

/* ------------------------------ 保存 ------------------------------ */

function markDirty(area) {
  S.dirty[area] = true;
  updateSaveHints();
}

function updateSaveHints() {
  const map = [
    ['#saveState', 'config'],
    ['#seriesState', 'series'],
    ['#channelState', 'channels'],
  ];
  for (const [sel, area] of map) {
    const node = $(sel);
    if (!node) continue;
    node.textContent = S.dirty[area] ? '有未保存的修改' : '未修改';
    node.className = S.dirty[area] ? 'pill warn' : 'hint';
  }
  $('#btnSave').textContent = S.dirty.config ? '保存设置 *' : '保存设置';
  $('#btnSaveSeries').textContent = S.dirty.series ? '保存选片 *' : '保存选片';
  $('#btnSaveChannels').textContent = S.dirty.channels ? '保存编排 *' : '保存编排';
}

async function saveAll() {
  const payload = {
    webdav: {
      baseUrl: S.draft.webdav.baseUrl,
      root: S.draft.webdav.root,
      username: S.draft.webdav.username,
      timeoutMs: S.draft.webdav.timeoutMs,
    },
    stream: {
      mode: S.draft.stream.mode,
      urlPrefix: S.draft.stream.urlPrefix || '',
      embedCredentials: Boolean(S.draft.stream.embedCredentials),
    },
    timezone: S.draft.timezone,
    tmdb: { language: S.draft.tmdb.language },
    channels: S.draft.channels,
    selection: S.draft.selection,
  };
  if (S.draft.webdav.password) payload.webdav.password = S.draft.webdav.password;
  if (S.draft.stream.token) payload.stream.token = S.draft.stream.token;
  if (S.draft.tmdb.apiKey) payload.tmdb.apiKey = S.draft.tmdb.apiKey;
  if (S.draft.tmdb.readToken) payload.tmdb.readToken = S.draft.tmdb.readToken;

  const buttons = [$('#btnSave'), $('#btnSaveSeries'), $('#btnSaveChannels')];
  for (const b of buttons) b.disabled = true;
  try {
    const resp = await api('/api/admin/settings', { method: 'PUT', body: payload });
    S.state = resp.state;
    S.dirty = { config: false, series: false, channels: false };
    $('#cfg-password').value = '';
    $('#cfg-token').value = '';
    $('#cfg-tmdb-key').value = '';
    $('#cfg-tmdb-token').value = '';
    await loadState();
    renderAll();
    setStatusPill(S.state);
    if (resp.needsScan) {
      toast('已保存。WebDAV 有变化，建议重新扫描媒体库。', 'ok');
    } else {
      toast('已保存');
    }
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  } finally {
    for (const b of buttons) b.disabled = false;
    updateSaveHints();
  }
}

/* ------------------------------ 模板 ------------------------------ */

const PRESETS = [
  {
    name: '整库连播',
    desc: '一部播完接下一部，最省心的默认编排',
    program: [{ label: '系列连播', rule: { type: 'sequential', order: 'name' } }],
    mode: 'loop',
  },
  {
    name: '随机 + 轮播',
    desc: '每轮 2 小时随机打散，再插 6 集跨系列轮播',
    program: [
      { label: '随机档', rule: { type: 'shuffle' }, hours: 2 },
      { label: '轮播档', rule: { type: 'interleave' }, count: 6 },
    ],
    mode: 'loop',
  },
  {
    name: '电视台日编排',
    desc: '深夜随机 / 早间轮播 / 午后加权 / 黄金档连播',
    program: [{ label: '全天', fill: true, rule: { type: 'daypart', slots: defaultSlots() } }],
    mode: 'daily',
  },
  {
    name: '每日一部',
    desc: '每天换一部番，当天集序随机，适合追番节奏',
    program: [{ label: '每日番', fill: true, rule: { type: 'daily' } }],
    mode: 'daily',
  },
];

function openPresets() {
  const layer = el(
    'div',
    { class: 'toast', style: 'right:20px;left:20px;max-width:none;bottom:20px;padding:16px' },
    el('div', { style: 'font-weight:700;margin-bottom:8px' }, '选择编排模板'),
    el(
      'div',
      { class: 'preset-grid' },
      ...PRESETS.map((p) =>
        el(
          'button',
          {
            class: 'preset',
            onclick: () => {
              const ch = S.draft.channels.find((c) => c.id === S.activeChannel);
              if (!ch) return;
              ch.program = clone(p.program);
              ch.mode = p.mode;
              markDirty('channels');
              renderChannelList();
              renderChannelEditor();
              layer.remove();
              toast(`已套用模板：${p.name}`);
            },
          },
          el('div', { class: 'pt' }, p.name),
          el('div', { class: 'pd' }, p.desc),
        ),
      ),
    ),
    el('div', { class: 'row-gap mt' }, el('button', { class: 'btn ghost small', onclick: () => layer.remove() }, '取消')),
  );
  document.body.append(layer);
}

/* ------------------------------ 渲染调度 ------------------------------ */

function switchTab(tab) {
  S.tab = tab;
  for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const v of $$('.view')) v.classList.toggle('active', v.dataset.view === tab);
  if (tab === 'series') loadSeries({ q: $('#seriesSearch').value });
  if (tab === 'channels') {
    renderChannelList();
    renderChannelEditor();
  }
  if (tab === 'preview') {
    fillPreviewChannels();
    runPreview();
  }
  if (tab === 'overview') renderOverview();
}

function renderAll() {
  fillConfigForm();
  renderOverview();
  if (S.tab === 'series') loadSeries({ q: $('#seriesSearch').value });
  if (S.tab === 'channels') {
    renderChannelList();
    renderChannelEditor();
  }
  fillPreviewChannels();
  updateSaveHints();
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  try {
    await loadState();
  } catch (err) {
    document.body.innerHTML = `<div class="empty">加载失败：${err.message}</div>`;
    return;
  }
  bindConfigForm();
  for (const b of $$('.tab')) b.addEventListener('click', () => switchTab(b.dataset.tab));
  $('#btnSave').addEventListener('click', saveAll);
  $('#btnSaveSeries').addEventListener('click', saveAll);
  $('#btnSaveChannels').addEventListener('click', saveAll);
  $('#btnAddChannel').addEventListener('click', addChannel);
  $('#btnPreset').addEventListener('click', openPresets);
  $('#btnPreview').addEventListener('click', runPreview);
  $('#previewChannel').addEventListener('change', runPreview);
  $('#previewRange').addEventListener('change', runPreview);
  $('#selAll').addEventListener('click', () => {
    S.draft.selection = { mode: 'all', series: [] };
    S.selected = new Set(S.allIds);
    for (const card of $$('.series-card')) card.classList.add('selected');
    updateSelCount();
    markDirty('series');
  });
  $('#selNone').addEventListener('click', () => {
    S.draft.selection = { mode: 'include', series: [] };
    S.selected = new Set();
    for (const card of $$('.series-card')) card.classList.remove('selected');
    updateSelCount();
    markDirty('series');
  });
  $('#selFiltered').addEventListener('click', () => {
    const ids = new Set(S.draft.selection.mode === 'include' ? S.draft.selection.series : S.allIds);
    for (const s of S.allSeries) ids.add(s.id);
    S.draft.selection = { mode: 'include', series: [...ids] };
    S.selected = ids;
    for (const card of $$('.series-card')) card.classList.add('selected');
    updateSelCount();
    markDirty('series');
  });
  let searchTimer = null;
  $('#seriesSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadSeries({ q: e.target.value.trim() }), 250);
  });
  renderAll();
  if (S.state.scan.running) pollScan();
}

boot();
