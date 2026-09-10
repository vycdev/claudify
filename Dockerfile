FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# node-pty does not publish an Alpine prebuild, so compile it during install.
RUN apk add --no-cache --virtual .node-pty-build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .node-pty-build-deps

# Install both subscription-backed CLIs. Pin the Codex app-server protocol.
RUN npm install -g @anthropic-ai/claude-code@2.1.220 @openai/codex@0.154.0

COPY --from=build /app/build ./build
COPY prompts/ ./prompts/

RUN mkdir -p /app/messages/history /app/messages/pending

COPY entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

ENV NODE_ENV=production
ENV MESSAGES_DIR=/app/messages

CMD ["/app/entrypoint.sh"]
