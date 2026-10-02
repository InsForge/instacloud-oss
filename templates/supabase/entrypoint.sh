#!/bin/bash
# One image, four of the template's machines: INSTA_SUPABASE_ROLE picks the Supabase component this one runs.
set -euo pipefail

role="${INSTA_SUPABASE_ROLE:?INSTA_SUPABASE_ROLE is not set}"
log() { echo "supabase[$role]: $*" >&2; }

# The API keys are HS256 JWTs over fixed claims, so every machine derives the same pair from JWT_SECRET.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() {
    local header payload signature
    header=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
    payload=$(printf '{"role":"%s","iss":"supabase","iat":1767225600,"exp":2082758400}' "$1" | b64url)
    signature=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)
    printf '%s.%s.%s' "$header" "$payload" "$signature"
}
api_keys() {
    : "${JWT_SECRET:?JWT_SECRET is not set}"
    ANON_KEY=$(jwt anon)
    SERVICE_ROLE_KEY=$(jwt service_role)
}

# The platform gives each service the managed database as one URL; Supabase's components log in as their own roles.
parse_database_url() {
    local rest userinfo hostport dbpath
    rest="${DATABASE_URL:?DATABASE_URL is not set}"
    rest="${rest#*://}"
    userinfo="${rest%@*}"
    db_hostpath="${rest##*@}"
    hostport="${db_hostpath%%/*}"
    case "$hostport" in *:*) ;; *) hostport="$hostport:5432" ;; esac
    db_host="${hostport%:*}"
    db_port="${hostport##*:}"
    dbpath="${db_hostpath#*/}"
    db_name="${dbpath%%\?*}"
    db_password_encoded="${userinfo#*:}"
    db_password=$(printf '%b' "${db_password_encoded//%/\\x}")
    case "$DATABASE_URL" in *sslmode=disable*) db_ssl=false ;; *) db_ssl=true ;; esac
}
role_url() { printf 'postgres://%s:%s@%s' "$1" "$db_password_encoded" "$db_hostpath"; }

