#!/usr/bin/env bash
# Demo instance for the README screenshots: a separate DSH home (/tmp/dsh-demo
# by default) with the lab profile, the scripted demo replies of
# test/lab/demo-replies.json and a small workspace under /tmp/demo-app.
# No markers, test titles or private paths show up in it.
#   test/lab/demo.sh start|seed|stop|restart|url
# Uses the same ports as the lab (3193, 3194): stop the lab first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEMO_HOME="${DEMO_HOME:-/tmp/dsh-demo}"
APP=/tmp/demo-app
export LAB_HOME="$DEMO_HOME" MOCK_DEMO_FILE="${MOCK_DEMO_FILE:-$HERE/demo-replies.json}" MOCK_DEMO_MODE=1 MOCK_HANDOFF_DELAY_MS="${MOCK_HANDOFF_DELAY_MS:-12000}"

prepare_home() {
  [ -d "$DEMO_HOME/profiles/lab" ] && return
  local src="${SOURCE_LAB_HOME:-$HOME/dsh-lab}/profiles/lab"
  [ -d "$src/node_modules" ] || { echo "install the lab profile first ($src)" >&2; exit 1; }
  mkdir -p "$DEMO_HOME/profiles"
  chmod 700 "$DEMO_HOME"
  cp -a "$src" "$DEMO_HOME/profiles/lab"
  # the demo profile: one scripted model with a neutral name, no machine secret
  node - "$DEMO_HOME/profiles/lab/cordis.patch.yml" <<'EOF'
const fs = require('fs')
const file = process.argv[2]
let s = fs.readFileSync(file, 'utf8')
s = s.replace(/^# LAB profile.*$/m, '# Demo profile for the dsh-conductor screenshots. No secrets.')
s = s.replace('displayName: Lab mock (scripted)', 'displayName: Demo provider')
s = s.replace(/display: Mock 1\n(\s+)id: mock-1\n(\s+)name: Mock 1/, 'display: Demo model\n$1id: mock-1\n$2name: Demo model')
s = s.replace(/\n {6}lab-ollama:[\s\S]*?(?=\n- id:)/, '')
s = s.replace(/\n {4}api:\n {6}rateLimitPerMinute: 60\n {6}secret: .*/, '')
s = s.replace(/\n {4}recovery:\n(?: {6}.*\n?)+/, '\n')
fs.writeFileSync(file, s)
EOF
}

write_app() {
  rm -rf "${APP:?}"
  mkdir -p "$APP/src" "$APP/test" "$APP/docs/api"
  cat > "$APP/package.json" <<'EOF'
{ "name": "billing-service", "version": "0.3.2", "private": true, "type": "module", "scripts": { "test": "node --test" } }
EOF
  cat > "$APP/src/invoice.ts" <<'EOF'
import type { Customer, Line } from './types'

/** One line, in integer cents. */
export function lineTotal(line: Line): number {
  return Math.round(line.quantity * line.unitPrice * 100) / 100
}

/** The invoice total with tax, in the customer's currency. */
export function invoiceTotal(lines: Line[], customer: Customer): number {
  const net = lines.reduce((sum, line) => sum + lineTotal(line), 0)
  return net * (1 + customer.taxRate)
}
EOF
  cat > "$APP/src/payments.ts" <<'EOF'
/** Charge a card through the payment provider. */
export async function charge(client, request) {
  return client.post('/charges', request)
}
EOF
  cat > "$APP/src/util.ts" <<'EOF'
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
EOF
  cat > "$APP/CHANGELOG.md" <<'EOF'
# Changelog

## 0.3.2

- Fix the VAT label on credit notes.
EOF
  cat > "$APP/docs/api/invoices.md" <<'EOF'
# Invoices API

`GET /invoices/:id` returns one invoice with its lines and totals.
EOF
}

case "${1:-start}" in
  start) prepare_home; write_app; "$HERE/lab.sh" start ;;
  seed) node "$HERE/demo-seed.mjs" ;;
  stop) "$HERE/lab.sh" stop ;;
  restart) "$HERE/lab.sh" stop; "$HERE/lab.sh" start ;;
  url) "$HERE/lab.sh" url ;;
  *) echo "usage: demo.sh start|seed|stop|restart|url" >&2; exit 2 ;;
esac
