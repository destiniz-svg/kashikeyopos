# ═══ THE RUNTIME IMAGE ══════════════════════════════════════════════════════
# There is no build step. The terminal, the onboarding panel and both guest
# portals are hand-written HTML served from disk, so what ships is what was
# read — no bundle to bake, nothing to get stale between the file and the page.
#
# The only compiled thing here is the dependency tree, and it is installed from
# the lockfile so the image runs the exact versions CI tested.
# ═══════════════════════════════════════════════════════════════════════════
FROM node:22-alpine

# THE POSTGRES CLIENT TOOLS ARE NEEDED NOW, and only for one thing: taking a
# backup. The app speaks the wire protocol directly through `pg` for everything
# a request does; what `pg` cannot do is produce an archive that survives every
# column type, extension, default and constraint this schema has or will have.
# Re-deriving that in JavaScript would be a second implementation of the one
# tool the whole recovery story rests on, drifting silently the first time a
# migration adds a type it does not know — and a backup that is subtly wrong is
# worse than none, because it is trusted.
#
# THE MAJOR MUST NOT BE OLDER THAN THE SERVER: pg_dump refuses a server newer
# than itself. Railway serves Postgres 18, so 18 is asked for first and the
# meta-package is the fallback for an Alpine that does not carry it yet.
# Nothing downstream assumes this worked — src/backup.js finds the binary,
# reads its version, compares it to the server's, and refuses BY NAME with the
# remedy, so an image whose package name went stale says so on the Backup card
# instead of quietly taking nothing.
RUN apk add --no-cache postgresql18-client \
 || apk add --no-cache postgresql17-client \
 || apk add --no-cache postgresql-client

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
# Postgres and in the browser's own IndexedDB. A backup writes its archive to
# the system temp directory and deletes it in a finally — bounded by disk
# rather than memory, and gone whether the upload succeeded or not.
USER node

# Migrations run at boot, inside the process, and a failure exits rather than
# serving on a schema the build does not expect (server.js → boot()).
CMD ["node", "server.js"]
