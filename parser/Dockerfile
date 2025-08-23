# syntax=docker/dockerfile:1

# Playwright image (Chromium + all deps preinstalled)
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install Yarn Classic globally so Corepack won't touch package.json
RUN npm i -g yarn@1.22.22

# Copy manifests first to leverage Docker layer cache
COPY package.json yarn.lock* ./

# Install deps (works for classic lockfiles)
RUN yarn install --frozen-lockfile || yarn install

# Copy the rest of the app
COPY . .

# Ensure the runtime user owns the files
RUN chown -R pwuser:pwuser /app

# Drop privileges (this user is provided by the Playwright base image)
USER pwuser

EXPOSE 8080
CMD ["yarn", "start"]