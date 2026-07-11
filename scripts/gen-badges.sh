#!/usr/bin/env bash
#
# Generate static SonarQube badge SVGs from the private SonarQube instance.
#
# Runs in CI (see .github/workflows/ci.yml) using the same SONAR_TOKEN that
# drives the analysis, so nothing secret ever lands in the repo or the README:
# the authenticated API values are baked into plain SVGs that get committed to
# docs/badges/ and referenced from README.md.
#
# Requires: curl, jq, and the env vars SONAR_HOST_URL and SONAR_TOKEN.
# Usage: scripts/gen-badges.sh
set -euo pipefail

: "${SONAR_HOST_URL:?SONAR_HOST_URL is required}"
: "${SONAR_TOKEN:?SONAR_TOKEN is required}"

PROJECT_KEY="${SONAR_PROJECT_KEY:-noxed}"
BRANCH="${SONAR_BRANCH:-main}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/badges"
mkdir -p "$OUT_DIR"

api() { curl -sfSL -u "${SONAR_TOKEN}:" "${SONAR_HOST_URL%/}$1"; }

# Wait for any in-flight analysis to finish so we read fresh numbers, not the
# previous run's. Gives up after ~2 min and uses whatever is current.
wait_for_analysis() {
  for _ in $(seq 1 40); do
    local body queued current
    body="$(api "/api/ce/component?component=${PROJECT_KEY}")" || return 0
    queued="$(jq -r '.queue | length' <<<"$body")"
    current="$(jq -r '.current.status // "NONE"' <<<"$body")"
    if [ "$queued" = "0" ] && [ "$current" != "IN_PROGRESS" ] && [ "$current" != "PENDING" ]; then
      return 0
    fi
    sleep 3
  done
}

# shields.io static badge, rendered server-side in CI and saved locally.
badge() { # <file> <label> <message> <color>
  curl -sfSL -G "https://img.shields.io/static/v1" \
    --data-urlencode "label=$2" \
    --data-urlencode "message=$3" \
    --data-urlencode "color=$4" \
    --data-urlencode "style=flat" \
    -o "${OUT_DIR}/$1.svg"
  echo "  wrote docs/badges/$1.svg  ($2: $3)"
}

rating_letter() { # <float 1.0-5.0> -> A..E
  case "$(printf '%.0f' "$1")" in
    1) echo A ;; 2) echo B ;; 3) echo C ;; 4) echo D ;; *) echo E ;;
  esac
}
rating_color() { # <letter> -> shields color
  case "$1" in
    A) echo brightgreen ;; B) echo yellowgreen ;; C) echo yellow ;;
    D) echo orange ;; *) echo red ;;
  esac
}
coverage_color() { # <int pct>
  local p="$1"
  if   [ "$p" -ge 80 ]; then echo brightgreen
  elif [ "$p" -ge 60 ]; then echo green
  elif [ "$p" -ge 40 ]; then echo yellow
  elif [ "$p" -ge 20 ]; then echo orange
  else echo red; fi
}

wait_for_analysis

METRICS="alert_status,coverage,sqale_rating,reliability_rating,security_rating,ncloc"
measures="$(api "/api/measures/component?component=${PROJECT_KEY}&branch=${BRANCH}&metricKeys=${METRICS}")"
val() { jq -r --arg k "$1" '.component.measures[] | select(.metric==$k) | .value' <<<"$measures"; }

# Quality gate
case "$(val alert_status)" in
  OK)   badge quality_gate "quality gate" "passing" brightgreen ;;
  WARN) badge quality_gate "quality gate" "warning" yellow ;;
  *)    badge quality_gate "quality gate" "failing" red ;;
esac

# Coverage
cov="$(val coverage)"; cov_int="${cov%.*}"
badge coverage "coverage" "${cov_int}%" "$(coverage_color "$cov_int")"

# Ratings
for pair in "sqale_rating:maintainability" "reliability_rating:reliability" "security_rating:security"; do
  metric="${pair%%:*}"; label="${pair##*:}"
  letter="$(rating_letter "$(val "$metric")")"
  badge "$label" "$label" "$letter" "$(rating_color "$letter")"
done

# Lines of code (informational)
ncloc="$(val ncloc)"
if [ "$ncloc" -ge 1000 ]; then
  loc="$(awk -v n="$ncloc" 'BEGIN{printf "%.1fk", n/1000}')"
else
  loc="$ncloc"
fi
badge loc "lines of code" "$loc" blue

echo "Done."
