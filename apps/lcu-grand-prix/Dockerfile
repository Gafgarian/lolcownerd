# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
WORKDIR /app
# Yarn Classic
RUN corepack disable && npm i -g yarn@1.22.22
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# copy app and resolved deps
COPY . .
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 3000
CMD ["yarn","start"]