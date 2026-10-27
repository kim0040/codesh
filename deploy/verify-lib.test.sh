#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=verify-lib.sh
. "$ROOT/deploy/verify-lib.sh"
F="$(mktemp -d)"
trap 'rm -rf "$F"' EXIT
OLD="sha256:$(printf '%064d' 1)"
NEW="sha256:$(printf '%064d' 2)"
OTHER="sha256:$(printf '%064d' 3)"

docker() {
  case "$1 $2" in
    'image ls')
      if [[ "$*" == *' -aq'* ]]; then printf '%s\n' "$OLD" "$OTHER"
      else printf '%s\n' "fixture/base:1 $OLD" "<none>:<none> $OTHER"; fi ;;
    'image inspect')
      if [ "$3" != --format ]; then [ "$3" = "$OLD" ] && [ "$MISSING" = 0 ]; return; fi
      case "$4" in
        '{{.Id}}') [ -s "$F/current" ] && cat "$F/current" ;;
        '{{len .RepoTags}}') printf '%s\n' "$TAGGED" ;;
        *) return 91 ;;
      esac ;;
    'image tag')
      [ "$3" = "$OLD" ] && [ "$4" = fixture/base:1 ] || return 92
      printf '%s\n' "$OLD" >"$F/current"
      echo tag >>"$F/events" ;;
    'image rm')
      [ "$3" = "$NEW" ] && [ "$#" = 3 ] || return 93
      echo rm >>"$F/events" ;;
    'ps -aq')
      [ "$FAIL_PS" = 0 ] || return 1
      [ "$USED" = 0 ] || echo fixture-container ;;
    *) return 94 ;;
  esac
}

reset() {
  printf '%s\n' "$NEW" >"$F/current"
  : >"$F/events"
  MISSING=0 TAGGED=0 USED=0 FAIL_PS=0
  verification_snapshot_image_tags "$F/snapshot"
  [ "$(cat "$F/snapshot")" = "fixture/base:1 $OLD" ]
}
no_removal() { if grep -qx rm "$F/events"; then exit 1; fi; }

reset
verification_restore_image_tags "$F/snapshot"
[ "$(cat "$F/current")" = "$OLD" ]
[ "$(cat "$F/events")" = $'tag\nrm' ]
echo 'ok: restores exact original tag and removes only a new unused untagged manifest'

reset
printf '%s\n' "$OLD" >"$F/current"
verification_restore_image_tags "$F/snapshot"
[ ! -s "$F/events" ]
echo 'ok: unchanged pre-existing image needs no mutation'

for guard in preexisting tagged used; do
  reset
  case "$guard" in
    preexisting) printf '%s\n' "$NEW" >>"$F/snapshot.ids" ;;
    tagged) TAGGED=1 ;;
    used) USED=1 ;;
  esac
  verification_restore_image_tags "$F/snapshot"
  [ "$(cat "$F/current")" = "$OLD" ]
  no_removal
  echo "ok: retains $guard replacement manifest after restoring original tag"
done

reset
MISSING=1
if verification_restore_image_tags "$F/snapshot" >"$F/error" 2>&1; then exit 1; fi
[ ! -s "$F/events" ]
echo 'ok: missing original image fails without tag or manifest mutation'

reset
FAIL_PS=1
if verification_restore_image_tags "$F/snapshot" >"$F/error" 2>&1; then exit 1; fi
no_removal
echo 'ok: failed container-reference probe cannot authorize removal'

reset
: >"$F/current"
verification_restore_image_tags "$F/snapshot"
[ "$(cat "$F/current")" = "$OLD" ]
no_removal
echo 'ok: missing original tag is restored without removing another image'

reset
rm "$F/snapshot.ids"
if verification_restore_image_tags "$F/snapshot"; then exit 1; fi
[ ! -s "$F/events" ]
echo 'ok: missing pre-existing image inventory refuses all mutations'
echo 'verify-lib.test.sh: all checks passed'
