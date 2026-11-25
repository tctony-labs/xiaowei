#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

ffi=crates/xiaowei-mobile/ffi
flutter_rust_bridge_codegen generate \
  --rust-root "$ffi" --rust-input crate::flutter --rust-output "$ffi/src/frb_generated.rs" \
  --dart-output mobile/lib/src/rust --rust-features flutter --no-web --no-add-mod-to-lib \
  --no-auto-upgrade-dependency --type-64bit-int --dart-format-line-length 100 \
  --skip-fvm-install --stop-on-error
