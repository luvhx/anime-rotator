/**
 * 前端播放器
 * ------------------------------------------------------------------
 * 直播模型：时间轴由后端唯一决定。
 *   1. 拉 /api/now 得到「当前节目 + 起止时间 + 已播进度」；
 *   2. video.src 指向 /stream/<fileId>（后端 302 到直链，或直接代理）；
 *   3. 用「结束时间 - 现在」反推播放位置，自动 seek 对齐（不依赖时长估算精度）；
 *   4. 每秒校正一次漂移，每 10 秒刷新节目单。
 */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PREFIX_OVERRIDE = params.get('prefix');

const state = {
  channelId: params.get('channel') || localStorage.getItem('rotator.channel') || null,
  channels: [],
  tz: 'Asia/Shanghai',
  now: null,
  clockOffset: 0,
  started: false,
  userPaused: false,
  activeFileId: null,
  drift: null,
  justLoaded: true,
  switching: false,
  fetchTimer: null,
  fetchPending: false,
  errors: 0,
};

const player = $('player');

/* ------------------------------ 时间 ------------------------------ */

const serverNow = () => Date.now() + state.clockOffset;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtClock(ms) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleTimeString();
  }
}

function fmtHHMM(ms) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

/* ------------------------------ 网络 ------------------------------ */

