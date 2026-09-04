#!/bin/sh
# The one act that needs root, and then it stops being root.
#
# A platform mounts a volume owned by root, and this image runs as `node`. The image cannot fix that
# at build time — the mount does not exist until the container starts — so the store is unwritable
# on the first boot of every volume-backed deploy, and the only symptom is a site with no catalogue.
#
# So: hand the mount to `node`, then `exec` the process as `node`. No root process is left behind,
# and the application has exactly the privileges it had before.
set -e

if [ -n "$STORE_DIR" ] && [ -d "$STORE_DIR" ]; then
  # Only when it is not already ours, so a restart with a full disk does not walk every file.
  owner=$(stat -c '%U' "$STORE_DIR" 2>/dev/null || echo '')
  if [ "$owner" != "node" ]; then
    # A chown that fails is not fatal. Losing a restaurant's website over a directory's ownership is
    # a worse failure than a store that reports EACCES by name, which it already does — on the boot
    # line, and through /api/ready, which is what takes this instance out of rotation.
    chown -R node:node "$STORE_DIR" 2>/dev/null || echo "[entrypoint] could not take ownership of $STORE_DIR; the store may be read-only"
  fi
fi

exec su-exec node "$@"
