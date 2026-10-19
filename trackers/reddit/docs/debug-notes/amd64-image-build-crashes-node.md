# The amd64 half of the image build crashes node under emulation

**Date:** 2026-10-18 · **Symptom:** the multi-arch build in *Deployment*
(`docker buildx build --platform linux/arm64,linux/amd64 … --push .`) fails
only for `linux/amd64`, at `RUN pnpm install --frozen-lockfile --prod`. pnpm
gets as far as printing `Done`, and then:

```
node: ../deps/uv/src/unix/linux.c:1427: uv__io_poll: Assertion `errno == EEXIST' failed.
ERROR: … did not complete successfully: exit code: 134
```

The arm64 half builds fine.

## What happened

On an Apple Silicon Mac, the amd64 half runs under QEMU user-mode emulation
inside the colima VM. The emulator that colima had registered for x86_64
binaries mis-handled a syscall that node 24's libuv makes, and node aborted on
an assertion.

- **The code didn't cause it.** The same Dockerfile, with the same node
  24.22.0 base, built on 2026-10-16. The emulator changed, not the code.
- **`UV_USE_IO_URING=0` doesn't help**, even though it is the usual fix for
  libuv under QEMU.

## Why not just ship arm64

The fleet isn't all ARM. `infra/terraform/fleet.tf` runs E2.1.Micro amd64
VMs next to the A1.Flex ones, and one of them (`40.233.71.45` on this date)
would pull an image with no amd64 manifest.

## Fix

Replace the registered emulator with the one `tonistiigi/binfmt` ships, then
rebuild:

```bash
docker run --privileged --rm tonistiigi/binfmt --uninstall qemu-x86_64
docker run --privileged --rm tonistiigi/binfmt --install amd64
```

`docker run --privileged --rm tonistiigi/binfmt` with no arguments lists
what's registered. A colima restart provisions its own emulator again, so
expect to repeat this after one.
