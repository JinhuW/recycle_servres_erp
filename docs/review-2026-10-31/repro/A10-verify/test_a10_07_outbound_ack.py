"""A10-07: any worker token acks any worker's queued reply; fetch hands the same row out twice."""
from test_session_backup import env, worker_auth  # noqa: F401


def test_other_worker_acks_and_double_fetch(env):
    oid_row = env.db.enqueue_outbound("thread-1", "va-1", "hi, still available?", "operator")
    a1 = env.get("/v1/messages/outbound", headers=worker_auth("va-1")).json()["outbound"]
    a2 = env.get("/v1/messages/outbound", headers=worker_auth("va-1")).json()["outbound"]
    print("two polls before ack both get:", [r["id"] for r in a1], [r["id"] for r in a2])
    assert a1 and a1 == a2           # no claim/lease: both pollers would send it
    oid = a1[0]["id"]
    r = env.post(f"/v1/messages/outbound/{oid}/ack", json={"status": "sent"}, headers=worker_auth("va-9"))
    print("va-9 acks va-1's reply:", r.status_code, r.json())
    assert r.status_code == 200
    left = env.get("/v1/messages/outbound", headers=worker_auth("va-1")).json()["outbound"]
    assert left == []                # va-1 never sends it
