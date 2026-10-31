"""A10-12: an unauthenticated VNC websocket makes the console do a blocking coordinator call
on the event loop; with a hung coordinator every other request waits ~10 s."""
import os, socket, sys, threading, time, subprocess, urllib.request

# A coordinator that accepts and never answers.
hang = socket.socket(); hang.bind(("127.0.0.1", 0)); hang.listen(50)
held = []
threading.Thread(target=lambda: [held.append(hang.accept()) for _ in iter(int, 1)], daemon=True).start()
up = f"http://127.0.0.1:{hang.getsockname()[1]}"

s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
env = dict(os.environ, RS_COORDINATOR_URL=up, RS_ADMIN_TOKEN="x", RS_CONSOLE_TOKEN="y",
           RS_WORKER_CONFIGS="", RS_VNC_TARGETS="", PYTHONPATH=sys.argv[1])
srv = subprocess.Popen([sys.executable, "-m", "uvicorn", "rs_console.app:app", "--port", str(port),
                        "--log-level", "warning"], env=env)
try:
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1); break
        except Exception:
            time.sleep(0.2)
    t0 = time.monotonic(); urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=30)
    print(f"healthz baseline: {time.monotonic()-t0:.2f}s")

    import websockets.sync.client as wsc
    def ws():
        try:
            wsc.connect(f"ws://127.0.0.1:{port}/v1/vnc/va-1/ws", open_timeout=30)
        except Exception as e:
            print("ws (no ticket) ended:", type(e).__name__)
    th = threading.Thread(target=ws); th.start(); time.sleep(0.5)
    t0 = time.monotonic(); urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=30)
    print(f"healthz while an unauthenticated ws is open: {time.monotonic()-t0:.2f}s")
    th.join()
finally:
    srv.terminate(); srv.wait()
