#!/bin/sh
# Hosting volumes (Railway, Docker) are mounted root-owned: hand /data to the app user, then drop root for good.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
