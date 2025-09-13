# Dockerfile
FROM node:22-alpine

# Yarn is provided via Corepack in Node 22
RUN corepack enable

WORKDIR /app

# Install prod deps using Yarn (classic)
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true

# Copy the rest
COPY . .

# Make sure data dir exists & is owned by the non-root user
RUN mkdir -p /app/data && chown -R node:node /app

# Drop privileges
USER node

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 8090
CMD ["node", "src/server.js"]