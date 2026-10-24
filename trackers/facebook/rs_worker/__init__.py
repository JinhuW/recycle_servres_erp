"""The worker image's entrypoint: fleet mode around the vendored monitor.

`python -m rs_worker.entry` is the image's ENTRYPOINT. Without the three
`RS_FLEET_*` variables it execs the image's command and the worker runs as it
always has; with them it claims an account from the ERP's fleet and runs the
monitor in fleet mode. See `entry.py`.
"""
