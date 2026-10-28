#!/usr/bin/env bash
# Exercise the exact fixture cleanup used by the real verifier, without Docker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$(mktemp -d)"
trap 'rm -rf "$F"' EXIT
# shellcheck disable=SC1090 # extract the production function, not a duplicate
. <(sed -n '/^cleanup_sql() {$/,/^}$/p' "$ROOT/deploy/verify-databases.sh")
SQL=gp-dbdeploy-fixture-external-mysql
SQL_IMAGE=mysql:8.4
SQL_DATA="$F/data"
docker() {
  case "$1 $2" in
    'rm -fv')
      [ "$3" = "$SQL" ] && [ "$#" = 3 ] || return 91
      [ "$FAIL_RM" = 0 ] || return 1
      echo container >>"$F/events" ;;
    'run --rm')
      [ "$SQL_STARTED" = 0 ] || return 92
      [ "$FAIL_DATA" = 0 ] || return 1
      echo data >>"$F/events" ;;
    'ps -aq')
      [ "$3" = --filter ] && [ "$4" = "ancestor=$SQL_IMAGE" ] || return 93
      [ "$FAIL_PS" = 0 ] || return 1
      [ "$USED" = 0 ] || echo other-container ;;
    'image rm')
      [ "$3" = "$SQL_IMAGE" ] && [ "$#" = 3 ] || return 94
      echo image >>"$F/events" ;;
    *) return 95 ;;
  esac
}
reset() {
  SQL_STARTED=1 FAIL_RM=0 FAIL_DATA=0 FAIL_PS=0 USED=0
  mkdir -p "$SQL_DATA"
  : >"$F/events"
}
reset
cleanup_sql
[ "$(cat "$F/events")" = $'container\ndata\nimage' ]
[ ! -d "$SQL_DATA" ] && [ "$SQL_STARTED" = 0 ]
echo 'ok: owned fixture stops before data and unused image removal'
reset
USED=1
cleanup_sql
[ "$(cat "$F/events")" = $'container\ndata' ]
echo 'ok: another container retains the SQL test image'
reset
FAIL_PS=1
if cleanup_sql; then exit 1; fi
[ "$(cat "$F/events")" = $'container\ndata' ]
echo 'ok: failed reference probe cannot authorize image removal'
reset
FAIL_RM=1
if cleanup_sql; then exit 1; fi
[ ! -s "$F/events" ] && [ -d "$SQL_DATA" ] && [ "$SQL_STARTED" = 1 ]
echo 'ok: failed stop preserves fixture data and its image'
reset
FAIL_DATA=1
if cleanup_sql; then exit 1; fi
[ "$(cat "$F/events")" = container ] && [ -d "$SQL_DATA" ]
echo 'ok: data cleanup failure is reported and preserves the image'
reset
SQL_STARTED=0
cleanup_sql
[ "$(cat "$F/events")" = image ] && [ -d "$SQL_DATA" ]
echo 'ok: an unowned fixture never authorizes container or directory deletion'
echo 'verify-databases.test.sh: all checks passed'
