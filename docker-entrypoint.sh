#!/bin/sh
# ═══ THE ONE ACT THAT NEEDS ROOT, AND NOTHING ELSE DOES ═════════════════════
# The image's own comment used to say "nothing in this image is written to at
# runtime", and that was true until a backup destination became a MOUNTED
# VOLUME. A platform mounts one owned by root, and the app runs as `node`, so
# every archive the scheduler produced was dumped correctly and then refused on
# the way in:
#
#   [backup] kashikeyo_biz_1  FAILED  EACCES: permission denied, copyfile
#            '/tmp/kashikeyo-….dump' -> '/backups/kashikeyo_biz_1-….dump'
#
# Four of four, every night, on an install whose boot line said the destination
# was configured — which is the shape this build refuses by name everywhere
# else: a control that reports it is doing something it is not. It was found by
# attaching the volume and READING THE LOG, never by reasoning about the image.
#
# So the container starts as root, makes the mount writable by the user the app
# actually runs as, and drops to that user for the process itself. The app's own
# privileges are exactly what they were before this file existed — `exec` means
# there is no root process left once the shell is replaced.
#
# GUARDED THREE WAYS, because this same image is also Mission Control and the
# public website, neither of which has a volume: no BACKUP_DIR is nothing to do,
# a path that is not a directory is nothing to do, and a chown that fails (the
# platform already handed it over, or we are not root) is not fatal — the backup
# itself reports EACCES by name if it still cannot write, which is a better
# error than a container that will not start.
set -e

if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  chown node:node "$BACKUP_DIR" 2>/dev/null || true
fi

# Already unprivileged (a platform that pins the user, a local `docker run -u`)
# means there is nothing to drop and su-exec would only fail.
if [ "$(id -u)" = "0" ]; then
  exec su-exec node "$@"
fi
exec "$@"
