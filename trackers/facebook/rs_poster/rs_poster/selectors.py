"""Every Facebook DOM selector the poster depends on, in one place.

Facebook restructures Marketplace regularly, so when posting breaks this is
the only file that should need editing. Prefer role/label locators over CSS or
XPath: they survive class-name churn and read like the page.

All text is English — the worker accounts must be set to English (US).
"""

import re

# -- session -----------------------------------------------------------------

# Present only when logged out. Used to decide whether a restored session works.
LOGIN_EMAIL_INPUT = 'input[name="email"]'
LOGIN_PASSWORD_INPUT = 'input[name="pass"]'
TWO_FACTOR_INPUT = 'input[name="approvals_code"], input[autocomplete="one-time-code"]'
COOKIE_ACCEPT_RE = re.compile(r"Allow all cookies|Allow cookies|Accept All", re.IGNORECASE)
TRUST_DEVICE_RE = re.compile(r"Trust|Remember|Continue", re.IGNORECASE)

# -- urls --------------------------------------------------------------------

LOGIN_URL = "https://www.facebook.com/login/device-based/regular/login/"
MARKETPLACE_URL = "https://www.facebook.com/marketplace/"
CREATE_ITEM_URL = "https://www.facebook.com/marketplace/create/item"
YOUR_LISTINGS_URL = "https://www.facebook.com/marketplace/you/selling"

# -- create listing form -----------------------------------------------------

# The file input is hidden behind a styled button; set_input_files works on it
# directly without clicking anything.
PHOTO_INPUT = 'input[accept*="image"]'

TITLE_LABEL = re.compile(r"^Title$", re.IGNORECASE)
PRICE_LABEL = re.compile(r"^Price$", re.IGNORECASE)
DESCRIPTION_LABEL = re.compile(r"^Description$", re.IGNORECASE)
CATEGORY_LABEL = re.compile(r"^Category$", re.IGNORECASE)
CONDITION_LABEL = re.compile(r"^Condition$", re.IGNORECASE)
LOCATION_LABEL = re.compile(r"^Location$", re.IGNORECASE)

# Fallback for when get_by_label misses: Facebook renders "<span>Label</span>"
# next to the field, so anchor on the label text and take the sibling input.
LABEL_SIBLING_INPUT = '//span[text()="{label}"]/following-sibling::input[1]'

DIALOG_OPTION = '[role="option"], [role="menuitem"]'
NEXT_BUTTON_RE = re.compile(r"^Next$", re.IGNORECASE)
PUBLISH_BUTTON_RE = re.compile(r"^Publish$", re.IGNORECASE)
# Facebook disables Publish until the form validates; require the enabled one.
PUBLISH_ENABLED = 'div[aria-label="Publish"]:not([aria-disabled="true"])'
CREATE_FORM_HEADING_RE = re.compile(r"Item for sale|Marketplace listing", re.IGNORECASE)

# Leaving the create form after publishing pops a confirmation.
LEAVE_PAGE_RE = re.compile(r"^Leave page$|^Leave$|^Discard$", re.IGNORECASE)

# -- manage listings ---------------------------------------------------------

LISTING_SEARCH_INPUT = 'input[placeholder="Search your listings"]'
DELETE_BUTTON = 'div[aria-label="Delete"]'
CONFIRM_DELETE_RE = re.compile(r"^Delete listing$|^Delete Listing$|^Delete$", re.IGNORECASE)

# -- group sharing -----------------------------------------------------------

SHARE_BUTTON_RE = re.compile(r"^Share$", re.IGNORECASE)
SHARE_TO_GROUP_RE = re.compile(r"Share to a group|Group", re.IGNORECASE)
GROUP_SEARCH_INPUT = 'input[placeholder*="Search"]'
POST_BUTTON_RE = re.compile(r"^Post$", re.IGNORECASE)
COMPOSER_RE = re.compile(r"Create a public post|Write something", re.IGNORECASE)
