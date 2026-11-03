#!/bin/sh
# Opens the screensaver's settings page (Linux and macOS; Settings.cmd on Windows): starts its server
# in the background with its output in build/logs, or only opens the page when the server already
# runs. The server stops by itself once no page is open.
dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$dir/build/logs"
nohup python3 "$dir/tools/settings.py" "$@" >>"$dir/build/logs/settings-$(date +%Y%m%d-%H%M%S).log" 2>&1 </dev/null &
