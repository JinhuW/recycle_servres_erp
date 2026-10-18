"""One browser identity per Facebook account, kept for the account's life.

Facebook recognises a returning browser by its `datr`/`sb` cookies and by the
fingerprint around them: user agent, screen, timezone, language. A worker used
to build a throwaway browser on every start, so an account's "device" lasted
only as long as one session file on one disk; a rebuilt host, or a login moved
to another worker, read as a brand-new device signing in.

So the device is stored here, keyed by the account (its Facebook uid), and
whichever worker runs the account presents it. The worker is only a slot: the
ERP can hand a slot another login, and the two logins must never share a
device, because that is what links accounts in Facebook's eyes.

`device_id` is our label for the row, written once and never regenerated.
"""

import hashlib
import uuid
from typing import Any, Dict, List, Optional

# A profile's timezone comes from where its worker searches, so the clock the
# browser reports agrees with the proxy's location.
REGION_TIMEZONES = {
    "rs_northeast": "America/New_York",
    "rs_southeast": "America/New_York",
    "rs_midwest": "America/Chicago",
    "rs_south_central": "America/Chicago",
    "rs_mountain": "America/Denver",
    "rs_west": "America/Los_Angeles",
}
DEFAULT_TIMEZONE = "America/New_York"
DEFAULT_LOCALE = "en-US"

# Common desktop screens that fit the worker's 1920x1080 X display, with the
# device scale factor each usually comes with (1536x864 is a 1080p panel at
# 125%).
SCREENS = (
    (1920, 1080, 1.0),
    (1536, 864, 1.25),
    (1440, 900, 1.0),
    (1366, 768, 1.0),
    (1600, 900, 1.0),
    (1280, 800, 1.0),
)
# Height a maximised browser's toolbars and the taskbar take off the screen.
BROWSER_CHROME_HEIGHTS = (111, 123, 133)

# What the monitor has always presented: Playwright's default 1280x720
# viewport and screen, the browser's own locale, the container's UTC clock.
LEGACY_VIEWPORT = (1280, 720)
LEGACY_TIMEZONE = "UTC"

# The cookies that are the device rather than the login.
DEVICE_COOKIES = ("datr", "sb")


def identity_key_for(account: Optional[Dict[str, Any]]) -> Optional[str]:
    """The device-profile key of a vault account, or None if its uid is unknown.

    Only the uid is trusted. A username can be changed or reused by the ERP,
    and a key guessed from the session in the browser could belong to the
    login the slot held before.
    """
    uid = str((account or {}).get("fb_uid") or "").strip()
    return f"uid:{uid}" if uid else None


def generate_profile(fb_uid: str, region: Optional[str]) -> Dict[str, Any]:
    """A new device for an account that has never had one.

    The user agent is left to the browser: a made-up one would disagree with
    the client hints and `navigator.platform` the real browser still sends.
    """
    device_id = str(uuid.uuid4())
    seed = int(hashlib.sha256(device_id.encode()).hexdigest(), 16)
    screen_w, screen_h, scale = SCREENS[seed % len(SCREENS)]
    chrome = BROWSER_CHROME_HEIGHTS[(seed // len(SCREENS)) % len(BROWSER_CHROME_HEIGHTS)]
    return {
        "identity_key": f"uid:{fb_uid}",
        "device_id": device_id,
        "fb_uid": fb_uid,
        "user_agent": None,
        "viewport_w": screen_w,
        "viewport_h": screen_h - chrome,
        "screen_w": screen_w,
        "screen_h": screen_h,
        "device_scale_factor": scale,
        "locale": DEFAULT_LOCALE,
        "timezone_id": REGION_TIMEZONES.get(region or "", DEFAULT_TIMEZONE),
        "source": "generated",
    }


def seeded_profile(fb_uid: str, observed: Dict[str, Any]) -> Dict[str, Any]:
    """A device recorded from what a logged-in worker already presents.

    This is how the workers that predate profiles join without Facebook
    seeing anything change: the profile copies their browser rather than
    replacing it.
    """
    viewport_w = int(observed.get("viewport_w") or LEGACY_VIEWPORT[0])
    viewport_h = int(observed.get("viewport_h") or LEGACY_VIEWPORT[1])
    return {
        "identity_key": f"uid:{fb_uid}",
        "device_id": str(uuid.uuid4()),
        "fb_uid": fb_uid,
        "user_agent": observed.get("user_agent") or None,
        "viewport_w": viewport_w,
        "viewport_h": viewport_h,
        "screen_w": int(observed.get("screen_w") or viewport_w),
        "screen_h": int(observed.get("screen_h") or viewport_h),
        "device_scale_factor": float(observed.get("device_scale_factor") or 1.0),
        "locale": observed.get("locale") or DEFAULT_LOCALE,
        "timezone_id": observed.get("timezone_id") or LEGACY_TIMEZONE,
        "source": "seeded",
    }


def device_cookies_of(storage_state: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The device cookies in a storage_state, as Playwright cookie dicts."""
    return [
        cookie
        for cookie in (storage_state or {}).get("cookies") or []
        if isinstance(cookie, dict)
        and cookie.get("name") in DEVICE_COOKIES
        and "facebook.com" in str(cookie.get("domain") or "")
    ]


def profile_out(profile: Dict[str, Any]) -> Dict[str, Any]:
    """The profile as a worker applies it, built field by field so a column
    added later is not served by accident."""
    return {
        "device_id": profile["device_id"],
        "fb_uid": profile.get("fb_uid"),
        "user_agent": profile.get("user_agent"),
        "viewport": {"width": int(profile["viewport_w"]), "height": int(profile["viewport_h"])},
        "screen": {"width": int(profile["screen_w"]), "height": int(profile["screen_h"])},
        "device_scale_factor": float(profile["device_scale_factor"]),
        "locale": profile["locale"],
        "timezone_id": profile["timezone_id"],
        "source": profile.get("source"),
        "created_at": profile.get("created_at"),
    }
