#!/bin/sh
set -eu
cd "$(dirname "$0")/../../../../trackers/facebook"
homelab_workers() {
    for f in deploy/docker-compose.homelab*.yml; do
        service=$(sed -n '/^services:/{n;s/^ *\([a-z0-9-]*\):.*/\1/p;}' "$f")
        container=$(sed -n 's/^ *container_name: *//p' "$f")
        config=$(sed -n 's#^ *- \.\./configs/\([a-z0-9-]*\.toml\):.*#\1#p' "$f")
        printf '%s %s %s %s\n' "$f" "$service" "$container" "$config"
    done
}
held(){ return 1; }
n=0; for line in $(homelab_workers); do n=$((n+1)); echo "verify would check: $line"; done; echo "verify loop iterations=$n"
echo "WORKER_COUNT=$(homelab_workers | wc -l | tr -d " ")"
homelab_workers | while read -r f s c _; do echo "would restart $c"; done; echo "restart loop done"
