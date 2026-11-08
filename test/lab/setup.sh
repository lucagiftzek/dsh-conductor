#!/usr/bin/env bash
# Create the isolated test lab from scratch: a separate DSH home (default
# ~/dsh-lab) with one profile "lab" that mounts dsh-better-sidebar, this
# checkout and the lab probe, and talks only to the scripted mock model.
# Your own ~/.dsh is never touched. Run it once, then: test/lab/lab.sh start
#
#   test/lab/setup.sh            create (refuses to overwrite an existing lab)
#   test/lab/setup.sh --force    recreate the profile files (sessions are kept)
#
# Needs: dsh 0.2.1 or newer on PATH, pnpm, network access for the first
# pnpm install. The machine API secret is random and stays in
# $LAB_HOME/run/api-secret (mode 600); it is a throwaway lab secret.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LAB_HOME="${LAB_HOME:-$HOME/dsh-lab}"
PROFILE="$LAB_HOME/profiles/lab"
NAME="$(node -p "require('$REPO/package.json').name")"

if [ -e "$PROFILE/package.json" ] && [ "${1:-}" != "--force" ]; then
  echo "a lab already exists in $LAB_HOME (use --force to rewrite its profile files)" >&2
  exit 1
fi
command -v dsh >/dev/null || { echo "dsh is not on PATH" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is not on PATH" >&2; exit 1; }

umask 077
mkdir -p "$PROFILE" "$LAB_HOME/run"
[ -s "$LAB_HOME/run/api-secret" ] || node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))" > "$LAB_HOME/run/api-secret"
SECRET="$(cat "$LAB_HOME/run/api-secret")"

cat > "$PROFILE/package.json" <<EOF
{
  "name": "dsh-profile-lab",
  "private": true,
  "dependencies": {
    "dsh-better-sidebar": "0.28.2",
    "conductor-lab-probe": "link:$REPO/test/lab/probe",
    "$NAME": "link:$REPO"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-better-sidebar",
        "conductor-lab-probe",
        "$NAME"
      ]
    }
  }
}
EOF

cat > "$PROFILE/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF

[ -e "$PROFILE/cordis.yml" ] || printf '# dsh profile root. Edit cordis.patch.yml, not this file.\n[]\n' > "$PROFILE/cordis.yml"

cat > "$PROFILE/cordis.patch.yml" <<EOF
# Test lab: no real provider, no upload, no hot reload. The mock model is
# test/lab/mock-llm.mjs on 127.0.0.1:3194 (lab.sh starts it).
- id: hmr
  disabled: true
- id: client-hmr
  disabled: true
- id: session-log-deepseek
  disabled: true
- id: agent-default-model
  config:
    provider: lab-mock
    model: mock-1
- id: llm-pi-ai
  config:
    providers:
      lab-mock:
        api: openai-completions
        apiKeyEnv: LAB_MOCK_KEY
        baseURL: http://127.0.0.1:3194/v1
        compat:
          maxTokensField: max_tokens
          supportsDeveloperRole: false
        defaultMaxTokens: 8192
        displayName: Lab mock (scripted)
        retryPolicy:
          mode: normal
          maxRetries: 1
          backoff:
            initialDelayMs: 100
            maxDelayMs: 200
            jitterRatio: 0
        models:
          - contextWindow: 200000
            display: Mock 1
            id: mock-1
            name: Mock 1
            input:
              - text
            maxTokens: 8192
- id: dsh-conductor
  config:
    legacyRoute: true
    api:
      rateLimitPerMinute: 60
      secret: $SECRET
    tasks:
      allowCommandTasks: true
    setupCompleted: lab
    recovery:
      maxAttempts: 3
      baseDelayMs: 300
      maxDelayMs: 2000
EOF

(cd "$PROFILE" && pnpm install --silent)
echo "lab created in $LAB_HOME (profile lab). Next: test/lab/lab.sh start, then npm run test:e2e"
