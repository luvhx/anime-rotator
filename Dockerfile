# syntax=docker/dockerfile:1

###############################################################################
# 番剧轮播 · Anime Rotator
# 零依赖 Node 应用：无需 npm install，单阶段镜像
###############################################################################
FROM node:22-alpine

LABEL org.opencontainers.image.title="anime-rotator" \
      org.opencontainers.image.description="WebDAV 动画库轮播：多规则编排时间轴，按时间定位视频与进度，支持 302 直链" \
      org.opencontainers.image.source="https://github.com/OWNER/anime-rotator" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8088 \
    CONFIG_PATH=/app/config.json \
    SCAN_ON_START=auto \
    NODE_OPTIONS=--max-old-space-size=512

WORKDIR /app

# 以 root 安装 su-exec：入口脚本借此修正挂载目录权限后降权到 app 用户运行
RUN apk add --no-cache su-exec

# 应用本体
COPY package.json ./
COPY src ./src
COPY public ./public
COPY tools ./tools

# 容器内默认配置：频道编排已内置，WebDAV 地址/账号由环境变量注入
COPY config.compose.json ./config.json
COPY config.example.json ./config.example.json

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data \
    && addgroup -S app && adduser -S -G app app \
    && chown -R app:app /app

EXPOSE 8088
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8088)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/cli/serve.mjs"]
