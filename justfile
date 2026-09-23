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
        contracts/ts/package.json gateway/ts/package.json gateway/tests/package.json desktop/package.json \
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
    pidfile="$HOME/.xiaowei/.dev.pid"
    mkdir -p "$(dirname "$pidfile")"
    kill_tree() {
        local pid i alive
        local root_pid=$1
        local -a graceful_pids=()
        local -a dev_pids=()
        collect_tree() {
            local pid=$1 child
            # Freeze supervisors before collecting children so they cannot respawn them.
            kill -STOP "$pid" 2>/dev/null || return 0
            dev_pids+=("$pid")
            for child in $(pgrep -P "$pid" 2>/dev/null); do
                collect_tree "$child"
            done
        }
        snapshot_tree() {
            local pid=$1 child
            kill -0 "$pid" 2>/dev/null || return 0
            graceful_pids+=("$pid")
            for child in $(pgrep -P "$pid" 2>/dev/null); do
                snapshot_tree "$child"
            done
        }
        snapshot_tree "$root_pid"
        # Let dev.mjs use the same IPC shutdown path as terminal Ctrl+C.
        kill -TERM "$root_pid" 2>/dev/null || true
        for ((i=0; i<30; i++)); do
            alive=false
            for pid in "${graceful_pids[@]}"; do
                if kill -0 "$pid" 2>/dev/null; then alive=true; fi
            done
            if [ "$alive" = false ]; then return 0; fi
            sleep 0.2
        done
        # Legacy launchers or stalled shutdowns still need descendant cleanup.
        for pid in "${graceful_pids[@]}"; do
            collect_tree "$pid"
        done
        for ((i=${#dev_pids[@]}-1; i>=0; i--)); do
            pid=${dev_pids[$i]}
            kill -TERM "$pid" 2>/dev/null || true
            kill -CONT "$pid" 2>/dev/null || true
        done
        # Keep the snapshot: descendants may be reparented after their supervisor exits.
        for ((i=0; i<50; i++)); do
            alive=false
            for pid in "${dev_pids[@]}"; do
                if kill -0 "$pid" 2>/dev/null; then alive=true; fi
            done
            if [ "$alive" = false ]; then return 0; fi
            if [ "$i" -eq 30 ]; then
                for pid in "${dev_pids[@]}"; do
                    kill -KILL "$pid" 2>/dev/null || true
                done
            fi
            sleep 0.2
        done
        echo "Previous dev processes did not exit; cancelling startup." >&2
        return 1
    }
    if [ -f "$pidfile" ]; then
        old_pid=$(cat "$pidfile")
        if [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$old_pid" 2>/dev/null; then
            echo "Killing previous dev instance (pid $old_pid)..."
            kill_tree "$old_pid"
        fi
    fi
    # Record dev.mjs itself: with pnpm dev, $! identifies pnpm, not the shutdown coordinator.
    # Send SIGTERM directly to dev.mjs so it uses the Ctrl+C IPC cleanup path without pnpm forwarding.
    node scripts/dev/dev.mjs <&0 &
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

# Generate contracts and their Rust Gateway bindings.
gen:
    pnpm contracts:generate
    pnpm gateway:generate

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
