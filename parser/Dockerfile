# syntax=docker/dockerfile:1.6

# Playwright image already includes Chromium + all system libs
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=8080

# Enable Yarn (Corepack is bundled with Node ≥16)
RUN corepack enable

# Install deps with Yarn, honoring your lockfile
# If you use Yarn v1 (classic): --frozen-lockfile
# If you use Yarn Berry (v3+):   --immutable
COPY package.json yarn.lock* ./
RUN --mount=type=cache,target=/root/.yarn \
    --mount=type=cache,target=/root/.cache/yarn \
    bash -lc '\
      yarn --version && \
      if [ -f yarn.lock ] && grep -q "__metadata" yarn.lock 2>/dev/null; then \
        yarn install --immutable; \
      else \
        yarn install --frozen-lockfile || yarn install; \
      fi'

# Copy the rest of your app
COPY . .

# (Optional) healthcheck hitting your /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT||8080) + '/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

# Run as the non-root user provided by the Playwright image
USER pwuser

EXPOSE 8080
CMD ["yarn","start"]