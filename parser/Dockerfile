# Includes Node + Chromium + all required system libs
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

# Workdir
WORKDIR /app

# Only copy lockfile/pkg first for better layer cache
COPY package*.json ./

# Install production deps
RUN npm ci --omit=dev

# Add the rest of the app
COPY . .

# Env hardening / smaller CPU
ENV NODE_ENV=production
# Browsers are preinstalled in this image; no download step required
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Your server listens on 8080 already
EXPOSE 8080

# Start the scraper
CMD ["node", "server.js"]