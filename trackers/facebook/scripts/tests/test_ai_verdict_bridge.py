"""Log parsing of scripts/ai-verdict-bridge.py, run without the VM.

    .venv-coordinator/bin/python -m pytest scripts/tests/test_ai_verdict_bridge.py
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "ai-verdict-bridge.py"
spec = importlib.util.spec_from_file_location("ai_verdict_bridge", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
sys.modules["ai_verdict_bridge"] = bridge
spec.loader.exec_module(bridge)  # type: ignore[union-attr]


def response(content: str) -> list[str]:
    return [
        "[info][AI-Response][/info] ChatCompletion(",
        "    id='gen-1761800000-abc',",
        "    model='openai/gpt-x',",
        "    created=1761800000,",
        f"                content={content},",
        ")",
    ]


CONCLUDES = ("[info][AI][/info] openrouter concludes [green]Good deal (4): 50x DIMMs[/green] "
             "for listing [cyan]Lot of RAM[/cyan].")


def test_reads_the_logged_python_literal_not_raw_json():
    # pretty_repr escapes the apostrophe and keeps the answer's newline escaped.
    lines = response("""'{"rating":4,"unit_count":"50","count_phrase":"50 sticks","summary":"Seller\\'s RAM"}\\n'""")
    [(_, doc)] = bridge.parse([*lines, CONCLUDES], "homelab-1")
    assert doc["unit_count"] == 50
    assert doc["count_phrase"] == "50 sticks"
    assert doc["cached"] is False


def test_coerces_the_count_as_the_monitor_does():
    assert [bridge.unit_count(v) for v in ("12", " 7 ", 3.9, 0, -2, True, "many", None)] == [12, 7, 3, None, None, None, None, None]


def test_an_answer_with_prose_around_the_json_still_counts():
    lines = response("""'Here you go: {"rating":4,"unit_count":60,"summary":"ok"}'""")
    [(_, doc)] = bridge.parse([*lines, CONCLUDES], "homelab-1")
    assert doc["unit_count"] == 60


def test_tail_leaves_out_a_verdict_whose_response_block_scrolled_away():
    lines = [*response("""'{"rating":4,"unit_count":50,"summary":"ok"}'"""), CONCLUDES]
    [(fresh_id, _)] = bridge.parse(lines, "homelab-1", 1761800000.0, tail=4)
    # Later the buffer holds the conclusion without its response block, plus
    # new lines: read whole it would come back as a cached verdict.
    later = [CONCLUDES, *["noise"] * 10]
    [(cached_id, cached)] = bridge.parse(later, "homelab-1", 1761800000.0)
    assert cached["cached"] is True and cached_id != fresh_id
    assert bridge.parse(later, "homelab-1", 1761800000.0, tail=4) == []
