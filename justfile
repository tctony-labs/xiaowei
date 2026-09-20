default:
    @just --list

# Install locked dependencies and initialize Git hooks via the prepare lifecycle.
prepare:
    #!/usr/bin/env bash
    set -e
    shopt -s nullglob
    stamp=".prepare-ts"
    changed=false
    for file in pnpm-lock.yaml pnpm-workspace.yaml package.json \
        contracts/ts/package.json gateway/ts/package.json desktop/package.json \
        packages/*/package.json crates/*/napi/package.json; do
        if [ ! -f "$stamp" ] || [ "$file" -nt "$stamp" ]; then
            changed=true
            break
        fi
    done
    if [ "$changed" = false ] && [ -f node_modules/.modules.yaml ] && [ -f .husky/_/pre-commit ]; then
        echo "Dependencies unchanged, skipping prepare"
        exit 0
    fi
    pnpm install --frozen-lockfile
    touch "$stamp"

# Switch the shared development instance to this workspace (user only).
start:
    #!/usr/bin/env bash
    set -e
    just prepare
    pnpm --filter './crates/*/napi' --workspace-concurrency=1 run build:debug
    pidfile="$HOME/.xiaowei/.dev.pid"
    mkdir -p "$(dirname "$pidfile")"
    kill_tree() {
        local pid=$1
        for child in $(pgrep -P "$pid" 2>/dev/null); do
            kill_tree "$child"
        done
        kill "$pid" 2>/dev/null || true
    }
    if [ -f "$pidfile" ]; then
        old_pid=$(cat "$pidfile")
        if [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$old_pid" 2>/dev/null; then
            echo "Killing previous dev instance (pid $old_pid)..."
            kill_tree "$old_pid"
            for i in $(seq 1 10); do
                kill -0 "$old_pid" 2>/dev/null || break
                sleep 0.2
            done
            kill -9 "$old_pid" 2>/dev/null || true
        fi
    fi
    pnpm --dir desktop dev &
    child_pid=$!
    echo "$child_pid" > "$pidfile"
    cleanup() {
        kill_tree "$child_pid"
        if [ "$(cat "$pidfile" 2>/dev/null)" = "$child_pid" ]; then
            rm -f "$pidfile"
        fi
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    wait "$child_pid"

# Restart this workspace's running desktop app.
rs:
    touch desktop/.rs

# Preview UI components independently of Electron.
storybook:
    pnpm --dir desktop storybook

# Start the independent HTTP service.
server:
    cd server && go run ./cmd/xiaowei-server

# Generate contracts; add other code generation tasks here as needed.
gen:
    pnpm contracts:generate

# Format source files explicitly.
fmt:
    pnpm exec biome check --write .
    cargo fmt --all
    cd server && go fmt ./...
    cd contracts/go && go fmt ./...

# Check without changing source or the Git index.
check:
    cargo fmt --all --check
    cargo check -p xw-gateway --no-default-features --locked
    pnpm check
    cd server && test -z "$(gofmt -l .)"
    cd server && go vet ./...
    cd contracts/go && test -z "$(gofmt -l .)"
    cd contracts/go && go vet ./...

# Run regression tests.
test:
    cargo test --workspace --locked
    pnpm test
    pnpm contracts:test
    cd server && go test ./...

# Build desktop bundles and Go server.
build:
    pnpm build
    cd server && go build -trimpath -o bin/xiaowei-server ./cmd/xiaowei-server
