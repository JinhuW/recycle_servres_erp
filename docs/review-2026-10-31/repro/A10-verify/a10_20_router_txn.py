"""A10-20: rs-router's txn ids restart at rsrouter-1 per process; a connection error is a MatrixError,
which drain_outbound acks as a permanent failure."""
import io, json, urllib.error
from rs_router.matrix import MatrixClient, MatrixError

paths = []
def opener(req, timeout=None):
    paths.append(req.full_url.rsplit("/", 1)[-1])
    return io.BytesIO(json.dumps({"event_id": "$x"}).encode())

for _ in range(2):                      # two router processes (a restart in between)
    c = MatrixClient("http://hs", "tok", opener=opener)
    c.send_text("!room:hs", "hello")
print("txn ids sent by process 1 and process 2:", paths)

def refused(req, timeout=None):
    raise urllib.error.URLError(ConnectionRefusedError(61, "Connection refused"))
try:
    MatrixClient("http://hs", "tok", opener=refused).send_text("!room:hs", "hi")
except MatrixError as e:
    print("homeserver down raises MatrixError (-> ack failed, permanent=True):", e)
