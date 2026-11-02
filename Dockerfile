FROM node:26-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends redis-server ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm install -g pnpm@12.16.1

# The whole repo, including the pre-built Activity in apps/activity/dist (committed to the repo).
COPY . .

# Runtime dependencies only. The services run their TypeScript sources through tsx, so the image
# needs no build step and none of the dev tooling (vite, tsc, eslint, vitest, playwright). The
# Activity is already built, so vite is not needed here either. This keeps the image small and the
# build fast and reliable on constrained hosts.
RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "scripts/start-all.mjs"]
