#!/usr/bin/env bash
set -euo pipefail

SKIN_ID='whale-fantasy'
REVISION='67690252c424491ac8a57d7aea288b15de4f28ad'
BASE_URL="https://raw.githubusercontent.com/zhu1090093659/dsh-skins/${REVISION}/skins/${SKIN_ID}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CHECKSUMS="$SCRIPT_DIR/whale-fantasy.sha256"

usage() {
  printf 'Usage: DSH_HOME=/absolute/path %s [--check]\n' "$0" >&2
}

if [[ $# -gt 1 ]] || [[ $# -eq 1 && "$1" != '--check' ]]; then
  usage
  exit 2
fi

: "${DSH_HOME:?DSH_HOME must point to the active Harness home}"
case "$DSH_HOME" in
  /*) ;;
  *) printf 'DSH_HOME must be an absolute path: %s\n' "$DSH_HOME" >&2; exit 2 ;;
esac

SKIN_ROOT="$DSH_HOME/skins"
TARGET="$SKIN_ROOT/$SKIN_ID"

verify_directory() {
  local directory="$1"
  [[ -d "$directory" ]] || { printf 'Skin directory not found: %s\n' "$directory" >&2; return 1; }
  (cd "$directory" && shasum -a 256 -c "$CHECKSUMS")
}

if [[ ${1:-} == '--check' ]]; then
  verify_directory "$TARGET"
  printf 'Verified original %s files at %s\n' "$SKIN_ID" "$TARGET"
  exit 0
fi

mkdir -p "$SKIN_ROOT"
SKIN_ROOT="$(cd "$SKIN_ROOT" && pwd -P)"
TARGET="$SKIN_ROOT/$SKIN_ID"
STAGING=''

cleanup_staging() {
  [[ -n "$STAGING" && -d "$STAGING" ]] || return 0
  local resolved
  resolved="$(cd "$STAGING" && pwd -P)"
  case "$resolved" in
    "$SKIN_ROOT/.${SKIN_ID}.download."*) rm -rf -- "$resolved" ;;
    *) printf 'Refusing to remove unexpected staging path: %s\n' "$resolved" >&2; return 1 ;;
  esac
}
trap cleanup_staging EXIT

STAGING="$(mktemp -d "$SKIN_ROOT/.${SKIN_ID}.download.XXXXXX")"
mkdir -p "$STAGING/assets" "$STAGING/preview"

FILES=(
  LICENSE
  README.md
  README.zh.md
  patches.css
  preview/dark.jpg
  preview/light.jpg
  skin.css
  skin.json
  assets/whale-fantasy-loop.mp4
)

for relative in "${FILES[@]}"; do
  printf 'Downloading %s\n' "$relative"
  curl --fail --location --retry 3 --silent --show-error \
    --output "$STAGING/$relative" "$BASE_URL/$relative"
done

verify_directory "$STAGING"

BACKUP=''
if [[ -e "$TARGET" ]]; then
  BACKUP="$SKIN_ROOT/${SKIN_ID}.backup-$(date +%Y%m%d-%H%M%S)-$$"
  printf 'Archiving existing skin to %s\n' "$BACKUP"
  mv "$TARGET" "$BACKUP"
fi

if ! mv "$STAGING" "$TARGET"; then
  if [[ -n "$BACKUP" && ! -e "$TARGET" ]]; then
    printf 'Restoring previous skin after installation failure\n' >&2
    mv "$BACKUP" "$TARGET"
  fi
  exit 1
fi
STAGING=''
trap - EXIT
printf 'Installed verified original skin at %s\n' "$TARGET"
