#!/usr/bin/env bash
# Run against a healthy deployment before installing the candidate configuration.
set -euo pipefail
umask 077

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "Usage: bash backup.sh /absolute/deployment/root [compose-project]" >&2
    exit 1
fi
cd "$1"
deploy_root="$PWD"
deploy_project="${2:-xiaowei}"

# The saved files, not the operator's shell, define this deployment.
for name in ${!XIAOWEI_@} ${!COMPOSE_@}; do
    unset "$name"
done
compose() {
    docker compose --project-name "$deploy_project" --project-directory "$deploy_root" \
        --env-file config/.env --file compose.yaml "$@"
}

mkdir -p backups
mkdir backups/.backup-lock
staging=""
stopped=false
committed=false
pending_created=false
cleanup() {
    result=$?
    trap - EXIT
    if [ "$result" -ne 0 ] && [ "$stopped" = true ] && [ "$committed" = false ]; then
        echo "Backup failed; preserving the previous backup and restarting the old server" >&2
        if ! compose up --detach --no-deps --wait --wait-timeout 120 server; then
            echo "Old server restart failed; inspect deployment readiness" >&2
        fi
    fi
    if [ "$pending_created" = true ] && [ "$committed" = false ]; then
        rm -f backups/upgrade-pending
    fi
    if [ -n "$staging" ]; then
        rm -rf "$staging"
    fi
    rmdir backups/.backup-lock
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -e backups/upgrade-pending ]; then
    echo "An upgrade is pending; preserve latest.tar until acceptance or rollback completes" >&2
    exit 1
fi

for file in compose.yaml config/server.yaml config/.env release.txt; do
    if [ ! -f "$file" ]; then
        echo "Missing deployment file: $file" >&2
        exit 1
    fi
done
server_id="$(compose ps --quiet server)"
if [ -z "$server_id" ] || [ "$(docker inspect --format '{{.State.Health.Status}}' "$server_id")" != healthy ]; then
    echo "Backup requires the current server to be running and healthy" >&2
    exit 1
fi
image_ref="$(docker inspect --format '{{.Config.Image}}' "$server_id")"
if ! grep -Fxq "image=$image_ref" release.txt || ! compose config --images server | grep -Fxq "$image_ref"; then
    echo "Current image, Compose configuration and release.txt must match before backup" >&2
    exit 1
fi

staging="$(mktemp -d "$deploy_root/backups/.backup-XXXXXX")"
mkdir "$staging/snapshot"
cp compose.yaml release.txt "$staging/snapshot/"
cp -pR config "$staging/snapshot/config"
{
    date -u '+time=%Y-%m-%dT%H:%M:%SZ'
    docker inspect --format 'image_id={{.Image}}' "$server_id"
} > "$staging/snapshot/backup.txt"

stopped=true
compose stop server
compose exec -T db sh -c \
    'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom' \
    > "$staging/snapshot/database.dump"
compose exec -T db pg_restore --list < "$staging/snapshot/database.dump" > /dev/null
tar -C "$staging/snapshot" -cf "$staging/latest.tar" .
tar -tf "$staging/latest.tar" > /dev/null
chmod 600 "$staging/latest.tar"

# The marker also protects the rollback point across failed upgrade retries.
cp release.txt backups/upgrade-pending
pending_created=true
mv -f "$staging/latest.tar" backups/latest.tar
committed=true
echo "Rollback backup saved to backups/latest.tar; server is stopped for upgrade"
