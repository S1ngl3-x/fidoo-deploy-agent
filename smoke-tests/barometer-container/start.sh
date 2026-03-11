#!/bin/sh
set -e

# Restore DB from blob if it exists (no-op if first deploy)
litestream restore -if-replica-exists -config /etc/litestream.yml "${DB_PATH}"

# Start app with litestream replicating in background
exec litestream replicate -exec "node server.js" -config /etc/litestream.yml
