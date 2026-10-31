"""A10-11: settings.apply writes fleet configs one by one; a failure mid-way keeps the earlier writes,
and the PUT handler (app.py:850-857) maps FleetError(OSError) to 500 before settings.save()."""
import os
os.environ["RS_WORKER_CONFIGS"] = ""
from rs_console import settings


class FakeFleet:
    def __init__(self):
        self.written = []
    def ids(self):
        return ["va-1", "va-2", "va-3"]
    def read(self, wid):
        return '[ai.openai]\nmodel = "old"\n'
    def write(self, wid, text, by=None):
        if wid == "va-2":
            raise settings.FleetError("coordinator unreachable: timed out")
        self.written.append(wid)
        return True


fleet = FakeFleet()
try:
    settings.apply({"ai_model": "new"}, fleet=fleet)
except OSError as e:
    print("apply raised", type(e).__name__, "isinstance OSError:", isinstance(e, OSError), "->", e)
print("configs already written before the failure:", fleet.written)
