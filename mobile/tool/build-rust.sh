#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
export PATH="$HOME/.cargo/bin:$PATH"
target_dir="$root/target/flutter-rust"

case "$1" in
  ios)
    profile=debug
    cargo_profile=dev
    if [ "$CONFIGURATION" != Debug ]; then
      profile=release
      cargo_profile=release
    fi

    libraries=''
    for arch in $ARCHS; do
      case "$PLATFORM_NAME:$arch" in
        iphoneos:arm64) target=aarch64-apple-ios ;;
        iphonesimulator:arm64) target=aarch64-apple-ios-sim ;;
        iphonesimulator:x86_64) target=x86_64-apple-ios ;;
        *) echo "Unsupported iOS Rust target: $PLATFORM_NAME/$arch" >&2; exit 1 ;;
      esac

      cargo build --locked -p xiaowei-mobile-ffi --features flutter --lib \
        --profile "$cargo_profile" --target "$target" --target-dir "$target_dir"
      libraries="$libraries $target"
    done

    set --
    for target in $libraries; do
      set -- "$@" "$target_dir/$target/$profile/libxiaowei_mobile_ffi.a"
    done
    output="$BUILT_PRODUCTS_DIR/libxiaowei_mobile_ffi.a"
    if [ "$#" -eq 1 ]; then
      cp "$1" "$output"
    else
      xcrun lipo -create "$@" -output "$output"
    fi
    ;;
  android)
    ndk="$2"
    output="$3"
    case "$(uname -s)" in
      Darwin) host=darwin-x86_64 ;;
      Linux) host=linux-x86_64 ;;
      *) echo "Android Rust builds require a supported NDK host" >&2; exit 1 ;;
    esac
    bin="$ndk/toolchains/llvm/prebuilt/$host/bin"

    for abi in arm64-v8a armeabi-v7a x86_64; do
      case "$abi" in
        arm64-v8a) target=aarch64-linux-android; prefix=$target ;;
        armeabi-v7a) target=armv7-linux-androideabi; prefix=armv7a-linux-androideabi ;;
        x86_64) target=x86_64-linux-android; prefix=$target ;;
      esac
      linker="$bin/${prefix}24-clang"
      upper=$(printf '%s' "$target" | tr '[:lower:]-' '[:upper:]_')
      lower=$(printf '%s' "$target" | tr '-' '_')
      env "CARGO_TARGET_${upper}_LINKER=$linker" "CC_${lower}=$linker" \
        "AR_${lower}=$bin/llvm-ar" cargo build --locked -p xiaowei-mobile-ffi \
        --features flutter --lib --release --target "$target" --target-dir "$target_dir"
      mkdir -p "$output/$abi"
      cp "$target_dir/$target/release/libxiaowei_mobile_ffi.so" "$output/$abi/"
    done
    ;;
  *) echo "Expected an iOS or Android target" >&2; exit 1 ;;
esac
