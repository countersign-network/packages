# Countersign Core — container image. Runs the REST + ws API + dashboard (packages/api).
# Portable: works on Render (Docker), Fly, Akash, or `docker run` locally.
FROM node:22-slim

WORKDIR /app

# pnpm comes from corepack, pinned by package.json "packageManager".
RUN corepack enable

# Install workspace deps. .dockerignore keeps node_modules/.git/.env out of the build context.
COPY . .
RUN pnpm install --frozen-lockfile

# Drop root: run as the image's built-in unprivileged `node` user (uid 1000). The control plane
# holds vendor keys + the ledger — a container escape as root is far worse than as a sandboxed user.
RUN chown -R node:node /app
USER node

# The host (Render) injects PORT; main.ts binds process.env.PORT. EXPOSE is informational only.
EXPOSE 8080

# Start the Core (+ dashboard). DATABASE_URL (if set) → durable Postgres ledger; else in-memory.
CMD ["pnpm", "--filter", "@countersign/api", "start"]
