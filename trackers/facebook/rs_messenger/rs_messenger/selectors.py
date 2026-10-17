"""Every Messenger DOM selector the bridge depends on, in one place.

The Marketplace inbox is the least stable DOM this project touches — Facebook
restructures it more often than the search results or the create-listing form.
When reading or sending breaks, this is the only file that should need
editing, and `rs-messenger poll --dry-run` against a real session is the
check: it prints exactly what these selectors extracted without telling the
coordinator or Facebook anything.

Login/checkpoint markers deliberately live in rs_poster.selectors — the
session layer is shared, and `raise_if_restricted` applies them here too.

All text matching is English — the worker accounts must be set to English (US).
"""

import re

# -- urls --------------------------------------------------------------------

INBOX_URL = "https://www.facebook.com/marketplace/inbox"
# The seller-side conversation view for one thread. The id is the segment
# after /t/ in any inbox link.
THREAD_URL = "https://www.facebook.com/marketplace/t/{thread_id}/"

# -- inbox list --------------------------------------------------------------

# Every conversation in the inbox list links to its thread. Matching on the
# path fragment survives class churn; the id is extracted from the href.
THREAD_LINK = 'a[href*="/marketplace/t/"]'

# -- one conversation --------------------------------------------------------

# The conversation pane. Message text lives in dir="auto" nodes inside it;
# so do timestamps, day separators and the counterpart's name, which is why
# `inbox.looks_like_message` filters what comes back rather than trusting
# the selector to be precise.
CONVERSATION_PANE = 'div[role="main"]'
MESSAGE_TEXT = 'div[role="main"] div[dir="auto"]'

# A link to the listing the conversation is about, shown in the thread header.
LISTING_LINK = 'div[role="main"] a[href*="/marketplace/item/"]'

# Direction is read from the accessibility copy Facebook puts on each message
# row ("You sent", "You replied"). Walked up from the text node; when no
# marker is found the row is treated as INCOMING on purpose — a false "in"
# costs one redundant Telegram alert, a false "out" suppresses a real one.
OUTGOING_MARKER_RE = re.compile(r"\byou sent\b|\byou replied\b", re.IGNORECASE)

# Runs inside the conversation pane and returns [{text, direction}] in page
# order. Kept as one evaluate rather than per-row locator calls: the pane
# re-renders while Playwright walks it, and a snapshot taken in one pass
# cannot go stale halfway through.
EXTRACT_MESSAGES_JS = """
() => {
  const pane = document.querySelector('div[role="main"]');
  if (!pane) return [];
  const rows = [];
  for (const node of pane.querySelectorAll('div[dir="auto"]')) {
    const text = (node.innerText || "").trim();
    if (!text) continue;
    // Look a few ancestors up for the row's accessibility copy ("You sent").
    let direction = "in";
    let cursor = node;
    for (let hop = 0; hop < 6 && cursor; hop++, cursor = cursor.parentElement) {
      const label = (cursor.getAttribute && (cursor.getAttribute("aria-label") || "")) +
        " " + (cursor.dataset ? (cursor.dataset.tooltipContent || "") : "");
      if (/\\byou sent\\b|\\byou replied\\b/i.test(label)) { direction = "out"; break; }
    }
    rows.push({ text, direction });
  }
  return rows;
}
"""

# -- composer ----------------------------------------------------------------

# The reply box at the foot of a conversation. Facebook labels it "Message"
# (sometimes with the counterpart's name appended), and it is the only
# textbox in the pane.
COMPOSER_RE = re.compile(r"^Message\b|^Aa$", re.IGNORECASE)
COMPOSER_FALLBACK = 'div[role="main"] div[role="textbox"]'
