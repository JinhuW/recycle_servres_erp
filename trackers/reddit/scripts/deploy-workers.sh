#!/usr/bin/env bash
# Deploys (or redeploys) the tracker to every OCI worker VM.
#
# Day 1 and day 2 are the same command: push the env file, log into GHCR,
# pull the image, replace the container. Sequential with a pause so the fleet
# never fully stops — a restarting worker's claims expire naturally.
#
# Usage:
#   scripts/deploy-workers.sh [tag]     # default tag: latest
#
# Reads:
#   scripts/secrets.env                  # gitignored; see secrets.env.example
#   infra/terraform output               # worker IPs
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-latest}"
IMAGE="ghcr.io/jinhuw/reddits_tracker:${TAG}"
SECRETS="scripts/secrets.env"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

[[ -f "$SECRETS" ]] || { echo "Missing $SECRETS — copy scripts/secrets.env.example" >&2; exit 1; }
# shellcheck disable=SC1090
source "$SECRETS"
: "${DATABASE_URL:?set in secrets.env}" "${OPENROUTER_API_KEY:?set in secrets.env}"
: "${GHCR_USERNAME:?set in secrets.env}" "${GHCR_READ_TOKEN:?set in secrets.env}"

# The env file the workers run with. WORKER_ID stays unset (auto per process).
ENV_CONTENT="DATABASE_URL=${DATABASE_URL}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
ROLE=worker
ALERT_TRANSPORT=${ALERT_TRANSPORT:-console}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
LOG_LEVEL=${LOG_LEVEL:-info}"

IPS=$(terraform -chdir=infra/terraform output -json worker_ips |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const pools=JSON.parse(s);
    for(const ips of Object.values(pools)) for(const ip of ips) console.log(ip);
  })')

[[ -n "$IPS" ]] || { echo "No worker IPs in terraform output — apply first." >&2; exit 1; }

echo "Deploying ${IMAGE} to:"
echo "$IPS" | sed 's/^/  /'

FAILED=()
for IP in $IPS; do
  echo "--- ${IP} ---"
  if ! {
    printf '%s\n' "$ENV_CONTENT" |
      ssh "${SSH_OPTS[@]}" "ubuntu@${IP}" \
        'sudo install -d -m 0755 /opt/reddits_tracker &&
         sudo tee /opt/reddits_tracker/.env > /dev/null &&
         sudo chmod 0600 /opt/reddits_tracker/.env'
    ssh "${SSH_OPTS[@]}" "ubuntu@${IP}" \
      "echo '${GHCR_READ_TOKEN}' | sudo docker login ghcr.io -u '${GHCR_USERNAME}' --password-stdin &&
       sudo docker pull '${IMAGE}' &&
       # Graceful stop first: SIGTERM reaches node (PID 1), which releases
       # claims and deletes its fleet row. rm -f alone SIGKILLs and leaves the
       # old worker lingering as stale/dead in the fleet view.
       { sudo docker stop -t 35 tracker 2>/dev/null || true; } &&
       sudo docker rm -f tracker 2>/dev/null || true &&
       sudo docker run -d --name tracker --restart unless-stopped \
         --env-file /opt/reddits_tracker/.env '${IMAGE}' &&
       sleep 3 && sudo docker ps --filter name=tracker --format '{{.Status}}'"
  }; then
    echo "FAILED: ${IP}" >&2
    FAILED+=("$IP")
    continue
  fi
  # Let the restarted worker settle before touching the next one.
  sleep 5
done

if ((${#FAILED[@]})); then
  echo "Done with failures: ${FAILED[*]}" >&2
  exit 1
fi
echo "All workers deployed."
