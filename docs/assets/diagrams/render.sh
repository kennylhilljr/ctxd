#!/usr/bin/env bash
# Renders each docs/assets/diagrams/*.mmd to <name>-light.svg and <name>-dark.svg for the README.
# GitHub shows the pre-rendered images, so diagrams never depend on GitHub's Mermaid renderer.
# Needs Node and a Chromium; set PUPPETEER_EXECUTABLE_PATH if Puppeteer cannot find one.
set -euo pipefail
cd "$(dirname "$0")"
for src in *.mmd; do
  name="${src%.mmd}"
  npx -y @mermaid-js/mermaid-cli@11 -q -c mermaid-config.json -t default -b white -i "$src" -o "$name-light.svg"
  npx -y @mermaid-js/mermaid-cli@11 -q -c mermaid-config.json -t dark -b '#0d1117' -i "$src" -o "$name-dark.svg"
done
