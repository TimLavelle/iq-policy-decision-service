#!/bin/bash
# wire-gorules.sh — verify GoRules package API then update server.ts
set -e
cd ~/Development/projects/qantas/iq-prototype/iq-policy-decision-service

echo "=== GoRules package exports ==="
node -e "
  const pkg = require('@gorules/zen-engine')
  console.log(JSON.stringify(Object.keys(pkg), null, 2))
" 2>/dev/null || echo "Could not read exports — check package install"

echo "=== GoRules README ==="
find node_modules/@gorules/zen-engine -name "README*" -exec head -120 {} \; 2>/dev/null || true

echo "=== GoRules index.d.ts ==="
find node_modules/@gorules/zen-engine -name "*.d.ts" | head -3 | xargs head -80 2>/dev/null || true
