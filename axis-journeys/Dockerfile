# Axis Journeys — production image.
#
# Multi-stage so the runtime carries the standalone server and its assets and nothing else: no
# source, no toolchain, no development dependencies. `output: 'standalone'` in next.config.mjs is
# what makes that possible, and it is why this image is tens of megabytes rather than hundreds.

# ---------------------------------------------------------------- dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` from the lockfile, so an image built today and one built in six months install the same
# four packages. `--omit=dev` is deliberately NOT used here: the build needs TypeScript.
RUN npm ci

# ---------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# The build reads no secret and reaches no service: every environment value this app uses is read
# at request time through src/lib/config.ts, so one image runs in staging and in production.
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Runs as a user that owns nothing it does not need to write. `node` exists in the base image.
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

# The file store is only used where STORE_DRIVER=file; on AWS the store is DynamoDB and this stays
# empty. It exists so a single-node deploy has somewhere writable that is not the image.
#
# There is deliberately no `VOLUME` instruction. It would force an anonymous volume on every run —
# including the DynamoDB deploy, which never touches this path — and leave orphaned volumes behind
# each time a container is replaced. Where the store IS on disk, the mount is named by whoever runs
# it: `-v axis-data:/app/.data`, an ECS bind mount, or a platform volume at whatever STORE_DIR says.
RUN mkdir -p /app/.data && chown node:node /app/.data

USER node
EXPOSE 3000

# The readiness probe is a real one: it asks the store and composes the published bundle, so an
# instance that cannot show a guest a single property never joins the load balancer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
