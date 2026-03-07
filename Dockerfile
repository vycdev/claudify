FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install Claude Code CLI for auto-response feature
RUN npm install -g @anthropic-ai/claude-code

COPY --from=build /app/build ./build

RUN mkdir -p /app/messages/history /app/messages/pending

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production
ENV MESSAGES_DIR=/app/messages

CMD ["/app/entrypoint.sh"]
