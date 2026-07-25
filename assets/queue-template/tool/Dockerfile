FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @anthropic-ai/claude-code@2.1.217
RUN groupadd --gid 1000 agent \
  && useradd --create-home --uid 1000 --gid 1000 agent
USER agent
WORKDIR /workspace
