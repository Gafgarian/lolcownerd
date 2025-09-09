# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app

# Set production by default; override at runtime if needed
ENV NODE_ENV=production

# Install dependencies with Yarn (classic)
# If you don't have a yarn.lock yet, this still works.
COPY package.json yarn.lock* ./
RUN yarn install --production --frozen-lockfile || yarn install --production

# Copy the app source (server + client assets)
COPY . .

# Use non-root for a bit of extra safety
RUN addgroup -S app && adduser -S app -G app
USER app

# The server listens on 8080 by default in your code; expose it
EXPOSE 8090

# Start the server
CMD ["node", "server/server.js"]
