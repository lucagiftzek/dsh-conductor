#!/usr/bin/env bash
# dsh-conductor post-mount smoke.
#
# Run on the DSH host AFTER the plugin is composed and dsh-web (re)started:
#   bash scripts/verify-host.sh [port] [secret]
#
# Checks, in order:
#   1. health            the route is up and the plugin identifies itself
#   2. status            the dashboard shape (agents/tasks/runners/providers)
#   3. trust fence       a cross-site-styled read is refused
#   4. CSRF gate         an anonymous browser-style POST is refused
#   5. machine secret    (only when a secret is given) a probe round trip
#
# Exit code 0 = all good; each failure prints the failing check.
set -u

PORT="${1:-3080}"
BASE="http://127.0.0.1:${PORT}/dsh-conductor/api"
SECRET="${2:-${DSH_CONDUCTOR_SECRET:-}}"
FAIL=0

step() { printf '%-28s' "${1}"; }
ok()   { echo "ok"; }
bad()  { echo "FAIL (${1})"; FAIL=1; }

step "health"
BODY=$(curl -sS -m 6 "${BASE}/health" 2>/dev/null) || bad "no route"
case "${BODY}" in
  *'"plugin":"dsh-conductor"'*) ok ;;
  '') bad "empty response - is dsh-web restarted?" ;;
  *) bad "unexpected: ${BODY:0:80}" ;;
esac

step "status (dashboard shape)"
BODY=$(curl -sS -m 60 "${BASE}/status" 2>/dev/null) || bad "no route"
case "${BODY}" in
  *'"agents"'*'"tasks"'*'"runners"'*'"providers"'*) ok ;;
  *) bad "unexpected: ${BODY:0:80}" ;;
esac

step "cross-site read refused"
CODE=$(curl -sS -m 6 -o /dev/null -w '%{http_code}' -H 'sec-fetch-site: cross-site' "${BASE}/health" 2>/dev/null)
[ "${CODE}" = "403" ] && ok || bad "got ${CODE}, want 403"

step "anonymous POST refused"
CODE=$(curl -sS -m 6 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "${BASE}/tasks" 2>/dev/null)
{ [ "${CODE}" = "403" ] || [ "${CODE}" = "405" ]; } && ok || bad "got ${CODE}, want 403/405"

if [ -n "${SECRET}" ]; then
  step "machine probe (secret)"
  BODY=$(curl -sS -m 10 -X POST "${BASE}/remote/run" -H 'content-type: application/json' -H "x-conductor-secret: ${SECRET}" -d '{"kind":"probe"}' 2>/dev/null) || bad "no route"
  case "${BODY}" in
    *'"ok":true'*'tool server alive'*) ok ;;
    *secret-not-configured*) bad "secret not configured on the host" ;;
    *) bad "unexpected: ${BODY:0:80}" ;;
  esac
  step "bad secret refused"
  CODE=$(curl -sS -m 6 -o /dev/null -w '%{http_code}' -X POST "${BASE}/remote/run" -H 'content-type: application/json' -H 'x-conductor-secret: definitely-wrong' -d '{"kind":"probe"}' 2>/dev/null)
  [ "${CODE}" = "401" ] && ok || bad "got ${CODE}, want 401"
else
  echo "machine secret:       skipped (pass the secret as argument 2 or export DSH_CONDUCTOR_SECRET)"
fi

echo
if [ "${FAIL}" = "0" ]; then
  echo "dsh-conductor host smoke: ALL OK"
  echo "next: hard-refresh the browser (Cmd/Ctrl+Shift+R) and open the Orchestrate tab"
  exit 0
else
  echo "dsh-conductor host smoke: FAILURES - see above"
  exit 1
fi
