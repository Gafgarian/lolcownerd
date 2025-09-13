FROM node:22-alpine

# App dir
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Make data dir and app tree writable by the non-root 'node' user
RUN mkdir -p /app/data && chown -R node:node /app

# Drop privileges
USER node

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 8090
CMD ["node", "src/server.js"]