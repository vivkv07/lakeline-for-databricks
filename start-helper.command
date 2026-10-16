#!/bin/bash
# Lakeline for Databricks: double-click to start the local helper on macOS.
# Same behavior as start-helper.sh; keeps the window open if something goes wrong.
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/start-helper.sh" "$@"
status=$?
if [ "$status" -ne 0 ]; then
  echo
  read -r -p "Press Return to close this window. " _
fi
exit "$status"
