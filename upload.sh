#!/usr/bin/env bash

if [ -z "${BASH_VERSION:-}" ]; then
	if command -v bash >/dev/null 2>&1; then
		exec bash "$0" "$@"
	fi
	echo "Error: this script requires bash" >&2
	exit 1
fi

set -euo pipefail

usage() {
	echo "Usage: $0 <email>" >&2
}

POSITIONAL=()

for arg in "$@"; do
	case "$arg" in
	-h|--help)
		usage
		exit 0
		;;
	--*)
		echo "Error: Unknown option: $arg" >&2
		usage
		exit 1
		;;
	*)
		POSITIONAL+=("$arg")
		;;
	esac
done

if [ "${#POSITIONAL[@]}" -gt 1 ]; then
	echo "Error: Too many arguments" >&2
	usage
	exit 1
fi

EMAIL="${POSITIONAL[0]:-${EMAIL:-}}"

if [ -z "$EMAIL" ]; then
	echo "Error: EMAIL must be provided as an argument or set as an environment variable" >&2
	usage
	exit 1
fi

require_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Error: Required command not found: $1" >&2
		exit 1
	fi
}

require_cmd zip
require_cmd curl

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEMP_DIR=$(mktemp -d)
ZIP_FILE="$TEMP_DIR/submission.zip"

trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Creating zip file..."

cd "$PROJECT_ROOT"

zip -r "$ZIP_FILE" . \
	-x ".git/*" \
	-x "node_modules/*" \
	-x ".venv/*" \
	-x "__pycache__/*" \
	-x ".cache/*" \
	-x ".mini-rube/*" \
	-x ".playwright-cli/*" \
	-x ".next/*" \
	-x "*.tsbuildinfo" \
	-x "dist/*" \
	-x ".DS_Store" \
	-x ".env*" \
	-x "*.log" \
	-x "coverage/*" \
	-x "*.pem" \
	-x "project.zip"

if [ ! -f "$ZIP_FILE" ]; then
	echo "Error: Failed to create zip file" >&2
	exit 1
fi

echo "Uploading submission..."

SUBMIT_URL="${SUBMIT_URL:-https://eng.hiring.composio.io/api/submit}"

if ! RESPONSE=$(curl -sS -w "\n%{http_code}" -X POST "$SUBMIT_URL" \
	-F "email=$EMAIL" \
	-F "task=mini-rube" \
	-F "file=@$ZIP_FILE"); then
	echo "Error: Upload request failed before receiving a response" >&2
	exit 1
fi

HTTP_CODE=$(printf '%s\n' "$RESPONSE" | tail -n1)
BODY=$(printf '%s\n' "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
	echo "Submitted"
else
	echo "Error: Submission failed (HTTP $HTTP_CODE)" >&2
	echo "$BODY" >&2
	exit 1
fi
