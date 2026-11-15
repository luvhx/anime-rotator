import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTimeZone } from './util.mjs';
import { normalizeChannel } from './scheduler.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG = {
  server: { host: '0.0.0.0', port: 8088, publicDir: 'public' },
  timezone: 'Asia/Shanghai',
  webdav: {
    baseUrl: '',
    root: '',
    username: '',
    password: '',
    timeoutMs: 20000,
  },
  paths: {
    library: 'data/library.json',
    durations: 'data/durations.json',
  },
  stream: {
    // redirect = 302 直链（默认，最快，客户端直连 WebDAV）
    // proxy    = 后端代理（可注入鉴权头、可跨域，占用后端带宽）
    mode: 'redirect',
    // 自定义前端读取视频文件时的 URL 前缀；null 表示用 webdav.baseUrl
    urlPrefix: null,
    // 302 时是否把账号密码嵌进 URL（部分播放器/Docker 场景需要）
    embedCredentials: false,
    // 302/直链追加的查询串，例如 CDN 鉴权 token
    token: null,
    // proxy 模式下是否透传 Range（必须开，否则不能拖动进度）
    passRange: true,
    // 额外响应头
    headers: {},
  },
  library: {
    fallbackDurationMs: 24 * 60 * 1000,
  },
  channels: [],
};

function deepMerge(base, patch) {
  if (patch == null) return base;
  if (Array.isArray(patch)) return patch.slice();
  if (typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * 环境变量覆盖：容器化部署时无需改动配置文件即可注入地址与账号
 *
 *   CONFIG_PATH / PORT / HOST / TIMEZONE
 *   WEBDAV_BASE_URL / WEBDAV_ROOT / WEBDAV_USERNAME / WEBDAV_PASSWORD
 *   STREAM_MODE / STREAM_URL_PREFIX / STREAM_TOKEN / STREAM_EMBED_CREDENTIALS
 *   LIBRARY_PATH / DURATIONS_PATH
 */
export function applyEnvOverrides(config, env = process.env) {
  const truthy = (v) => v === '1' || /^(true|yes|on)$/i.test(String(v));
  if (env.PORT) config.server.port = Number(env.PORT);
  if (env.HOST) config.server.host = env.HOST;
  if (env.TIMEZONE) config.timezone = env.TIMEZONE;
  if (env.WEBDAV_BASE_URL) {
    const prevBase = config.webdav.baseUrl;
    config.webdav.baseUrl = env.WEBDAV_BASE_URL;
    // 前缀若还是旧 baseUrl 的默认值，跟着一起改
    if (!env.STREAM_URL_PREFIX && (!config.stream.urlPrefix || config.stream.urlPrefix === prevBase)) {
      config.stream.urlPrefix = env.WEBDAV_BASE_URL;
    }
  }
  if (env.WEBDAV_ROOT != null && env.WEBDAV_ROOT !== '') config.webdav.root = env.WEBDAV_ROOT;
  if (env.WEBDAV_USERNAME != null) config.webdav.username = env.WEBDAV_USERNAME;
  if (env.WEBDAV_PASSWORD != null) config.webdav.password = env.WEBDAV_PASSWORD;
  if (env.WEBDAV_TIMEOUT_MS) config.webdav.timeoutMs = Number(env.WEBDAV_TIMEOUT_MS);
  if (env.STREAM_MODE) config.stream.mode = env.STREAM_MODE;
  if (env.STREAM_URL_PREFIX) config.stream.urlPrefix = env.STREAM_URL_PREFIX;
  if (env.STREAM_TOKEN) config.stream.token = env.STREAM_TOKEN;
  if (env.STREAM_EMBED_CREDENTIALS != null) config.stream.embedCredentials = truthy(env.STREAM_EMBED_CREDENTIALS);
  if (env.LIBRARY_PATH) config.paths.library = env.LIBRARY_PATH;
  if (env.DURATIONS_PATH) config.paths.durations = env.DURATIONS_PATH;
  return config;
}

export function resolvePath(p, root = PROJECT_ROOT) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

/**
 * 读取并校验配置
 * @param {string} [file]
 */
export function loadConfig(file) {
  // 配置文件查找顺序：显式参数 → CONFIG_PATH → config.json → config.example.json（容器内可用环境变量完全接管）
  const explicit = file || process.env.CONFIG_PATH;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(PROJECT_ROOT, 'config.json'), path.join(PROJECT_ROOT, 'config.example.json')];
  const configPath = candidates.find((p) => fs.existsSync(p));
  if (!configPath) {
    throw new Error(`找不到配置文件（尝试过：${candidates.join(', ')}），可复制 config.example.json 后修改`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = deepMerge(DEFAULT_CONFIG, raw);
  applyEnvOverrides(config);
  const root = path.dirname(configPath);
  config.__file = configPath;
  config.__root = root;
  config.paths.library = resolvePath(config.paths.library, root);
  config.paths.durations = resolvePath(config.paths.durations, root);
  config.server.publicDir = resolvePath(config.server.publicDir, root);

  if (!config.webdav.baseUrl) {
    throw new Error('webdav.baseUrl 不能为空（可在 config.json 里配置，或设置环境变量 WEBDAV_BASE_URL）');
  }
  if (!isValidTimeZone(config.timezone)) throw new Error(`无效时区：${config.timezone}`);

  // 频道：允许值简写为单个对象
  const channels = Array.isArray(config.channels) ? config.channels : config.channels ? [config.channels] : [];
  const ids = new Set();
  config.channels = channels.map((def) => {
    const ch = normalizeChannel(def, config.timezone);
    if (ids.has(ch.id)) throw new Error(`频道 id 重复：${ch.id}`);
    ids.add(ch.id);
    return ch;
  });
  if (config.channels.length === 0) {
    config.channels = [normalizeChannel({ id: 'main', name: '全部轮播', program: [{ rule: { type: 'sequential' } }] })];
  }

  // 默认流前缀 = WebDAV 根地址
  if (!config.stream.urlPrefix) config.stream.urlPrefix = config.webdav.baseUrl;
  if (!['redirect', 'proxy'].includes(config.stream.mode)) {
    throw new Error(`stream.mode 只能是 redirect 或 proxy，收到：${config.stream.mode}`);
  }
  return config;
}
