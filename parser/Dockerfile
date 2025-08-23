# syntax=docker/dockerfile:1

# Includes Chromium + system libs Playwright needs
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=8080

# Enable Yarn via Corepack
RUN corepack enable

# Copy manifest(s) first to leverage Docker layer caching
# If you use Yarn Berry, also copy .yarnrc.yml and the .yarn directory
COPY package.json yarn.lock* ./
# COPY .yarnrc.yml ./
# COPY .yarn ./.yarn

# Install deps (auto-detect Yarn classic vs Berry)
RUN bash -lc '\
  yarn --version && \
  if [ -f yarn.lock ] && grep -q "__metadata" yarn.lock 2>/dev/null; then \
    yarn install --immutable; \
  else \
    yarn install --frozen-lockfile || yarn install; \
  fi'

# Copy the rest of your app
COPY . .

# Run as the non-root user shipped with the Playwright image
USER pwuser

EXPOSE 8080
CMD ["yarn","start"]