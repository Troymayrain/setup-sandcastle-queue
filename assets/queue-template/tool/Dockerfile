FROM node:22-bookworm-slim

RUN useradd --create-home --uid 1000 agent
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
USER agent

ENTRYPOINT ["node", "dist/index.js"]
