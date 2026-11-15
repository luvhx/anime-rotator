# 番剧轮播 · Anime Rotator

[![build](https://github.com/luvhx/anime-rotator/actions/workflows/build.yml/badge.svg)](https://github.com/luvhx/anime-rotator/actions/workflows/build.yml)

把 WebDAV 上的动画库变成一条**永不落幕的直播频道**：后端按多种规则编排播出时间表，任意时刻都能算出「现在在播哪一集、播到了第几秒」；前端打开就是直播，自动定位到当前进度，并提供 302 直链播放与自定义 URL 前缀。

```
WebDAV 媒体库 ──scan──> data/library.json（含每集真实时长）
                              │
                    ┌─────────┴─────────┐
                    │   编排引擎（多种规则）│
                    └─────────┬─────────┘
                              │  时间轴：entry = {视频文件, 起始时刻, 时长}
                    ┌─────────┴─────────┐
   /api/now ◀───────│  按「现在」定位     │───────> 302 直链 / 代理
   /api/schedule ◀──│  文件 + 播放进度    │
                    └───────────────────┘
```

核心思路：**时间轴是唯一事实来源**。客户端不做任何编排计算，只问后端「现在是什么、还剩多久」，然后用 `真实时长 − 剩余时间` 反推应播放的位置，所以即使索引里的时长有误差也能自动对齐。

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 多规则编排 | 顺序连播 / 跨系列轮播 / 随机打散 / 权重随机 / 每日换番 / 分时段编排 / 手动节目单，可任意组合成节目段 |
| 两种时间轴 | `loop` 固定循环（O(1) 定位，适合整库连播）；`daily` 按自然日编排（适合黄金档/深夜档，跨零点自动截断） |
| 确定性随机 | 同一频道 + 同一循环/同一天永远得到同一编排，重启不变、可复现 |
| 无 ffprobe 取时长 | 直接解析 MKV(EBML)/MP4(mvhd) 容器头，只需 Range 读几十 KB，不下载整集 |
| 秒级定位 | 二分查找时间轴，`/api/now` 返回文件、起止时间、已播偏移、进度、下集列表 |
| 302 直链 | `/stream/<fileId>` 直接 302 到 WebDAV/CDN 地址，后端零带宽；也可切 `proxy` 模式由后端转发 |
| 自定义 URL 前缀 | 前端读取视频文件的地址前缀可配置（CDN、反代、内网域名），支持逐请求覆盖 |
| 前端自动同步 | 打开即在播，每秒校正漂移，可手动「重新同步」；播放器回写真实时长帮助索引自愈 |

---

## 快速开始

```bash
cp config.example.json config.json   # 填 WebDAV 地址与账号
npm run scan                         # 扫描媒体库 + 解析时长（首次约 25 分钟 / 4000 集，之后走缓存）
npm start                            # 启动，默认 http://127.0.0.1:8088
```

> 本机实测（115 WebDAV / 158 部动画）：3993 集、1415 小时（约 59 天）、2.6 TB；时长 100% 由容器头解析（0 集估算）。首次扫描 1680 s，重扫 145 s。
>
> 默认 `stream.mode` 用 `proxy`（后端带凭据转发），保证浏览器开箱能播；WebDAV 免鉴权或前面挂了解析鉴权的反代时，改成 `redirect` 更省带宽：
> `npm start -- --mode redirect --prefix https://media.example.com/anime`。

没有第三方依赖，Node.js ≥ 20 即可（用到内置 `fetch`）。

### 常用命令

```bash
npm run scan -- --concurrency 12     # 加大并发加速扫描
npm run scan -- --no-probe           # 只建索引不探时长（按码率估算，快但精度低）
npm run plan -- --stats              # 查看各频道编排规模
npm run plan -- --channel daily --date 2026-11-15    # 打印某天的节目单
npm run plan -- --channel mix --at "2026-11-15T21:30:00+08:00" --hours 6
npm start -- --port 9000
npm run smoke                        # 接口 + 前端链路自检（服务需已启动）
npm test                             # 编排引擎自检（不联网，CI 同款）
```

---

## Docker 部署（预构建镜像）

镜像：`ghcr.io/luvhx/anime-rotator`（`latest` / `1.0.0` / `main`，linux/amd64 + linux/arm64，压缩后约 59 MB，零依赖，**公开可匿名拉取**）

### 三步启动

```bash
git clone https://github.com/luvhx/anime-rotator.git && cd anime-rotator
cp .env.example .env        # 填 WEBDAV_BASE_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD
docker compose up -d
```

打开 `http://<宿主机>:8088/`。

首次启动没有索引时会自动扫描（`SCAN_ON_START=auto`），大库可能几十分钟：

```bash
docker compose logs -f                                   # 看扫描进度
docker compose run --rm anime-rotator node src/cli/scan.mjs   # 单独跑一次扫描（不影响服务）
docker compose restart anime-rotator                     # 扫完重启加载新索引
```

索引与时长缓存落在宿主机 `./data/`（挂载卷），重启不会重扫。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8088` | 宿主机端口 |
| `TZ` / `TIMEZONE` | `Asia/Shanghai` | 容器时区 / 编排时区 |
| `WEBDAV_BASE_URL` | — | **必填**，如 `http://192.168.1.10:19798/dav/115/Media` |
| `WEBDAV_ROOT` | `动画` | baseUrl 下的节目根目录 |
| `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` | — | WebDAV 账号 |
| `STREAM_MODE` | `proxy` | `proxy` 后端转发（开箱可播）/ `redirect` 302 直链 |
| `STREAM_URL_PREFIX` | 跟随 baseUrl | 302 直链前缀，可指向 CDN / 反代 |
| `STREAM_TOKEN` | 空 | 直链追加的鉴权串 |
| `SCAN_ON_START` | `auto` | `auto` 没索引才扫 / `always` 每次启动都扫 / `never` 只起服务 |
| `IMAGE` | 预构建镜像 | 换成自己的镜像地址 |

不想用环境变量注入，也可以把 `config.compose.json` 复制成 `config.json` 改好，再打开 compose 里的挂载行：

```yaml
volumes:
  - ./data:/app/data
  - ./config.json:/app/config.json:ro
```

### 定时重扫（新增番剧自动进时间轴）

```bash
docker compose --profile recurring up -d     # 起一个每天重扫的 sidecar
```

sidecar 扫完会调用 `POST /api/reload` 让主服务热加载，不用重启；手动重扫后也可以这样刷新：

```bash
docker compose exec anime-rotator node src/cli/scan.mjs
curl -X POST http://127.0.0.1:8088/api/reload
```

### 本地构建镜像

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### 反向代理（可选）

`proxy` 模式下浏览器只跟同源的回环地址通信，前面加一层 TSSL 即可：

```caddy
anime.example.com {
    reverse_proxy 127.0.0.1:8088
}
```

若想用 `redirect` 直链又需要鉴权，让反代注入凭据并设置 `STREAM_URL_PREFIX` 指向它：

```nginx
location /media/ {
    proxy_pass http://192.168.1.10:19798/dav/115/Media/;
    proxy_set_header Authorization "Basic <base64(账号:密码)>";
    proxy_set_header Range $http_range;
    proxy_buffering off;
    add_header Access-Control-Allow-Origin *;
}
```

```bash
STREAM_MODE=redirect
STREAM_URL_PREFIX=https://anime.example.com/media
```

### CI / 镜像说明

`.github/workflows/build.yml`：push 到 `main` 或打 `v*` tag 时，先跑语法检查 + 编排自检（`tools/selftest.mjs`，不联网），再构建 amd64/arm64 镜像推送到 GHCR。

镜像当前是公开的（已验证匿名 `tags/list` 返回 200）。若你 fork 后自己发布，记得在仓库 **Packages → 该镜像 → Package settings** 里把可见性设为 public，否则 `docker compose` 拉取前需要 `docker login ghcr.io`：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <用户名> --password-stdin
```

---

## 工作原理

### 1. 索引（scan）

- 递归 `PROPFIND` 列出 `动画/` → 系列目录 → `Season N/` → 视频文件，按 `SxxExx` 解析季/集/标题，自动关联同名 `.ass/.srt` 字幕。
- 时长通过 **HTTP Range 读取容器头** 得到：
  - Matroska：`Segment > Info > Duration × TimecodeScale`
  - MP4/MOV：`moov > mvhd`（头里没有就再读尾部 2 MB）
  - 其它容器：按码率估算，并在前端播放时用 `<video>.duration` 自动回写校正
- 结果写入 `data/library.json`，时长缓存 `data/durations.json`（按 `路径|大小` 缓存，重复扫描秒过）。

### 2. 编排（program）

一个频道 = 一串「节目段」，每段由一条规则生成，段之间首尾相接：

```jsonc
"program": [
  { "label": "随机档", "rule": { "type": "shuffle" },  "hours": 2 },  // 播 2 小时
  { "label": "轮播档", "rule": { "type": "interleave" }, "count": 6 } // 再播 6 集
]
```

段的长度目标：`count`（集数）/ `minutes`、`hours`、`durationMs`（时长）/ `all`（规则跑完一轮）/ `fill`（填满当天，仅 daily 模式）。

**loop 模式**：从 `anchor` 开始把 program 展开成一个完整循环（整库播一遍），总长 `cycleLen`；任意时刻的位置 = `(now − anchor) mod cycleLen`，因此后续年份也能瞬间定位。
**daily 模式**：每天 00:00 重新展开当天节目，填满 24 小时，跨零点的节目在 24:00 截断（标记 `truncated`）；随机种子包含日期，所以每天编排不同但可复现。

### 3. 定位（/api/now）

```js
const r = timeline.resolve(Date.now());
// r = { episode, startsAt, endsAt, durationMs, offsetMs, remainingMs, progress, truncated }
```

后端只返回**事实**：这一集几点开始、几点结束、现在播到第几毫秒。

### 4. 前端同步

```js
// 时长可信时：用「真实时长 − 剩余时间」，对索引时长的误差免疫
target = video.duration - (endsAt - now) / 1000;
// 时长不可信（跨零点截断等）：退回按偏移
target = (now - startsAt) / 1000;
if (Math.abs(video.currentTime - target) > 4) video.currentTime = target;  // 每秒检查
```

- 每 10 秒刷新一次 `/api/now`（拿到下集列表、续期 `endsAt`）；
- 用后端 `serverTime` 校准本地时钟偏移，客户端改系统时间也不会错位；
- 快播完（剩余 < 250ms）时立刻拉下一集并换源，切集无感；
- `<video>.duration` 与索引时长差 > 3 秒时 POST `/api/report-duration` 回写，索引逐步自愈。

---

## 配置

```jsonc
{
  "server": { "host": "0.0.0.0", "port": 8088, "publicDir": "public" },
  "timezone": "Asia/Shanghai",          // 编排与展示使用的时区
  "webdav": {
    "baseUrl": "http://192.168.1.10:19798/dav/115/Media",
    "root": "动画",                      // baseUrl 下的节目根目录
    "username": "...", "password": "...",
    "timeoutMs": 20000
  },
  "paths": { "library": "data/library.json", "durations": "data/durations.json" },
  "stream": {
    "mode": "redirect",                  // redirect(302 直链) | proxy(后端转发)
    "urlPrefix": "http://192.168.1.10:19798/dav/115/Media",  // 前端读取视频的 URL 前缀
    "embedCredentials": false,           // 302 时把账号密码嵌进 URL
    "token": null,                       // 追加鉴权串，如 "xxx" 或 "?sign=..."
    "passRange": true,                   // proxy 模式透传 Range（拖动必需）
    "headers": {}                        // proxy 模式追加响应头
  },
  "library": { "fallbackDurationMs": 1440000 },  // 探测失败时的兜底时长
  "channels": [ /* 见下节 */ ]
}
```

---

## 编排规则

| 类型 | 作用 | 主要参数 | 是否有限 |
| --- | --- | --- | --- |
| `sequential` | 按系列顺序，一部播完再接下一部（整季连播） | `series`、`order: config\|name\|shuffle`、`shuffleEpisodes` | ✅ 一轮 = 全库 |
| `binge` | `sequential` 的别名，语义上表示「一口气播完一部」 | 同上 | ✅ |
| `interleave` | 轮播：A 第1集 → B 第1集 → C 第1集 → A 第2集… | `series` | ✅ |
| `shuffle` | 全集随机打散，一轮播完重新洗牌 | `series`、`seed` | ✅ |
| `weighted` | 按系列权重随机抽取（同一部可重复出现） | `series`、频道级 `weights` | ❌ 无限 |
| `daily` | 每天换一部番，当天集序随机 | `series` | ❌ 无限 |
| `daypart` | 按墙上时间分时段，各时段用不同子规则 | `slots: [{from,to,rule,label}]` | 由子规则决定 |
| `manual` | 显式节目单 | `items: [{series,season,episode}]` 或 `{fileId}` | ✅ |

通用参数：`label`（前端展示的档位名）、`loop`（规则跑完后换种子重来）、`fill`（填满当天）。

频道级过滤与权重：

```jsonc
{
  "id": "noir",
  "name": "深夜档",
  "mode": "daily",
  "library": { "series": ["命运石之门", "寒蝉"], "exclude": ["孤独摇滚"], "minEpisodes": 12 },
  "weights": { "冰菓": 3, "夏日重现": 1 },
  "program": [ ... ]
}
```

> `library.series` 支持 `series:` 前缀与模糊匹配（`library.resolve()`），例如 `"series:冰菓"`、`"孤独"`。

### 编排示例

**A. 整库顺序连播（默认）**

```jsonc
{ "id": "main", "mode": "loop", "anchor": "2026-01-01T00:00:00+08:00",
  "program": [{ "rule": { "type": "sequential", "order": "name" } }] }
```

**B. 随机 2 小时 + 轮播 6 集，循环交替**

```jsonc
{ "id": "mix", "mode": "loop", "anchor": "2026-01-01T00:00:00+08:00",
  "program": [
    { "label": "随机档", "rule": { "type": "shuffle" }, "hours": 2 },
    { "label": "轮播档", "rule": { "type": "interleave" }, "count": 6 }
  ] }
```

**C. 按日编排的「电视台」：深夜随机、黄金档连播**

```jsonc
{ "id": "daily", "mode": "daily",
  "program": [{
    "fill": true,
    "rule": { "type": "daypart", "slots": [
      { "from": "00:00", "to": "06:00", "label": "深夜档", "rule": { "type": "shuffle" } },
      { "from": "06:00", "to": "12:00", "label": "早间档", "rule": { "type": "interleave" } },
      { "from": "12:00", "to": "18:00", "label": "午后档", "rule": { "type": "weighted" } },
      { "from": "18:00", "to": "24:00", "label": "黄金档", "rule": { "type": "sequential", "order": "shuffle" } }
    ]}
  }] }
```

**D. 手动节目单（一次性活动频道）**

```jsonc
{ "id": "event", "mode": "loop", "anchor": "2026-12-24T19:00:00+08:00",
  "program": [{
    "rule": { "type": "manual", "items": [
      { "series": "命运石之门", "season": 1, "episode": 1 },
      { "series": "命运石之门", "season": 1, "episode": 2 }
    ]}, "loop": true
  }] }
```

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、库统计 |
| GET | `/api/config` | 前端引导信息（频道、时区、流模式、前缀） |
| GET | `/api/channels` | 各频道编排规模（循环条数/天数、池大小） |
| GET | `/api/now?channel=main` | **当前节目**：文件、起止时间、已播偏移、进度、接下来 12 条 |
| GET | `/api/schedule?channel=main&from=&to=` | 节目单（支持 `date=YYYY-MM-DD`、`limit`） |
| GET | `/api/library?q=` | 媒体库系列列表 |
| POST | `/api/report-duration` | 前端回写真实时长 `{fileId, durationMs}`（异常值会被拒绝） |
| POST | `/api/reload` | 重新加载 `library.json` 并重建时间轴（重扫后热更新，无需重启） |
| GET | `/stream/<fileId>` | **302** 到直链，或（proxy 模式）转发视频字节流 |

`/api/now` 响应节选：

```jsonc
{
  "serverTime": 1794749813351,
  "timezone": "Asia/Shanghai",
  "channel": { "id": "mix", "name": "混编轮播", "mode": "loop" },
  "now": {
    "fileId": "aep2000000", "series": "冰菓", "season": 1, "episode": 2, "title": "第2话",
    "streamUrl": "/stream/aep2000000",
    "directUrl": "http://192.168.1.10:19798/dav/115/Media/%E5%8A%A8%E7%94%BB/...",
    "startsAt": 1794748600000, "endsAt": 1794750000000,
    "durationMs": 1400000, "offsetMs": 1213351, "remainingMs": 186649,
    "progress": 0.867, "truncated": false, "segmentLabel": "轮播档"
  },
  "next": [ /* 接下来 12 条，字段同上 */ ]
}
```

前端也可以自己算地址：`directUrl` 已按配置的前缀拼好，直接丢给 `<video src>` 即可。

---

## 302 直链与自定义 URL 前缀

### 302 直链

```
浏览器 GET /stream/<fileId>
        └─> 302 Location: <urlPrefix>/<编码后的文件相对路径>[?token=...]
```

- 后端不转发字节，零带宽开销，天然支持 Range 拖动。
- `urlPrefix` 就是「前端读取视频文件时的 URL 前缀」，可以指向：
  - WebDAV 本身：`http://192.168.1.10:19798/dav/115/Media`
  - 带鉴权的反向代理 / CDN：`https://media.example.com/anime`
  - 站内路径：`/dav/115/Media`（同源，免 CORS）
- 前缀已经包含根目录（如 `.../Media/动画`）时不会重复拼接。
- 支持逐请求覆盖：`/stream/<fileId>?prefix=https://cdn.example.com/v` 或 `/api/now?...&prefix=...&mode=direct`。

> **鉴权提醒**：302 的目标地址需要浏览器能直接访问。若 WebDAV 需要 Basic 认证，浏览器不会替 `<video>` 自动带上凭据，此时三选一：
> 1. `"embedCredentials": true`（把账号密码拼进 URL，部分浏览器会拦截）；
> 2. 在前面加一层会注入 `Authorization` 的反向代理（推荐，见下方 nginx 示例）；
> 3. 改用 `"mode": "proxy"`，由后端带凭据转发。

### 代理模式

```jsonc
"stream": { "mode": "proxy", "passRange": true }
```

> 本仓库 `config.json` 默认就是 `proxy`，因为目标 WebDAV 需要 Basic 认证；这也是本机浏览器能直接播的唯一免配置方式。

后端带 `Authorization` 向 WebDAV 发 `Range` 请求并原样回传 `206/Content-Range`，浏览器看到的是同源地址，没有鉴权与跨域问题；代价是流量经过后端。

### nginx 反代示例（让 302 直链可用）

```nginx
location /media/ {
    proxy_pass http://192.168.1.10:19798/dav/115/Media/;
    proxy_set_header Authorization "Basic <base64(账号:密码)>";
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_buffering off;
    add_header Access-Control-Allow-Origin *;
}
```

配置里写 `"urlPrefix": "https://media.example.com/media"`，302 就会指向这层反代，浏览器无需任何凭据。

---

## 目录结构

```
番剧轮播/
├── config.json                # 本地运行配置（含 WebDAV 账号，已 gitignore）
├── config.example.json        # 配置模板
├── config.compose.json        # 容器内默认配置（频道已内置，账号走环境变量）
├── Dockerfile                 # 预构建镜像（node:22-alpine，零依赖）
├── docker-compose.yml         # 预构建镜像部署
├── docker-compose.build.yml   # 本地构建覆盖层
├── docker-entrypoint.sh       # 首次启动自动扫描
├── .env.example               # compose 环境变量模板
├── .github/workflows/build.yml # CI：自检 + 多架构镜像推送 GHCR
├── data/
│   ├── library.json           # 扫描产物：系列/季/集/时长
│   └── durations.json         # 时长缓存（路径|大小 → 毫秒）
├── public/                    # 前端（原生 JS，无构建）
│   ├── index.html
│   ├── app.js                 # 拉时间轴、换源、seek 同步、节目单渲染
│   └── style.css
├── tools/
│   ├── smoke-api.mjs          # 接口端到端检查
│   ├── smoke-frontend.mjs     # 无浏览器前端冒烟（DOM 桩 + 真实 API）
│   └── selftest.mjs           # 编排引擎自检（CI 用，不联网）
└── src/
    ├── webdav.mjs             # PROPFIND / Range GET 客户端
    ├── probe.mjs              # MKV(EBML) / MP4(mvhd) 时长解析
    ├── library.mjs            # 扫描、索引、时长缓存、库对象
    ├── scheduler.mjs          # 编排规则 + 时间轴（loop / daily）
    ├── stream.mjs             # 302 直链、前缀拼接、代理转发
    ├── server.mjs             # 路由与 API
    ├── config.mjs             # 配置加载与校验
    └── cli/
        ├── scan.mjs           # 建索引
        ├── plan.mjs           # 预览节目单
        └── serve.mjs          # 启动服务
```

---

## 自检

```bash
npm run smoke
```

- `smoke-api`：时钟一致性（两次 /api/now 的 offset 增量 = 真实间隔）、节目单首尾相接、当天不超过 24:00、Range 返回 206 且是真实 MKV 字节、404 分支。
- `smoke-frontend`：用最小 DOM 桩加载 `public/app.js`，验证「取时间轴 → 设置 src → seek 到直播位置 → 漂移重同步」。

本机运行结果：15 项接口检查 + 11 项前端检查全部通过。

## 常见问题

**时长不准怎么办？** 首选让 `scan` 完整跑完（解析容器头）。若某些文件探不到，前端播放时会用真实 `duration` 回写，索引会自动修正；只是回写前的那段时间轴可能有偏移。

**为什么节目单里有的节目被截断？** `daily` 模式在 24:00 硬截断，模拟真实电视台换日；被截断的节目 `truncated: true`，前端按偏移播放而不是按剩余时长。

**能边播边生成吗？** 编排是纯计算（几千条毫秒级），时间轴按需展开并缓存，不依赖后台定时任务；`loop` 模式用取模，跑几年也不会变慢。

**多个频道会重复扫描吗？** 不会，库只扫一次，所有频道共享同一份索引，各自维护自己的时间轴。

**前端回写时长会不会把时间轴搞乱？** 不会：索引里的时长来自容器解析时，只有落在 0.6x～1.4x 区间的回写才会被接受，超出范围（异常播放器、截断流）直接拒绝并返回 `{ignored:true, reason:"outlier"}`。

**换机器/换端口后 302 地址不对？** 改 `stream.urlPrefix`（或 `stream.mode`），不用重新扫描。

---

## 已知限制

- 只扫描 `root/系列/Season N/文件` 两层结构（系列根目录下的散文件也会被纳入）。
- AVI/RMVB 等容器不易解析时长，会走估算 + 前端回写。
- `daily` 模式的「跨零点截断」意味着深夜档可能只播半集，这是电视台行为，不是 bug。
- 播放器依赖浏览器解码能力（MKV 建议 H.264/VP9 + AAC/Opus；HEVC 视浏览器而定）。
