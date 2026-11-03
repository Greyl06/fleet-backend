# ==============================================================================
# Stage 1: Build TypeScript source code & native addons
# ==============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install native addon compilation dependencies for argon2
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Remove development dependencies so only production modules remain
RUN npm prune --omit=dev

# ==============================================================================
# Development stage with tsx hot-reloader and live source mounts
# ==============================================================================
FROM node:22-bookworm-slim AS dev

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]

# ==============================================================================
# Stage 2: Production container runtime
# ==============================================================================
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy production node_modules (with compiled argon2) from builder stage
COPY --from=builder /app/node_modules ./node_modules
# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist
# Copy package manifests for metadata
COPY package*.json ./

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
