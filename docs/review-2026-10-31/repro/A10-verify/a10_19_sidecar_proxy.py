"""A10-19: re-capturing without --proxy keeps the first capture's proxy in the sidecar."""
import json, sys, tempfile
from pathlib import Path
from rs_poster.cookies import write_session_meta, meta_path_for

d = Path(tempfile.mkdtemp()); s = d / "w.json"; s.write_text("{}")
write_session_meta(s, user_agent="UA1", proxy="http://proxy-x:10003", account_id="111")
write_session_meta(s, user_agent="UA2", proxy=None, account_id="111")   # re-capture on the house IP
m = json.loads(meta_path_for(s).read_text())
print("sidecar after re-capture without --proxy: proxy =", m.get("proxy"), "user_agent =", m.get("user_agent"))
assert m.get("proxy") == "http://proxy-x:10003"
