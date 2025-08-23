# syntax=docker/dockerfile:1

# Match the version in package.json (1.54.2 here)
FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app

# Keep Playwright from re-downloading browsers (image already has them)
ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Avoid Corepack editing package.json at runtime
RUN npm i -g yarn@1.22.22

# Install deps first to leverage cache
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile || yarn install

# App source
COPY . .

# Ensure non-root user can read/write
RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 8080
CMD ["yarn", "start"]