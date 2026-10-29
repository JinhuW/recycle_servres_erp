#!/usr/bin/env python3
"""Ship the fleet's AI verdicts from the workers' text logs into OpenSearch.

A stopgap. A worker ships its own `ai_eval` events only when it was started
with AIMM_OPENSEARCH_URL, which the fleet agent passes since v1.379.2
(RS-453). Workers started before that log their verdicts only to the rotating
text log inside the container, about three hours deep, and Docker cannot give
a running container a new variable; recreating one is a Facebook login.

So this runs from cron on each fleet host, reads every running fleet worker
that lacks the variable, rebuilds the `ai_eval` document from the text log
(the `Listing(` block, the `[AI-Prompt]` item, the `[AI-Response]` model and
time, the `concludes` line) and bulk-indexes it into the same daily
`fb-tracker-*` indices with `bridged: true`. A cached verdict prints no `Listing(` block, so the
listing comes from the prompt's "found a listing titled" line when there is
one. A worker that has the variable is
skipped, so nothing is counted twice. Once every worker ships its own, remove
the cron line.

Re-reading is idempotent: a fresh verdict is keyed by the model's generation
id, a cached one by worker, listing and comment (so a cached verdict repeated
every sweep is one document, where a native worker writes one per sweep).
The text log has no timestamps: a fresh verdict takes the response's
`created`, a cached one the nearest fresh verdict's before it.

    python3 ai-verdict-bridge.py --dry-run      # parse, print a summary and a sample
    python3 ai-verdict-bridge.py                # index into $OPENSEARCH_URL

    */5 * * * * python3 ~/fleet-ai-bridge/ai-verdict-bridge.py >> ~/fleet-ai-bridge/bridge.log 2>&1
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

OPENSEARCH_URL = os.environ.get("OPENSEARCH_URL", "http://10.10.10.73:9200")
INDEX_PREFIX = os.environ.get("OPENSEARCH_INDEX", "fb-tracker")
LOG_DIR = "/root/.ai-marketplace-monitor"
ROTATIONS = 9

CONCLUDES = re.compile(
    r"^\[\w+\]\[AI\]\[/\w+\] (?P<ai>\S+) concludes \[\w+\](?P<conclusion>.+?) \((?P<score>\d)\): "
    r"(?P<comment>.*)\[/\w+\] for listing \[cyan\](?P<title>.*)\[/cyan\]\.$"
)
FIELD = re.compile(r"^\s+(?P<k>\w+)=(?:'(?P<s>.*)'|(?P<n>[\d.]+|None|True|False)),?$")
ITEM = re.compile(r"^\[\w+\]\[AI-Prompt\]\[/\w+\] A user wants to buy an? (\S+) from Facebook")
PROMPT_LISTING = re.compile(
    r'^The user found a listing titled "(?P<title>.*)" in (?P<condition>.*?) condition, '
    r"priced at (?P<price>.*?), located in (?P<location>.*?), posted at (?P<post_url>\S+)"
)
ITEM_ID = re.compile(r"/marketplace/item/(\d+)")
MARKUP = re.compile(r"\[/?(?:red|green|blue|cyan|yellow|magenta|white|bold|dim)\]")
LISTING_KEYS = ("id", "title", "price", "post_url", "location", "seller", "condition")


def docker(*args: str) -> str:
    return subprocess.run(["docker", *args], check=True, capture_output=True, text=True).stdout


def workers() -> list[tuple[str, str]]:
    """Running fleet workers that do not ship their own events: (container, worker id)."""
    out = []
    for name in docker("ps", "--filter", "label=rs.fleet.worker", "--format", "{{.Names}}").split():
        info = json.loads(docker("inspect", name))[0]
        env = info["Config"]["Env"] or []
        if any(e.startswith("AIMM_OPENSEARCH_URL=") for e in env):
            continue
        out.append((name, info["Config"]["Labels"]["rs.fleet.worker"]))
    return out


def read_log(container: str) -> list[str]:
    """The text log oldest first, every rotation still on disk."""
    files = " ".join(f"{LOG_DIR}/ai-marketplace-monitor.log.{n}" for n in range(ROTATIONS, 0, -1))
    script = f"for f in {files} {LOG_DIR}/ai-marketplace-monitor.log; do [ -f $f ] && cat $f; done"
    return docker("exec", container, "sh", "-c", script).splitlines()


def unwrap(lines: list[str]) -> list[str]:
    """Rejoin a `concludes` line the console wrapped at its width."""
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if " concludes [" in line and not CONCLUDES.match(line):
            for n in range(1, 4):
                tail = lines[i + 1 : i + 1 + n]
                joined = next((j for j in ("".join([line, *tail]), " ".join([line, *tail])) if CONCLUDES.match(j)), None)
                if joined:
                    line, i = joined, i + n
                    break
        out.append(line)
        i += 1
    return out


def parse(lines: list[str], worker: str) -> list[tuple[str, dict]]:
    lines = unwrap(lines)
    docs: list[tuple[str, dict]] = []
    listings: dict[str, dict] = {}
    block: dict | None = None
    item = None
    prompt: dict | None = None
    response: dict | None = None
    last_created = None
    for line in lines:
        if block is not None:
            if line.startswith(")"):
                if block.get("title"):
                    listings[block["title"]] = block
                block = None
                continue
            m = FIELD.match(line)
            if m and m["k"] in LISTING_KEYS and m["s"] is not None:
                block[m["k"]] = m["s"]
            continue
        if line.endswith("[Retrieve][/green] Listing("):
            block = {}
            continue
        m = ITEM.match(line)
        if m:
            item = m[1]
            continue
        m = PROMPT_LISTING.match(line)
        if m:
            prompt = m.groupdict()
            continue
        if "[AI-Response]" in line:
            response = {}
            continue
        if response is not None:
            m = FIELD.match(line)
            if m and m["k"] == "id" and m["s"] and m["s"].startswith("gen-") and "id" not in response:
                response["id"] = m["s"]
            elif m and m["k"] == "model" and m["s"]:
                response["model"] = m["s"]
            elif m and m["k"] == "created" and m["n"]:
                response["created"] = float(m["n"])
        m = CONCLUDES.match(line)
        if not m:
            continue
        fresh = bool(response and response.get("id") and response.get("created"))
        if fresh:
            last_created = response["created"]
        if last_created is None:
            response = None
            continue
        listing = dict(listings.get(m["title"], {}))
        if prompt and prompt["title"] == m["title"]:
            listing = {**listing, **{k: v for k, v in prompt.items() if v}}
            found = ITEM_ID.search(prompt["post_url"])
            if found:
                listing.setdefault("id", found[1])
        prompt = None
        doc = {
            "@timestamp": datetime.fromtimestamp(last_created, tz=timezone.utc).isoformat(timespec="milliseconds"),
            "worker": worker,
            "level": "INFO",
            "message": MARKUP.sub("", line).strip(),
            "kind": "ai_eval",
            "bridged": True,
            "cached": not fresh,
            "listing_id": listing.get("id"),
            "title": m["title"],
            "url": listing.get("post_url"),
            "price": listing.get("price"),
            "score": int(m["score"]),
            "conclusion": m["conclusion"],
            "comment": m["comment"],
            "ai_name": m["ai"],
            "model": response.get("model") if fresh else None,
            "item": item,
            "location": listing.get("location"),
            "condition": listing.get("condition"),
            "seller": listing.get("seller"),
        }
        key = response["id"] if fresh else f"{worker}|{listing.get('id') or m['title']}|{m['comment']}|cached"
        docs.append((hashlib.sha1(f"bridge|{key}".encode()).hexdigest(), doc))
        response = None
    return docs


def index(docs: list[tuple[str, dict]]) -> int:
    body = []
    for doc_id, doc in docs:
        day = doc["@timestamp"][:10].replace("-", ".")
        body.append(json.dumps({"index": {"_index": f"{INDEX_PREFIX}-{day}", "_id": doc_id}}))
        body.append(json.dumps(doc, ensure_ascii=False))
    req = urllib.request.Request(
        f"{OPENSEARCH_URL}/_bulk",
        data=("\n".join(body) + "\n").encode(),
        headers={"Content-Type": "application/x-ndjson"},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        answer = json.load(res)
    failed = [i for i in answer["items"] if i["index"].get("error")]
    if failed:
        print(f"  {len(failed)} failed, first: {failed[0]['index']['error']}", file=sys.stderr)
    return len(docs) - len(failed)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    total = 0
    for container, worker in workers():
        try:
            docs = parse(read_log(container), worker)
        except subprocess.CalledProcessError as e:
            print(f"{stamp} {worker}: could not read the log: {e.stderr.strip()}", file=sys.stderr)
            continue
        fresh = sum(1 for _, d in docs if not d["cached"])
        if args.dry_run:
            print(f"{worker}: {len(docs)} verdicts ({fresh} fresh)")
            if docs:
                print(json.dumps(docs[-1][1], ensure_ascii=False, indent=1))
            continue
        if docs:
            total += index(docs)
    if not args.dry_run:
        print(f"{stamp} indexed {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
