# shellcheck shell=bash
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
