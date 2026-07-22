ARG SOURCE_DATE_EPOCH=946684800

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build

ARG SOURCE_DATE_EPOCH

WORKDIR /opt/source
COPY package.json package-lock.json tsconfig.json ./
COPY schema ./schema
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

ARG SOURCE_DATE_EPOCH
ARG DEBIAN_SNAPSHOT=20260722T000000Z

LABEL org.opencontainers.image.description="Pinned Sandcastle Queue control plane" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/Troymayrain/setup-sandcastle-queue" \
      org.opencontainers.image.version="1.0.0" \
      io.sandcastle.broker.schema="1" \
      io.sandcastle.claude-code.package="@anthropic-ai/claude-code@2.1.217" \
      io.sandcastle.claude-code.version="2.1.217" \
      io.sandcastle.debian.snapshot="20260722T000000Z" \
      io.sandcastle.node.version="22.22.2"

RUN printf '%s\n' \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm-updates main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bookworm-security main" \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates=20230311+deb12u1 \
      docker.io=20.10.24+dfsg1-1+deb12u1+b6 \
      gh=2.23.0+dfsg1-1 \
      git=1:2.39.5-0+deb12u3 \
      jq=1.6-2.1+deb12u2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/control-plane-dependencies
COPY control-plane/package.json control-plane/package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

WORKDIR /opt/sandcastle
COPY control-plane/runtime-package.json ./package.json
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY schema ./schema
COPY --from=build /opt/source/dist/control-plane.js ./dist/control-plane.js
COPY --from=build /opt/source/dist/broker/server.js ./dist/broker/server.js
COPY --from=build /opt/source/dist/config.js ./dist/config.js
COPY --from=build /opt/source/dist/hash.js ./dist/hash.js
COPY --from=build /opt/source/dist/version.js ./dist/version.js
RUN mv /opt/control-plane-dependencies/node_modules ./node_modules \
    && chmod 0555 ./dist/control-plane.js \
    && ln -s /opt/sandcastle/dist/control-plane.js /usr/local/bin/sandcastle-queue \
    && ln -s /opt/sandcastle/node_modules/.bin/claude /usr/local/bin/claude \
    && chown -R node:node /opt/sandcastle

USER node
ENTRYPOINT ["sandcastle-queue"]
CMD ["version"]
