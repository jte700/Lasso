#!/bin/bash
# Serves this folder on http://localhost:8765 and opens it in the browser.
# The site needs a local server: browsers block its scripts when opened straight from the file.
cd "$(dirname "$0")"
(sleep 1 && open "http://localhost:8765/") &
python3 -m http.server 8765
