# Forty workers exhaust the VM's inotify instances

**2026-10-20, facebook-tracker 0.13.9 (RS-334).**

## Symptom

Right after 18 partner workers were added to the homelab VM (22 → 40
`rs-monitor-*` containers), the load average went from about 3 to 37 on 8
cores and stayed there. Every new worker's `/var/log/supervisor/aimm.log`
repeated:

```
ERROR    [Monitor] [Errno 24] inotify instance limit reached
```

followed by the monitor's statistics dump. The dump is its exit: supervisord
restarts `aimm`, and the monitor runs a sweep at once on startup, so each
failure is another launch of Chromium and another sweep. Four of the existing
workers (ne-1, phl-1, va-2, ca-1) hit it once too, at the end of a sweep,
and phl-1 and va-2 swept again off schedule.

## Cause

`fs.inotify.max_user_instances` is a per-user limit in the host kernel, and
is not namespaced. Every worker container runs as root, so all of them, with
Chromium, Xvfb and supervisord inside, share the host root's 128 instances
(Ubuntu's default). 22 workers fit under that; 40 do not. The monitor opens
an inotify watcher on its config and session file after each job, and a
failed `inotify_init` ends its loop.

## Fix

Raise the limit on the VM, persistently:

```bash
echo fs.inotify.max_user_instances=1024 | sudo tee /etc/sysctl.d/60-inotify.conf
sudo sysctl --system | grep inotify
```

1024 instances cost a few kilobytes of kernel memory each and leave room for
well over a hundred workers. `max_user_watches` (498127) was not the limit.

Until then, the workers that tip it over have to stay stopped. Here that was
the 18 new partners, which were parked with no accounts: `docker stop` lost
nothing, and `docker start` brings them back on the same session and cache.

## Checking

```bash
sysctl fs.inotify.max_user_instances
for c in $(docker ps --filter name=rs-monitor --format '{{.Names}}'); do
  n=$(docker exec $c sh -c 'grep -c "inotify instance limit" /var/log/supervisor/aimm.log')
  [ "$n" != 0 ] && echo "$c $n"
done
```

The log resets when a container restarts, so a zero is only good since that
container's last start.
