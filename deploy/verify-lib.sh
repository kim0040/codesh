# shellcheck shell=bash
# Bundle loading can replace a tag with another manifest of the same base image.
verification_snapshot_image_tags() {
  docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' |
    awk 'index($1, "<none>") == 0' | LC_ALL=C sort -u >"$1" || return 1
  docker image ls --no-trunc -aq | LC_ALL=C sort -u >"$1.ids"
}

verification_restore_image_tags() {
  local snapshot="$1" tag original replacement tags used records preexisting status=0
  [ -f "$snapshot" ] && [ -f "$snapshot.ids" ] || return 1
  records="$(cat "$snapshot")" && preexisting="$(cat "$snapshot.ids")" || return 1
  [ -n "$records" ] || return 0
  while read -r tag original; do
    [[ "$original" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    replacement="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null)" || replacement=""
    [ "$replacement" != "$original" ] || continue
    if ! docker image inspect "$original" >/dev/null 2>&1 || ! docker image tag "$original" "$tag"; then
      status=1
      continue
    fi
    [ "$(docker image inspect --format '{{.Id}}' "$tag")" = "$original" ] || { status=1; continue; }
    [ -n "$replacement" ] || continue
    [[ "$replacement" =~ ^sha256:[0-9a-f]{64}$ ]] || { status=1; continue; }
    # Never remove an image that existed before this verifier, has another tag or is in use.
    case $'\n'"$preexisting"$'\n' in *$'\n'"$replacement"$'\n'*) continue ;; esac
    tags="$(docker image inspect --format '{{len .RepoTags}}' "$replacement")" || { status=1; continue; }
    [ "$tags" = 0 ] || continue
    used="$(docker ps -aq --filter "ancestor=$replacement")" || { status=1; continue; }
    [ -z "$used" ] || continue
    docker image rm "$replacement" >/dev/null || status=1
  done <<<"$records"
  [ "$status" = 0 ] || echo 'cleanup: could not restore all pre-existing image tags' >&2
  return "$status"
}

# Keep verification database working space on the caller's owned /data filesystem.
verification_mongo_volume() {
  local project="$1" work="$2" volume directory
  case "$project" in gp-dbdeploy-*) ;; *) return 1 ;; esac
  volume="${project}_mongo-data"
  docker volume inspect "$volume" >/dev/null 2>&1 && return 0
  mkdir -p "$work/volume-data"
  directory="$(mktemp -d "$work/volume-data/$project-mongo.XXXXXX")" || return 1
  docker volume create --driver local --opt type=none --opt o=bind --opt "device=$directory" \
    --label "com.docker.compose.project=$project" --label com.docker.compose.volume=mongo-data \
    "$volume" >/dev/null
}

verification_cleanup_mongo_dirs() {
  local project="$1" work="$2"
  case "$project" in gp-dbdeploy-*) ;; *) return 1 ;; esac
  [ -d "$work/volume-data" ] || return 0
  docker volume inspect "${project}_mongo-data" >/dev/null 2>&1 && return 1
  # shellcheck disable=SC2016 # the project is passed to the cleanup container as $1
  docker run --rm --pull never -v "$work/volume-data:/w" --entrypoint sh registry:2.8.3 -c '
    for directory in /w/"$1"-mongo.*; do
      [ ! -e "$directory" ] || rm -rf -- "$directory"
    done
  ' _ "$project"
}

# A failed old updater can restore a Compose file that omits a newly created volume.
verification_cleanup_unused_volumes() {
  local project="$1" volume
  case "$project" in gp-dbdeploy-*) ;; *) return 1 ;; esac
  while IFS= read -r volume; do
    case "$volume" in "${project}_"*) ;; *) continue ;; esac
    [ -z "$(docker ps -aq --filter "volume=$volume")" ] || continue
    docker volume rm "$volume" >/dev/null || return 1
  done < <(docker volume ls -q --filter "label=com.docker.compose.project=$project")
}
