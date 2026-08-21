"""Browser session for the poster.

Shares the storage_state file the monitor writes, so a node logs into Facebook
once and both the monitor and the poster reuse that session. A lock file keeps
the two from driving the same account at the same time, which is both a
detection risk and a source of racey page state.
"""

import logging
import os
import random
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

from . import selectors as sel
from . import totp
from .cookies import read_session_meta, write_session_meta

logger = logging.getLogger(__name__)


class SessionLockedError(RuntimeError):
    """Another process holds the account lock."""


@contextmanager
def account_lock(lock_path: str | Path, timeout: int = 0) -> Iterator[None]:
    """Cooperative lock so the monitor and poster never share an account session."""
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            if time.time() >= deadline:
                raise SessionLockedError(
                    f"{lock_path} is held by another process. The monitor may be "
                    "running; stop it or wait before posting."
                ) from None
            time.sleep(5)
    try:
        yield
    finally:
        lock_path.unlink(missing_ok=True)


def human_pause(low: float = 0.8, high: float = 2.5) -> None:
    """Small randomized delay between UI actions."""
    time.sleep(random.uniform(low, high))


class SessionExpiredError(RuntimeError):
    """The stored session no longer authenticates and cannot be renewed here."""


class PosterSession:
    """A logged-in Facebook page, restored from a saved session.

    Cookies are the primary credential: the session file produced by
    `rs-session` is normally all this needs. Username/password are an optional
    fallback for nodes that still carry them, and are never required.
    """

    def __init__(
        self: "PosterSession",
        storage_state_path: str = "/data/fb_state.json",
        username: str | None = None,
        password: str | None = None,
        totp_secret: str | None = None,
        headless: bool = False,
        login_wait_time: int = 120,
        proxy: str | None = None,
    ) -> None:
        self.storage_state_path = os.path.expanduser(storage_state_path)
        self.username = username or os.environ.get("FB_USERNAME")
        self.password = password or os.environ.get("FB_PASSWORD")
        # Resolved lazily, per session file, by rs_poster.totp — a malformed
        # secret should surface when 2FA is actually reached, not stop a worker
        # whose stored session is still perfectly valid.
        self.totp_secret = totp_secret
        # Headless browsers are easier for Facebook to fingerprint; the Docker
        # image runs a real Chromium under Xvfb instead.
        self.headless = headless
        self.login_wait_time = login_wait_time
        self.proxy = proxy or os.environ.get("FB_PROXY")

        self._playwright = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None

    def __enter__(self: "PosterSession") -> "PosterSession":
        self.start()
        return self

    def __exit__(self: "PosterSession", *exc_info: object) -> None:
        self.close()

    def start(self: "PosterSession") -> Page:
        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(
            headless=self.headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        has_state = os.path.exists(self.storage_state_path)
        # Present the same browser identity and network the session was created
        # with; Facebook treats a session that moves between them as suspect.
        meta = read_session_meta(self.storage_state_path)
        self._context = self._browser.new_context(
            storage_state=self.storage_state_path if has_state else None,
            proxy={"server": self.proxy or meta.get("proxy")}
            if (self.proxy or meta.get("proxy"))
            else None,
            user_agent=meta.get("user_agent"),
            viewport={"width": 1440, "height": 900},
        )
        self.page = self._context.new_page()
        self.login()
        return self.page

    def close(self: "PosterSession") -> None:
        try:
            self.save_state()
        finally:
            for resource in (self._context, self._browser):
                try:
                    if resource is not None:
                        resource.close()
                except Exception:
                    pass
            if self._playwright is not None:
                self._playwright.stop()

    def save_state(self: "PosterSession") -> None:
        if self._context is None:
            return
        try:
            Path(self.storage_state_path).parent.mkdir(parents=True, exist_ok=True)
            # indexed_db=True: Facebook keeps device state in IndexedDB as well
            # as cookies, and Playwright drops it unless asked.
            self._context.storage_state(path=self.storage_state_path, indexed_db=True)
            # Keep the sidecar in step, so a session created here is reusable
            # under the same identity next time.
            user_agent = None
            if self.page is not None:
                try:
                    user_agent = self.page.evaluate("() => navigator.userAgent")
                except Exception:
                    user_agent = None
            write_session_meta(
                self.storage_state_path, user_agent=user_agent, proxy=self.proxy
            )
            logger.debug("Session saved to %s", self.storage_state_path)
        except Exception as e:
            logger.warning("Could not save session: %s", e)

    # URL fragments that mean login is unfinished (login form, 2FA, captcha,
    # checkpoint). Several carry no email field, so the form test alone treats
    # them as logged in — live testing hit a captcha wall misread that way.
    _INTERSTITIAL_URL_MARKERS = (
        "/login",
        "/checkpoint",
        "two_step_verification",
        "two_factor",
        "/recover",
    )

    def is_logged_in(self: "PosterSession") -> bool:
        assert self.page is not None
        try:
            if any(m in self.page.url for m in self._INTERSTITIAL_URL_MARKERS):
                return False
            # A completed session carries the `xs` cookie; its presence is the
            # reliable signal, not the absence of the login form.
            return any(c.get("name") == "xs" for c in self.page.context.cookies())
        except Exception:
            return False

    def login(self: "PosterSession") -> None:
        assert self.page is not None
        # Land on Marketplace rather than the login page: with a valid session
        # this never renders a login form at all.
        self.page.goto(sel.MARKETPLACE_URL, timeout=0)
        self.page.wait_for_load_state("domcontentloaded")
        self._accept_cookies()

        if self.is_logged_in():
            logger.info("Session restored from %s; no login needed.", self.storage_state_path)
            return

        if not (self.username and self.password):
            raise SessionExpiredError(
                f"The session at {self.storage_state_path} is not authenticated, and no "
                "password fallback is configured (which is the intended setup).\n"
                "Refresh it without a password:\n"
                f"  rs-session capture --storage-state {self.storage_state_path}\n"
                "or, from cookies exported in a browser where you are logged in:\n"
                f"  rs-session import --cookies cookies.txt "
                f"--storage-state {self.storage_state_path}"
            )

        logger.warning(
            "Session invalid; falling back to password login. Prefer refreshing the "
            "session with `rs-session` — password logins are what trigger checkpoints."
        )
        self.page.goto(sel.LOGIN_URL, timeout=0)
        self.page.wait_for_load_state("domcontentloaded")
        logger.info("Logging in as %s", self.username)
        self.page.fill(sel.LOGIN_EMAIL_INPUT, "")
        self.page.type(sel.LOGIN_EMAIL_INPUT, self.username, delay=200)
        human_pause()
        self.page.type(sel.LOGIN_PASSWORD_INPUT, self.password, delay=200)
        human_pause()
        self.page.keyboard.press("Enter")
        self.page.wait_for_timeout(5000)

        self._handle_two_factor()

        if not self.is_logged_in() and self.login_wait_time > 0:
            logger.warning(
                "Login incomplete — waiting %ss for manual completion (use noVNC).",
                self.login_wait_time,
            )
            self.page.wait_for_timeout(self.login_wait_time * 1000)

        if not self.is_logged_in():
            raise SessionExpiredError(
                "Facebook login failed. If the account hit a checkpoint, clear it in a "
                "normal browser, then re-run `rs-session capture`."
            )

        self.save_state()

    def _accept_cookies(self: "PosterSession") -> None:
        assert self.page is not None
        try:
            button = self.page.get_by_role("button", name=sel.COOKIE_ACCEPT_RE)
            if button.is_visible(timeout=5000):
                button.click()
                self.page.wait_for_timeout(2000)
        except Exception:
            pass

    def _handle_two_factor(self: "PosterSession") -> bool:
        assert self.page is not None

        try:
            config = totp.resolve(self.storage_state_path, self.totp_secret)
        except totp.TotpError as e:
            logger.error(
                "2FA secret for %s is unusable: %s", self.storage_state_path, e
            )
            return False
        if config is None:
            return False

        code_input = self.page.locator(sel.TWO_FACTOR_INPUT).first
        try:
            code_input.wait_for(timeout=15000)
        except Exception:
            return False

        # Facebook rejects a code that was already consumed, and one typed in
        # the last seconds of its window can expire in flight. Both are fixed by
        # waiting out the window and sending the next code, so try twice.
        for attempt in range(2):
            if totp.seconds_remaining(config) <= 3:
                time.sleep(totp.seconds_remaining(config) + 1)

            code = totp.generate(config)
            try:
                code_input.fill("")
            except Exception:
                pass
            code_input.type(code, delay=150)
            self.page.keyboard.press("Enter")
            self.page.wait_for_timeout(8000)
            logger.info("2FA code submitted (attempt %d).", attempt + 1)

            if self.page.locator(sel.TWO_FACTOR_INPUT).count() == 0:
                break
            if attempt == 0:
                logger.warning(
                    "Still on the 2FA prompt; waiting for the next code window."
                )
                time.sleep(totp.seconds_remaining(config) + 1)

        try:
            trust = self.page.get_by_role("button", name=sel.TRUST_DEVICE_RE).first
            if trust.is_visible(timeout=5000):
                trust.click()
                self.page.wait_for_timeout(5000)
        except Exception:
            pass
        return True
