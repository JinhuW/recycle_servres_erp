"""A10-08: the handler's get -> apply -> save is not atomic; replay two interleaved reports."""
import json
from test_session_backup import env  # noqa: F401
from rs_coordinator import incidents


def test_interleaved_down_reports(env):
    db = env.db
    key = "ai-provider"
    # Two handlers read the row before either saves (the threadpool runs sync defs concurrently)
    seen_a = db.get_incident(key)
    seen_b = db.get_incident(key)
    row_a, text_a = incidents.apply(key, seen_a, "va-1", "down", "429")
    row_b, text_b = incidents.apply(key, seen_b, "va-2", "down", "429")
    db.save_incident(row_a)
    db.save_incident(row_b)
    print("pages DOWN:", bool(text_a), bool(text_b))
    assert text_a and text_b                      # paged twice
    saved = db.get_incident(key)
    votes = json.loads(saved["reporters"])
    print("votes kept:", sorted(votes))
    assert sorted(votes) == ["va-2"]              # va-1's vote lost
    row_c, text_c = incidents.apply(key, saved, "va-2", "up")
    print("after va-2 up: open=", row_c["is_open"], "recovered page:", bool(text_c))
    assert row_c["is_open"] == 0 and text_c       # closes while va-1 is still down
