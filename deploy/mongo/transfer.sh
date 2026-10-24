#!/bin/sh
# Runs inside Mongo: password is read from its environment and a private config file.
set -eu
umask 077
cfg=$(mktemp /tmp/codesh-transfer.XXXXXX)
trap 'rm -f "$cfg"' EXIT HUP INT TERM
mongosh --nodb --quiet --eval 'print("password: " + JSON.stringify(process.env.MONGO_INITDB_ROOT_PASSWORD))' </dev/null >"$cfg"
case "$1" in
  dump) mongodump --quiet --host localhost --username codesh --authenticationDatabase admin --db codesh --config "$cfg" --archive --gzip ;;
  restore) mongorestore --quiet --host localhost --username codesh --authenticationDatabase admin --config "$cfg" --archive --gzip --drop --nsInclude 'codesh.*' ;;
  *) exit 2 ;;
esac
