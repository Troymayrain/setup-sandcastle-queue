FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

ARG FIXTURE
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/candidate
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY dist ./dist
COPY assets ./assets
COPY schema ./schema
COPY vendor ./vendor
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY test/fixtures/matrix.json /sandcastle-fixtures/matrix.json
RUN test -n "$FIXTURE" \
    && grep -F "\"$FIXTURE\"" /sandcastle-fixtures/matrix.json >/dev/null \
    && chmod 0444 /sandcastle-fixtures/matrix.json

USER node
ENTRYPOINT ["node", "/opt/candidate/dist/cli.js"]
CMD ["version"]
