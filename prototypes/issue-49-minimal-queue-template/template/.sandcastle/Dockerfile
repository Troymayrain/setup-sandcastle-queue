FROM node:22-bookworm-slim
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENTRYPOINT ["npm", "run", "queue", "--"]
