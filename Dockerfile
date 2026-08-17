# One image for every Node process in the stack — the app, the standalone
# order-path services, and the drivers. They differ only by command, so a single
# image keeps the build fast and the versions identical across processes.
FROM node:22-slim

WORKDIR /app

# Install deps first so edits to source don't invalidate the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Overridden per service in docker-compose.yml.
CMD ["node", "app/server.mjs"]
