# The API image.
#
# BUILT FROM THE REPOSITORY ROOT, not from backend/. That is not a preference —
# backend/src/sale.js requires ../../packages/money/money, because there is
# exactly ONE bill calculation in this system and both the browser and the
# server load the same file. A build context of backend/ alone cannot see it,
# and the container dies on boot with "Cannot find module". It did, and the
# whole test suite stayed green while it did, because every test runs inside the
# repository where that path resolves.
#
# The alternative was to copy money.js into backend/. Two copies of the bill
# calculation is the single failure this codebase is most careful about — it is
# how the previous system charged 8% more at the counter than the guest's phone
# quoted, for months, with a green suite. A slightly larger build context is a
# cheap price for not reopening that.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Only what the API needs at runtime. The front-ends are static sites and are
# not in this image.
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY packages/money ./packages/money
COPY backend ./backend

WORKDIR /app/backend
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run on boot and are idempotent; the healthcheck on /readyz means a
# deploy that cannot reach its database never goes live.
#
# `bootstrap.js` sits between them because a cloud deploy has no shell: the
# runbook's provisioning commands assume somebody can open a terminal against
# the running environment, and driven from a browser nobody can, so the first
# deploy came up healthy and impossible to sign into. It reads its outlet and
# owner from the environment, does nothing at all when they are unset, and is
# safe on every boot. It runs AFTER migrate because it calls functions the
# migrations create.
CMD ["sh", "-c", "npm run migrate && node scripts/bootstrap.js && node server.js"]
