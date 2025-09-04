# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
WORKDIR /app

# Use Yarn Classic + keep cache OUTSIDE node_modules to avoid EBUSY
ENV NODE_ENV=production \
    YARN_CACHE_FOLDER=/root/.yarn

# Enable Yarn via Corepack and pin classic
RUN corepack enable && corepack prepare yarn@1.22.22 --activate

# Copy only manifests first for better layer caching
COPY package.json yarn.lock* ./

# Install deps using a cache mount that is NOT inside node_modules
RUN --mount=type=cache,target=/root/.yarn \
    if [ -f yarn.lock ]; then \
      yarn install --frozen-lockfile --production=true; \
    else \
      yarn install --production=true; \
    fi

# Now copy the rest of your app
COPY . .

EXPOSE 8080
CMD ["node", "apps/server/index.mjs"]