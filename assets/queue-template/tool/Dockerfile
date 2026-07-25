FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @anthropic-ai/claude-code@2.1.217
USER node
WORKDIR /workspace
