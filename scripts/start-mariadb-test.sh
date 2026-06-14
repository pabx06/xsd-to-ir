#!/usr/bin/env bash
set -euo pipefail

container="${MARIADB_TEST_CONTAINER:-xsd-to-ir-mariadb-test}"
image="${MARIADB_TEST_IMAGE:-mariadb:10.11}"
host="${MARIADB_TEST_HOST:-127.0.0.1}"
port="${MARIADB_TEST_PORT:-3307}"
database="${MARIADB_TEST_DATABASE:-xsd_to_ir_test}"
user="${MARIADB_TEST_USER:-xsd}"
password="${MARIADB_TEST_PASSWORD:-xsdpass}"
root_password="${MARIADB_TEST_ROOT_PASSWORD:-xsdtest}"

if docker inspect "$container" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
    docker start "$container" >/dev/null
  fi
else
  docker run -d --name "$container" \
    -e MARIADB_ROOT_PASSWORD="$root_password" \
    -e MARIADB_DATABASE="$database" \
    -e MARIADB_USER="$user" \
    -e MARIADB_PASSWORD="$password" \
    -p "${host}:${port}:3306" \
    "$image" >/dev/null
fi

for _ in $(seq 1 60); do
  if docker exec "$container" mariadb -u"$user" -p"$password" "$database" -e 'SELECT 1' >/dev/null 2>&1; then
    sleep 2
    if docker exec "$container" mariadb -u"$user" -p"$password" "$database" -e 'SELECT 1' >/dev/null 2>&1; then
      echo "MariaDB ready: mysql://${user}:${password}@${host}:${port}/${database}"
      exit 0
    fi
  fi
  sleep 1
done

docker logs "$container" >&2
echo "MariaDB did not become ready in time" >&2
exit 1
