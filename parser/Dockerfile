# Use the official Playwright image with browsers and required OS deps preinstalled
# Match your Playwright version (^1.46.0)
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

# App directory
WORKDIR /app

# Environment
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=8080

# Install only prod deps (better layer caching)
# Copies whichever lockfile you use if present
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Copy the rest of the app
COPY . .

# Optional: simple health check that hits /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT||8080) + '/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

# Run as the non-root user provided by the Playwright image
USER pwuser

EXPOSE 8080
CMD ["npm","start"]