async function getNow() {
  const q = new URLSearchParams({ channel: state.channelId });
  if (PREFIX_OVERRIDE) {
    q.set('prefix', PREFIX_OVERRIDE);
    q.set('mode', 'direct');
  }
  const res = await fetch(`/api/now?${q}`, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshNow(force = false) {
  if (state.fetchPending && !force) return;
  state.fetchPending = true;
  try {
    const data = await getNow();
    state.errors = 0;
    state.clockOffset = data.serverTime - Date.now();
    state.tz = data.timezone || state.tz;
    const prevId = state.now?.now?.fileId;
    state.now = data;
    hideError();
    applyNow(prevId);
  } catch (err) {
    state.errors++;
    showError(`无法连接后端：${err.message}（第 ${state.errors} 次，稍后自动重试）`);
    setStatus(`后端连接失败：${err.message}`);
    scheduleFetch(3000);
  } finally {
    state.fetchPending = false;
  }
}

function scheduleFetch(delay = 10000) {
  clearTimeout(state.fetchTimer);
  state.fetchTimer = setTimeout(() => refreshNow(), delay);
}

/* ------------------------------ 应用状态 ------------------------------ */

function applyNow(prevFileId) {
  const data = state.now;
  const item = data.now;
  if (!item) return;

  if (item.fileId !== state.activeFileId) {
    loadItem(item, item.fileId !== prevFileId && prevFileId !== undefined);
  }

  $('seriesName').textContent = item.series;
  $('epLabel').textContent = `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
  $('epTitle').textContent = item.title || item.name || '';
  $('segLabel').textContent = item.segmentLabel || '';
  $('segLabel').style.display = item.segmentLabel ? '' : 'none';
  $('directLink').href = item.directUrl || item.streamUrl;
  $('directLink').title = item.relPath;

  $('epgSub').textContent = `${fmtHHMM(item.startsAt)} - ${fmtHHMM(item.endsAt)}`;

  renderEpg();
  updateUi();
  setStatus(
    `${data.channel.name} · ${data.channel.mode === 'daily' ? '按日编排' : '循环编排'}${data.channel.description ? ' · ' + data.channel.description : ''}`,
  );
  scheduleFetch(10000);
}

function loadItem(item, announce) {
  state.activeFileId = item.fileId;
  state.justLoaded = true;
  state.switching = true;
  state.drift = null;
  const url = item.streamUrl || `/stream/${item.fileId}`;
  $('overlay').classList.add('hidden');
  if (announce) setStatus(`切换节目：${item.series} S${item.season}E${item.episode}`);
  player.src = url;
  player.load();
  setTimeout(() => {
    state.switching = false;
  }, 2000);
  if (state.started) {
    player.muted = false;
    tryPlay();
  }
}

function tryPlay() {
  const p = player.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // 浏览器自动播放策略：需要用户手势
      if (!state.started) {
        $('overlay').classList.remove('hidden');
      }
    });
  }
}

/* ------------------------------ 同步 ------------------------------ */

/** 目标播放位置（秒）。优先用「真实时长 - 剩余时间」，这样时长估算不准也能对齐。 */
function targetTime(item, nowMs) {
  const remaining = (item.endsAt - nowMs) / 1000;
  const d = player.duration;
  const hasDuration = Number.isFinite(d) && d > 5;
  const durMatches = hasDuration && Math.abs(d * 1000 - item.durationMs) < 10000;

  if (durMatches) {
    return clamp(d - remaining, 0, d - 0.4);
  }
  const byOffset = (nowMs - item.startsAt) / 1000;
  return clamp(byOffset, 0, hasDuration ? d - 0.4 : byOffset);
}

function tick() {
  const item = state.now?.now;
  if (!item) return;
  const nowMs = serverNow();
  const remainingMs = item.endsAt - nowMs;

  if (remainingMs <= 250) {
    // 本集要结束了，立刻取下一个节目
    scheduleFetch(0);
    return;
  }

  if (state.started && player.readyState >= 1 && !state.userPaused) {
    const target = targetTime(item, nowMs);
    const drift = player.currentTime - target;
    state.drift = drift;
    const threshold = state.justLoaded ? 2.5 : 4;
    if (Math.abs(drift) > threshold) {
      try {
        player.currentTime = target;
      } catch {
        /* 元数据未就绪 */
      }
      state.justLoaded = false;
    } else if (state.justLoaded) {
      state.justLoaded = false;
    }
    if (player.paused && !player.ended) tryPlay();
  }

  updateUi();
}

/* ------------------------------ 渲染 ------------------------------ */

function updateUi() {
  const item = state.now?.now;
  if (!item) return;
  const nowMs = serverNow();
  const elapsed = clamp(nowMs - item.startsAt, 0, item.durationMs);
  const progress = item.durationMs > 0 ? elapsed / item.durationMs : 0;

  $('progressFill').style.width = `${(progress * 100).toFixed(2)}%`;
  $('posText').textContent = `${fmtHHMM(item.startsAt)} · ${fmtDur(elapsed)} / ${fmtDur(item.durationMs)}`;
  $('endText').textContent = `${fmtHHMM(item.endsAt)} 结束`;
  $('clock').textContent = fmtClock(nowMs);

  const sync = $('syncText');
  if (!state.started) {
    sync.textContent = '待开播';
    sync.className = 'sync';
  } else if (state.drift == null) {
    sync.textContent = '同步中…';
    sync.className = 'sync';
  } else {
    const a = Math.abs(state.drift);
    if (a < 1) {
      sync.textContent = '已同步';
      sync.className = 'sync ok';
    } else if (a < 4) {
      sync.textContent = `偏差 ${state.drift > 0 ? '+' : ''}${state.drift.toFixed(1)}s`;
      sync.className = 'sync warn';
    } else {
      sync.textContent = `校正 ${state.drift > 0 ? '+' : ''}${state.drift.toFixed(1)}s`;
      sync.className = 'sync bad';
    }
  }
  $('endText').textContent = `${fmtHHMM(item.endsAt)} 结束`;
}

function renderEpg() {
  const data = state.now;
  if (!data) return;
  const list = $('epgList');
  const items = [data.now, ...(data.next || [])].slice(0, 14);
  list.textContent = '';
  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'epg-item' + (idx === 0 ? ' current' : '');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = idx === 0 ? 'NOW' : fmtHHMM(item.startsAt);
    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${item.series} S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [item.title, item.segmentLabel, item.truncated ? '跨零点截断' : null].filter(Boolean);
    meta.textContent = bits.join(' · ') || item.name;
    body.append(name, meta);
    li.append(t, body);
    list.append(li);
  });
}

function setStatus(text) {
  $('statusText').textContent = text;
}

function showError(msg) {
  const el = $('errorText');
  el.hidden = false;
  el.textContent = msg;
  $('overlay').classList.remove('hidden');
}

function hideError() {
  const el = $('errorText');
  el.hidden = true;
  el.textContent = '';
}

/* ------------------------------ 频道 ------------------------------ */

async function loadConfig() {
  const res = await fetch('/api/config', { cache: 'no-store' });
  const data = await res.json();
  state.tz = data.timezone || state.tz;
  state.channels = data.channels || [];
  if (!state.channelId || !state.channels.some((c) => c.id === state.channelId)) {
    state.channelId = state.channels[0]?.id || 'main';
  }
  $('modeBadge').textContent = PREFIX_OVERRIDE
    ? '直链前缀覆盖'
    : data.stream?.mode === 'proxy'
      ? '后端代理'
      : '302 直链';
  $('tzLabel').textContent = state.tz;
  renderChannels();
  if (data.library) {
    $('libraryInfo').textContent = `库内 ${data.library.series} 部 / ${data.library.episodes} 集 · 前缀 ${
      PREFIX_OVERRIDE || data.stream?.urlPrefix || ''
    }`;
  }
}

function renderChannels() {
  const nav = $('channels');
  nav.textContent = '';
  for (const ch of state.channels) {
    const btn = document.createElement('button');
    btn.className = 'channel' + (ch.id === state.channelId ? ' active' : '');
    btn.textContent = ch.name;
    btn.title = ch.description || ch.name;
    btn.addEventListener('click', () => {
      if (ch.id === state.channelId) return;
      state.channelId = ch.id;
      localStorage.setItem('rotator.channel', ch.id);
      state.activeFileId = null;
      state.now = null;
      state.drift = null;
      state.justLoaded = true;
      for (const b of nav.querySelectorAll('.channel')) b.classList.toggle('active', b === btn);
      setStatus(`切换频道：${ch.name}`);
      refreshNow(true);
    });
    nav.append(btn);
  }
}

/* ------------------------------ 事件 ------------------------------ */

$('startBtn').addEventListener('click', async () => {
  state.started = true;
  state.userPaused = false;
  player.muted = false;
  $('overlay').classList.add('hidden');
  await refreshNow(true);
  tryPlay();
});

player.addEventListener('loadedmetadata', () => {
  state.justLoaded = true;
  const cur = state.now?.now;
  if (cur && state.started) {
    try {
      player.currentTime = targetTime(cur, serverNow());
    } catch {
      /* ignore */
    }
  }
  const item = state.now?.now;
  if (item && Number.isFinite(player.duration) && player.duration > 5) {
    const actual = Math.round(player.duration * 1000);
    // 真实时长与索引差异较大时回写后端，逐步把时间轴校准到准确值
    if (Math.abs(actual - item.durationMs) > 3000) {
      fetch('/api/report-duration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: item.fileId, durationMs: actual }),
      }).catch(() => {});
    }
  }
});

player.addEventListener('play', () => {
  state.userPaused = false;
  state.switching = false;
  $('liveTag').style.opacity = '0.92';
});

player.addEventListener('playing', () => {
  state.switching = false;
});

player.addEventListener('pause', () => {
  if (player.ended || state.switching) return;
  state.userPaused = true;
  $('liveTag').style.opacity = '0.4';
});

player.addEventListener('ended', () => scheduleFetch(0));

player.addEventListener('error', () => {
  const code = player.error?.code;
  const map = {
    1: '播放被终止',
    2: '网络错误（无法连接视频源）',
    3: '解码失败（容器/编码不受支持）',
    4: '视频源不可用（可能 401/404）',
  };
  showError(`播放失败：${map[code] || '未知错误'}${code ? ` (code ${code})` : ''}`);
});

$('resyncBtn').addEventListener('click', () => {
  state.justLoaded = true;
  state.userPaused = false;
  refreshNow(true).then(() => {
    const item = state.now?.now;
    if (item && Number.isFinite(player.duration)) {
      try {
        player.currentTime = targetTime(item, serverNow());
      } catch {
        /* ignore */
      }
    }
    tryPlay();
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    state.justLoaded = true;
    refreshNow(true);
  }
});

/* ------------------------------ 启动 ------------------------------ */

(async function boot() {
  try {
    await loadConfig();
    await refreshNow(true);
    setInterval(tick, 1000);
  } catch (err) {
    showError(`启动失败：${err.message}`);
    setStatus('启动失败，请检查后端与节目库索引');
  }
})();
