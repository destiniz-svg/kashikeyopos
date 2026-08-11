FROM node:20-alpine

WORKDIR /app

# The lockfile is copied and `npm ci` used so the image installs the EXACT
# dependency tree that was tested, not whatever the registry resolves at build
# time. `npm install` without the lockfile meant production could differ from
# CI on any transitive release, and a dependency advisory fixed in the lockfile
# never actually reached the running image. `npm ci` also fails loudly if the
# lockfile and package.json drift, instead of silently installing something else.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4000

CMD ["npm", "start"]
