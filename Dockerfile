FROM oven/bun:1.3.10-slim
WORKDIR /app

# 先装依赖（利用缓存层）
COPY package.json bun.lock bunfig.toml ./
COPY standalone/space-sdk ./standalone/space-sdk
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "standalone/server.ts"]
