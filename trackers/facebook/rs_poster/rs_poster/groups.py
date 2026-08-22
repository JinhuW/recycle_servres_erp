"""Share a published buy ad into local buy/sell groups.

Groups are where want-to-buy posts actually belong on Facebook, so this is
often more effective than the Marketplace listing itself. It is also the
fastest way to get an account flagged, hence the hard daily cap.
"""

import logging
from typing import TYPE_CHECKING, List

from playwright.sync_api import Page

from . import selectors as sel
from .session import (
    NAV_TIMEOUT_MS,
    AccountRestrictedError,
    human_pause,
    raise_if_restricted,
)
from .state import PosterState

if TYPE_CHECKING:
    from .poster import Poster

logger = logging.getLogger(__name__)


class GroupSharer:
    def __init__(self: "GroupSharer", poster: "Poster") -> None:
        self.poster = poster

    @property
    def page(self: "GroupSharer") -> Page:
        return self.poster.page

    @property
    def state(self: "GroupSharer") -> PosterState:
        return self.poster.state

    def share(self: "GroupSharer", listing_title: str, group_name: str, message: str) -> bool:
        if not self.state.can_share_to_group():
            logger.warning(
                "Daily group-share limit reached (%d); skipping '%s'.",
                self.state.pacing.max_group_shares_per_day,
                group_name,
            )
            return False

        if self.poster.dry_run:
            logger.info("Dry run: would share '%s' to group '%s'.", listing_title[:40], group_name)
            return False

        self.poster._paced(f"share to {group_name}")
        logger.info("Sharing '%s' to group '%s'", listing_title[:40], group_name)

        try:
            self.page.goto(sel.YOUR_LISTINGS_URL, timeout=NAV_TIMEOUT_MS)
            self.page.wait_for_load_state("domcontentloaded")
            raise_if_restricted(self.page, f"sharing to '{group_name}'")
            human_pause(2.0, 4.0)

            self.page.get_by_text(listing_title[:60], exact=False).first.click()
            human_pause(1.0, 2.0)

            self.page.get_by_role("button", name=sel.SHARE_BUTTON_RE).first.click()
            human_pause(1.0, 2.0)
            self.page.get_by_text(sel.SHARE_TO_GROUP_RE).first.click()
            human_pause(1.0, 2.0)

            search = self.page.locator(sel.GROUP_SEARCH_INPUT).first
            search.click()
            # Facebook truncates long group names in the picker.
            search.type(group_name[:51], delay=60)
            self.page.wait_for_timeout(3000)
            self.page.get_by_text(group_name[:51], exact=False).first.click()
            human_pause(1.0, 2.0)

            composer = self.page.get_by_label(sel.COMPOSER_RE).first
            composer.click()
            composer.type(message, delay=15)
            human_pause(1.0, 2.0)

            self.page.get_by_role("button", name=sel.POST_BUTTON_RE).first.click()
            self.page.wait_for_timeout(6000)
        except AccountRestrictedError:
            # A restriction ends the run; retrying other groups digs deeper.
            raise
        except Exception as e:
            logger.warning("Group share to '%s' failed: %s", group_name, e)
            self.poster._screenshot("group-share-failed")
            return False

        self.state.record_share()
        self.state.record_action()
        self.state.save()
        return True

    def share_all(
        self: "GroupSharer", listing_title: str, groups: List[str], message: str
    ) -> int:
        shared = 0
        for group in groups:
            if not self.state.can_share_to_group():
                logger.info("Stopping group shares: daily limit reached.")
                break
            if self.share(listing_title, group, message):
                shared += 1
        return shared
