# ═══ THE RUNTIME IMAGE ══════════════════════════════════════════════════════
# There is no build step. The terminal, the onboarding panel and both guest
# portals are hand-written HTML served from disk, so what ships is what was
# read — no bundle to bake, nothing to get stale between the file and the page.
#
# The only compiled thing here is the dependency tree, and it is installed from
# the lockfile so the image runs the exact versions CI tested.
# ═══════════════════════════════════════════════════════════════════════════
FROM node:22-alpine

# Postgres client tools are not needed at runtime; the app speaks the wire
# protocol directly through pg. Keep the image to what actually runs.
WORKDIR /srv/kashikeyo

# Dependencies first, so a change to application code does not re-resolve them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY app ./app
# Mission Control and the public website ride in the same image, selected by
# the start command (`node panel/server.js` / `node site/server.js`) on their
# own Railway services — one build, three programs, no second Dockerfile to
# drift.
COPY panel ./panel
COPY site ./site

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Run as nobody. Nothing in this image is written to at runtime: state lives in
# Postgres and in the browser's own IndexedDB.
USER node

# Migrations run at boot, inside the process, and a failure exits rather than
# serving on a schema the build does not expect (server.js → boot()).
CMD ["node", "server.js"]
