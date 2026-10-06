# syntax=docker/dockerfile:1
# Etkin WMS — tek imaj, iki süreç (T-010 / ADR-013): Fly `processes` web ve worker'ı bu imajdan
# farklı komutla başlatır (fly.staging.toml). ENTRYPOINT yok: süreç komutu doğrudan çalışır.
#
# Taban imaj etiket + digest ile sabit (çok mimarili indeks digest'i). Kaynak: Docker Hub
# `library/node:24.21.0-trixie-slim`; mirror.gcr.io aynı digest'i sunar (2026-10-05 doğrulandı) ve
# Docker Hub 429 sınırına takılmaz. Node sürümü package.json `engines` (>=24 <25) ile uyumlu.
ARG NODE_IMAGE=mirror.gcr.io/library/node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
# .pnpmfile.cjs / pnpmfile kodu yüklenmez (ci.yml ile aynı savunma); yaşam döngüsü betikleri
# --ignore-scripts ile çalışmaz. pnpm sürümü package.json `packageManager` alanından (corepack).
ENV npm_config_ignore_pnpmfile=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
# web: Next standalone (`apps/web/.next/standalone`, izleme kökü depo kökü → `apps/web/server.js`).
# worker: tsc tür denetimi (tsconfig.build.json, noEmit) + esbuild tek dosya paketi → `apps/worker/dist/main.js`
# (workspace .ts paketleri ve pg-boss pakete gömülür; çalışma zamanında node_modules ve kaynak .ts gerekmez).
# Son adım: DB ortamı olmadan (ve migrate argümanlarıyla) çalıştırılan worker kendi yapılandırma hatasını verir;
# çıktıda `MIGRATION_` yoksa migration CLI paketlenmemiş/koşmuyor demektir (T-115 Supervisor eki 3).
RUN pnpm --filter @wms/web build \
 && pnpm --filter @wms/worker build \
 && test -f apps/web/.next/standalone/apps/web/server.js \
 && test -f apps/worker/dist/main.js \
 && test "$(ls apps/worker/dist | wc -l)" = 1 \
 && ! grep -q 'workspace:' apps/worker/dist/main.js \
 && out="$(env -u DATABASE_URL -u DATABASE_URL_DIRECT node apps/worker/dist/main.js down --to 0000 2>&1 || true)" \
 && printf '%s' "$out" | grep -q 'invalid configuration' \
 && ! printf '%s' "$out" | grep -q 'MIGRATION_'

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Yalnızca üretim çıktıları; dosyalar root'a ait (çalışan süreç kodu değiştiremez).
COPY --from=build /repo/apps/web/.next/standalone/ ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /repo/apps/worker/dist/main.js ./apps/worker/dist/main.js
# Next çalışma zamanı önbelleği için yazılabilir tek dizin.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
# Taban imajdaki root olmayan `node` kullanıcısı (uid 1000).
USER node
EXPOSE 3000
# Varsayılan komut web; Fly süreç grupları bunu `[processes]` ile geçersiz kılar.
CMD ["node", "apps/web/server.js"]
