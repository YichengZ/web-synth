#!/bin/sh
set -eu

cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server 8080
elif command -v python >/dev/null 2>&1; then
  python -m http.server 8080
else
  echo "Python 3 is required to start the offline site."
  echo "Install Python, then run this file again."
  exit 1
fi