# Replays supabase/postgres's init scripts and migrations once per database, in one transaction under a lock.
bootstrap() {
    local sql=/tmp/bootstrap.sql file name
    {
        echo 'set client_min_messages = warning;'
        echo 'begin;'
        echo "do \$\$ begin perform pg_advisory_xact_lock(hashtext('supabase-template-bootstrap')); end \$\$;"
        echo "do \$\$ begin if not exists (select from pg_roles where rolname = 'supabase_admin') then create role supabase_admin superuser createdb createrole replication bypassrls login; end if; end \$\$;"
        echo 'create schema if not exists _supabase_template;'
        echo 'create table if not exists _supabase_template.migrations (name text primary key, applied_at timestamptz not null default now());'
        for file in /opt/supabase-db/init-scripts/*.sql /opt/supabase-db/migrations/*.sql; do
            name="${file##*/}"
            # The demotion would strip the platform's own superuser; pgbouncer is not part of this stack.
            case "$name" in 10000000000000_demote-postgres.sql | *pgbouncer*.sql) continue ;; esac
            echo "select not exists (select 1 from _supabase_template.migrations where name = '$name') as todo \\gset"
            echo '\if :todo'
            case "$file" in */migrations/*) echo 'set role supabase_admin;' ;; esac
            echo "\\i $file"
            echo 'reset role;'
            echo "insert into _supabase_template.migrations (name) values ('$name');"
            echo '\endif'
        done
        echo '\i /insta/bootstrap.sql'
        echo 'commit;'
    } > "$sql"
    log "bootstrapping the database schema (supabase/postgres $(cat /opt/supabase-db/VERSION))"
    until INSTA_DB_PASSWORD="$db_password" PGCONNECT_TIMEOUT=10 psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
        -v dbname="$db_name" -f "$sql"; do
        log "bootstrap failed, retrying in 5s"
        sleep 5
    done
}

# Exits as soon as any child does, so the platform restarts the machine rather than leaving half of it running.
wait_any() {
    local status=0
    wait -n || status=$?
    log "a process exited with status $status, stopping the machine"
    exit "$status"
}

# Envoy needs an upstream cluster per service; https URLs get TLS with SNI, which the platform's router requires.
cluster() {
    local name="$1" url="$2" scheme host port
    scheme="${url%%://*}"
    host="${url#*://}"
    host="${host%%/*}"
    case "$host" in
        *:*) port="${host##*:}"; host="${host%:*}" ;;
        *) if [ "$scheme" = https ]; then port=443; else port=80; fi ;;
    esac
    cat <<EOF
    - name: $name
      type: LOGICAL_DNS
      dns_lookup_family: V4_PREFERRED
      connect_timeout: 10s
      load_assignment:
        cluster_name: $name
        endpoints:
          - lb_endpoints:
              - endpoint:
                  hostname: $host
                  address:
                    socket_address:
                      address: $host
                      port_value: $port
EOF
    if [ "$scheme" = https ]; then
        cat <<EOF
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          sni: $host
          common_tls_context:
            validation_context:
              trusted_ca:
                filename: /etc/ssl/certs/ca-certificates.crt
EOF
    fi
}

# Fills the named placeholders in an Envoy template the way upstream's envoy entrypoint does; unset ones become empty.
render() {
    local src="$1" dst="$2" name script=""
    shift 2
    for name in "$@"; do script="$script s|\${$name}|${!name:-}|g;"; done
    sed -e "$script" "$src" > "$dst"
}

run_gateway() {
    api_keys
    : "${ADMIN_USERNAME:?ADMIN_USERNAME is not set}" "${ADMIN_PASSWORD:?ADMIN_PASSWORD is not set}" "${STUDIO_TOKEN:?STUDIO_TOKEN is not set}"
    local config=/tmp/envoy-gateway.yaml
    DASHBOARD_BASIC_AUTH="${ADMIN_USERNAME}:{SHA}$(printf '%s' "$ADMIN_PASSWORD" | openssl sha1 -binary | openssl base64 -A)"
    # The asymmetric and sb_ keys stay unset, so upstream's key translation filters are no-ops.
    render /insta/envoy/gateway.yaml "$config" ANON_KEY SERVICE_ROLE_KEY DASHBOARD_BASIC_AUTH STUDIO_TOKEN \
        ANON_KEY_ASYMMETRIC SERVICE_ROLE_KEY_ASYMMETRIC SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY
    {
        echo '  clusters:'
        cluster auth "${AUTH_URL:?}"
        cluster rest "${REST_URL:?}"
        cluster realtime "${REALTIME_URL:?}"
        cluster storage "${STORAGE_URL:?}"
        cluster studio "${STUDIO_URL:?}"
    } >> "$config"
    exec envoy -c "$config" --log-level warn
}

run_studio() {
    api_keys
    parse_database_url
    bootstrap
    : "${STUDIO_TOKEN:?STUDIO_TOKEN is not set}"
    local crypto_key
    crypto_key=$(openssl rand -hex 24)
    mkdir -p /data/snippets
    # postgres-meta is unauthenticated, so it listens on loopback only.
    (
        cd /opt/meta
        export PG_META_HOST=127.0.0.1 PG_META_PORT=8080 CRYPTO_KEY="$crypto_key"
        export PG_META_DB_HOST="$db_host" PG_META_DB_PORT="$db_port" PG_META_DB_NAME="$db_name"
        export PG_META_DB_USER=postgres PG_META_DB_PASSWORD="$db_password" PG_META_DB_SSL_MODE=require
        # Studio's connection strings carry no sslmode, so node-pg takes it from here.
        export PGSSLMODE=no-verify
        exec node22 dist/server/server.js
    ) &
    (
        cd /opt/studio
        export HOSTNAME=127.0.0.1 PORT=3001 STUDIO_PG_META_URL=http://127.0.0.1:8080 PG_META_CRYPTO_KEY="$crypto_key"
        export POSTGRES_HOST="$db_host" POSTGRES_PORT="$db_port" POSTGRES_DB="$db_name"
        export POSTGRES_USER_READ_WRITE=postgres POSTGRES_PASSWORD="$db_password"
        export SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_KEY="$SERVICE_ROLE_KEY" AUTH_JWT_SECRET="$JWT_SECRET"
        export SNIPPETS_MANAGEMENT_FOLDER=/data/snippets
        exec node22 apps/studio/server.js
    ) &
    render /insta/envoy/studio.yaml /tmp/envoy-studio.yaml STUDIO_TOKEN
    envoy -c /tmp/envoy-studio.yaml --log-level warn &
    wait_any
}

run_storage() {
    api_keys
    parse_database_url
    bootstrap
    mkdir -p /data/storage
    # imgproxy reads the files straight off the shared volume and has no auth, so it listens on loopback only.
    (
        export IMGPROXY_BIND=127.0.0.1:5001 IMGPROXY_LOCAL_FILESYSTEM_ROOT=/ IMGPROXY_USE_ETAG=true
        export IMGPROXY_AUTO_WEBP=true IMGPROXY_MAX_SRC_RESOLUTION=16.8
        exec imgproxy
    ) &
    (
        cd /opt/storage
        # node-pg reads sslmode=require as verify-full unless asked for libpq's meaning, which every other component uses.
        DATABASE_URL="$(role_url supabase_storage_admin)"
        case "$DATABASE_URL" in *\?*) DATABASE_URL="$DATABASE_URL&uselibpqcompat=true" ;; esac
        export DATABASE_URL ANON_KEY SERVICE_KEY="$SERVICE_ROLE_KEY" AUTH_JWT_SECRET="$JWT_SECRET"
        export STORAGE_BACKEND=file FILE_STORAGE_BACKEND_PATH=/data/storage
        export ENABLE_IMAGE_TRANSFORMATION=true IMGPROXY_URL=http://127.0.0.1:5001
        exec node dist/start/server.js
    ) &
    wait_any
}

run_realtime() {
    parse_database_url
    bootstrap
    : "${JWT_SECRET:?JWT_SECRET is not set}"
    # Realtime names the tenant after the first label of the Host it is reached on, which is its own URL.
    local host="${REALTIME_URL:?REALTIME_URL is not set}"
    host="${host#*://}"
    host="${host%%[:/]*}"
    SELF_HOST_TENANT_NAME="${host%%.*}"
    export SELF_HOST_TENANT_NAME
    export DB_HOST="$db_host" DB_PORT="$db_port" DB_NAME="$db_name" DB_USER=supabase_admin
    export DB_PASSWORD="$db_password" DB_SSL="$db_ssl"
    ulimit -Sn 10000 || log "could not raise the open file limit"
    cd /opt/realtime
    bin/migrate
    log "seeding tenant $SELF_HOST_TENANT_NAME"
    bin/realtime eval 'Realtime.Release.seeds(Realtime.Repo)'
    exec bin/server
}

case "$role" in
    gateway) run_gateway ;;
    studio) run_studio ;;
    storage) run_storage ;;
    realtime) run_realtime ;;
    *) log "unknown role (expected gateway, studio, storage or realtime)"; exit 64 ;;
esac
