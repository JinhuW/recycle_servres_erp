"""A10-05: escape_markdown leaves '\\' unescaped, so a trailing backslash eats the bold close."""
from rs_coordinator.telegram_notify import format_listing, escape_markdown, MAX_MESSAGE_LENGTH

def unescaped_stars(text):
    n, i = 0, 0
    while i < len(text):
        if text[i] == "\\":
            i += 2; continue
        if text[i] == "*":
            n += 1
        i += 1
    return n

ok = format_listing({"title": "R730 64GB"}, "new", "va-1")
bad = format_listing({"title": "R730 64GB\\"}, "new", "va-1")
print("escape_markdown('a\\\\b') =", repr(escape_markdown("a\\b")))
print("good first line:", ok.splitlines()[0], "unescaped * =", unescaped_stars(ok))
print("bad  first line:", bad.splitlines()[0], "unescaped * =", unescaped_stars(bad))
# truncation after escaping: cut inside an escape pair leaves a dangling '\'
long = format_listing({"title": "x", "ai_comment": "." * 5000}, "new", "va-1")
cut = long[:MAX_MESSAGE_LENGTH]
print("len before cut", len(long), "cut ends with", repr(cut[-3:]), "dangling backslash:", cut.endswith("\\") and not cut.endswith("\\\\"))
