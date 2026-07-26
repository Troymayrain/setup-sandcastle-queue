FROM node:22-bookworm-slim

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @anthropic-ai/claude-code@2.1.217
RUN groupmod --non-unique --gid "$AGENT_GID" node \
  && usermod --non-unique --uid "$AGENT_UID" --gid "$AGENT_GID" --login agent --home /home/agent --move-home node
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent/workspace
ENTRYPOINT ["sleep", "infinity"]
