#!/usr/bin/env bash
# LAB ONLY: start, stop or restart the isolated DSH instance used by test/e2e.mjs.
#   DSH_HOME=~/dsh-lab, profile "lab", web on 127.0.0.1:3193, mock model on 127.0.0.1:3194.
# Never touches the live dsh-web (port 3080, ~/.dsh).
#   test/lab/lab.sh start|stop|restart|status|url
set -euo pipefail
LAB_HOME="${LAB_HOME:-$HOME/dsh-lab}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB_PORT=3193
MOCK_PORT=3194
RUN="$LAB_HOME/run"
mkdir -p "$RUN"

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_mock() {
  if pid_alive "$RUN/mock.pid" || ss -ltn | grep -q ":$MOCK_PORT "; then return; fi
  setsid nohup node "$HERE/mock-llm.mjs" "$MOCK_PORT" /tmp/dsh-lab-mock-llm.jsonl > "$RUN/mock.log" 2>&1 < /dev/null &
  echo $! > "$RUN/mock.pid"
}

start_web() {
  if pid_alive "$RUN/web.pid"; then echo "lab web already running (pid $(cat "$RUN/web.pid"))"; return; fi
  if ss -ltn | grep -q ":$WEB_PORT "; then echo "port $WEB_PORT is taken by another process; stop it first" >&2; exit 1; fi
  (
    cd "$LAB_HOME"
    export DSH_HOME="$LAB_HOME" LAB_MOCK_KEY=lab LAB_PROBE_TOKEN=lab
    setsid nohup dsh --profile lab --no-open --host 127.0.0.1 --port "$WEB_PORT" > "$LAB_HOME/web.log" 2>&1 < /dev/null &
    echo $! > "$RUN/web.pid"
  )
  for _ in $(seq 1 60); do
    grep -q "dsh web: http" "$LAB_HOME/web.log" 2>/dev/null && break
    sleep 1
  done
  grep -E "dsh web: http|dsh-conductor: (armed|compaction hook|commands)" "$LAB_HOME/web.log" || { echo "lab did not come up; see $LAB_HOME/web.log" >&2; exit 1; }
}

stop_web() {
  if pid_alive "$RUN/web.pid"; then
    kill -TERM -- "-$(cat "$RUN/web.pid")" 2>/dev/null || kill -TERM "$(cat "$RUN/web.pid")" 2>/dev/null || true
    for _ in $(seq 1 20); do pid_alive "$RUN/web.pid" || break; sleep 0.5; done
  fi
  rm -f "$RUN/web.pid"
}

case "${1:-status}" in
  start) start_mock; start_web ;;
  stop) stop_web; if pid_alive "$RUN/mock.pid"; then kill "$(cat "$RUN/mock.pid")" || true; fi; rm -f "$RUN/mock.pid" ;;
  restart) stop_web; start_mock; start_web ;;
  status) pid_alive "$RUN/web.pid" && echo "web up (pid $(cat "$RUN/web.pid"))" || echo "web down"; pid_alive "$RUN/mock.pid" && echo "mock up" || echo "mock: $(ss -ltn | grep -q ":$MOCK_PORT " && echo 'port in use (another owner)' || echo down)" ;;
  url) grep -oE "http://127.0.0.1:$WEB_PORT/\?token=[^ ]+" "$LAB_HOME/web.log" | tail -1 ;;
  *) echo "usage: $0 start|stop|restart|status|url" >&2; exit 2 ;;
esac
