"""Create, delete, and renew buy ads on Facebook Marketplace.

Facebook has no want-to-buy listing type, so a buy ad is an ordinary item
listing whose copy makes clear we are buying. "Renewal" is delete-then-repost,
which is the only way to get a listing back to the top of the feed.

Every method that touches Facebook goes through `_paced`, so the safety limits
in ads.toml cannot be bypassed by calling a method directly.
"""

import logging
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from playwright.sync_api import Page

from . import selectors as sel
from .photo_library import PhotoLibrary
from .session import NAV_TIMEOUT_MS, PosterSession, human_pause, raise_if_restricted
from .state import AdRecord, PosterState, utcnow

logger = logging.getLogger(__name__)


class PostingError(RuntimeError):
    pass


@dataclass
class AdTemplate:
    name: str
    title: str
    description: str
    price: int
    category: str
    condition: str
    photo_set: str
    cities: List[str]
    renew_days: int = 7
    groups: List[str] = None  # type: ignore[assignment]

    def __post_init__(self: "AdTemplate") -> None:
        if self.groups is None:
            self.groups = []

    @classmethod
    def from_config(cls: type["AdTemplate"], name: str, config: Dict[str, Any]) -> "AdTemplate":
        missing = [
            field
            for field in ("title", "description", "price", "photo_set", "cities")
            if field not in config
        ]
        if missing:
            raise PostingError(f"Ad '{name}' is missing required fields: {', '.join(missing)}")
        return cls(
            name=name,
            title=config["title"],
            description=config["description"],
            price=config["price"],
            category=config.get("category", "Electronics"),
            condition=config.get("condition", "Used - Good"),
            photo_set=config["photo_set"],
            cities=config["cities"],
            renew_days=config.get("renew_days", 7),
            groups=config.get("groups", []),
        )


class Poster:
    def __init__(
        self: "Poster",
        session: PosterSession,
        library: PhotoLibrary,
        state: PosterState,
        dry_run: bool = False,
        screenshot_dir: str | Path | None = None,
    ) -> None:
        self.session = session
        self.library = library
        self.state = state
        self.dry_run = dry_run
        # Failure evidence must land somewhere findable, not wherever cwd
        # happened to be; the ads dir is the one place every run shares.
        self.screenshot_dir = (
            Path(screenshot_dir) if screenshot_dir else library.root / "screenshots"
        )

    @property
    def page(self: "Poster") -> Page:
        if self.session.page is None:
            raise PostingError("Session is not started.")
        return self.session.page

    def _paced(self: "Poster", label: str) -> None:
        """Block until the account is allowed to act again."""
        wait = self.state.seconds_until_next_action()
        if wait > 0:
            logger.info("Pacing %s: waiting %.0fs before acting again.", label, wait)
            time.sleep(wait)
        # A little extra jitter so actions never land on an exact cadence.
        human_pause(2.0, 6.0)

    def _screenshot(self: "Poster", name: str) -> Path:
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        path = self.screenshot_dir / f"{name}-{int(time.time())}.png"
        self.page.screenshot(path=str(path), full_page=True)
        logger.info("Screenshot: %s", path)
        return path

    # -- form helpers ------------------------------------------------------

    def _fill_labeled(self: "Poster", label: Any, value: str, label_text: str) -> None:
        """Fill a field by its visible label, falling back to a sibling-input XPath."""
        try:
            field = self.page.get_by_label(label).first
            field.wait_for(timeout=8000)
            field.click()
            field.type(str(value), delay=random.randint(20, 60))
            return
        except Exception:
            logger.debug("get_by_label failed for %s; trying sibling XPath", label_text)

        try:
            xpath = sel.LABEL_SIBLING_INPUT.format(label=label_text)
            field = self.page.locator(f"xpath={xpath}").first
            field.wait_for(timeout=8000)
            field.click()
            field.type(str(value), delay=random.randint(20, 60))
        except Exception as e:
            raise PostingError(f"Could not fill the '{label_text}' field: {e}") from e

    def _select_option(self: "Poster", label: Any, value: str, label_text: str) -> None:
        """Open a dropdown and pick an option by exact visible text."""
        try:
            self.page.get_by_label(label).first.click()
            human_pause(0.5, 1.2)
            option = self.page.locator(sel.DIALOG_OPTION).filter(has_text=value).first
            option.wait_for(timeout=8000)
            option.click()
            human_pause(0.5, 1.2)
        except Exception as e:
            raise PostingError(
                f"Could not select '{value}' for '{label_text}'. Facebook's option list may "
                f"have changed; check rs_poster/selectors.py. ({e})"
            ) from e

    def _set_location(self: "Poster", city: str) -> None:
        """Type a city and accept the first suggestion.

        Facebook's autocomplete is loose, so a bad city string silently posts to
        the wrong metro. We verify the chosen suggestion shares the city name.
        """
        try:
            field = self.page.get_by_label(sel.LOCATION_LABEL).first
            field.click()
            field.fill("")
            field.type(city, delay=80)
            human_pause(1.5, 2.5)
            option = self.page.locator(sel.DIALOG_OPTION).first
            option.wait_for(timeout=8000)
            chosen = (option.inner_text() or "").strip()
            city_name = city.split(",")[0].strip().lower()
            if city_name and city_name not in chosen.lower():
                raise PostingError(
                    f"Location autocomplete offered '{chosen}' for '{city}'. Refusing to "
                    "post to the wrong city."
                )
            option.click()
            human_pause()
        except PostingError:
            raise
        except Exception as e:
            raise PostingError(f"Could not set location to '{city}': {e}") from e

    # -- actions -----------------------------------------------------------

    def create_listing(self: "Poster", ad: AdTemplate, city: str) -> Optional[AdRecord]:
        if not self.state.can_create_ad():
            logger.warning(
                "Refusing to create '%s' in %s: %d active ads already (limit %d).",
                ad.name,
                city,
                len(self.state.active_ads()),
                self.state.pacing.max_active_ads,
            )
            return None

        photos = self.library.resolve(ad.photo_set)
        self._paced(f"create {ad.name}@{city}")

        logger.info("Creating '%s' in %s (%d photos)", ad.name, city, len(photos))
        self.page.goto(sel.CREATE_ITEM_URL, timeout=NAV_TIMEOUT_MS)
        self.page.wait_for_load_state("domcontentloaded")
        raise_if_restricted(self.page, f"opening the create form for {ad.name}@{city}")
        human_pause(2.0, 4.0)

        self.page.set_input_files(sel.PHOTO_INPUT, photos)
        # Uploads need to settle before the rest of the form accepts input.
        self.page.wait_for_timeout(5000)

        self._fill_labeled(sel.TITLE_LABEL, ad.title, "Title")
        human_pause()
        self._fill_labeled(sel.PRICE_LABEL, str(ad.price), "Price")
        human_pause()
        self._select_option(sel.CATEGORY_LABEL, ad.category, "Category")
        self._select_option(sel.CONDITION_LABEL, ad.condition, "Condition")
        self._fill_labeled(sel.DESCRIPTION_LABEL, ad.description, "Description")
        human_pause()
        self._set_location(city)

        if self.dry_run:
            self._screenshot(f"dryrun-{ad.name}-{city.replace(', ', '-')}")
            logger.info("Dry run: form filled, not publishing.")
            return None

        try:
            self._publish()
        finally:
            # The Publish click went to Facebook whether or not the
            # confirmation was seen, so it counts against pacing either way —
            # otherwise a crash-loop retries the account with no backoff.
            self.state.record_action()
            self.state.save()

        record = AdRecord(
            ad_name=ad.name,
            city=city,
            title=ad.title,
            created_at=utcnow().isoformat(timespec="seconds"),
            last_renewed_at=utcnow().isoformat(timespec="seconds"),
            renew_days=ad.renew_days,
            active=True,
        )
        self.state.upsert(record)
        self.state.save()
        logger.info("Published '%s' in %s", ad.name, city)
        return record

    def _publish(self: "Poster") -> None:
        # Some cities route through a second "Next" step before Publish.
        try:
            next_button = self.page.get_by_role("button", name=sel.NEXT_BUTTON_RE).first
            next_button.wait_for(state="visible", timeout=4000)
            next_button.click()
            self.page.wait_for_timeout(3000)
        except Exception:
            pass

        try:
            publish = self.page.locator(sel.PUBLISH_ENABLED).first
            publish.wait_for(timeout=20000)
            publish.click()
        except Exception:
            try:
                self.page.get_by_role("button", name=sel.PUBLISH_BUTTON_RE).first.click()
            except Exception as e:
                self._screenshot("publish-failed")
                raise PostingError(f"Could not click Publish: {e}") from e

        # The create form's heading disappears once the listing is live. A
        # missed confirmation is a hard failure: returning success here used to
        # write an active ledger record for a listing that may not exist, which
        # the next renew would then try to delete (or skip forever).
        try:
            self.page.get_by_role("heading", name=sel.CREATE_FORM_HEADING_RE).first.wait_for(
                state="detached", timeout=60000
            )
        except Exception as e:
            evidence = self._screenshot("publish-unconfirmed")
            raise PostingError(
                f"Publish was clicked but the create form never closed; the "
                f"listing may or may not exist. Check {evidence} and the "
                f"listings page before retrying. ({e})"
            ) from e

        self.page.wait_for_timeout(3000)

    def delete_listing(self: "Poster", title: str, city: str | None = None) -> bool:
        self._paced(f"delete '{title[:40]}'")
        logger.info("Deleting listing titled '%s' (%s)", title[:60], city or "any city")

        self.page.goto(sel.YOUR_LISTINGS_URL, timeout=NAV_TIMEOUT_MS)
        self.page.wait_for_load_state("domcontentloaded")
        raise_if_restricted(self.page, f"opening your listings to delete '{title[:40]}'")
        human_pause(2.0, 4.0)

        try:
            search = self.page.locator(sel.LISTING_SEARCH_INPUT).first
            search.wait_for(timeout=15000)
            search.click()
            search.type(title[:60], delay=50)
            self.page.wait_for_timeout(4000)
        except Exception as e:
            logger.warning("Could not search your listings: %s", e)
            return False

        try:
            target = self._matching_listing(title, city)
            if target is None:
                self._screenshot("delete-ambiguous")
                return False
            target.click()
            human_pause(1.0, 2.0)
            self.page.locator(sel.DELETE_BUTTON).first.click()
            human_pause(1.0, 2.0)
            self.page.get_by_role("button", name=sel.CONFIRM_DELETE_RE).first.click()
            self.page.wait_for_timeout(5000)
        except Exception as e:
            logger.warning("Delete failed for '%s': %s", title[:60], e)
            self._screenshot("delete-failed")
            return False

        self.state.record_action()
        self.state.save()
        return True

    def _matching_listing(self: "Poster", title: str, city: str | None) -> Optional[Any]:
        """The one search result that is this ad in this city, or None.

        The same ad carries the same title in every city, so clicking the first
        title match can delete a different city's listing — a silent mix-up the
        location guard in _set_location exists to prevent on the posting side.
        Each result card shows the listing's city, so verify against the card's
        own text and refuse rather than guess.
        """
        matches = self.page.get_by_text(title[:60], exact=False)
        count = matches.count()
        if count == 0:
            logger.warning("No listing found titled '%s'.", title[:60])
            return None
        if city is None:
            if count > 1:
                logger.warning(
                    "%d listings share the title '%s' and no city was given; "
                    "refusing to guess which to delete.",
                    count,
                    title[:60],
                )
                return None
            return matches.first

        city_part = city.split(",")[0].strip().lower()
        verified = []
        for index in range(min(count, 8)):
            candidate = matches.nth(index)
            try:
                # The clickable card is the enclosing link; its text carries
                # both the title and the listing's city.
                card = candidate.locator("xpath=ancestor-or-self::a[1]").first
                card_text = (card.inner_text() or "").lower()
            except Exception:
                continue
            if city_part in card_text:
                verified.append(card)
        if len(verified) != 1:
            logger.warning(
                "Could not single out '%s' in %s: %d title matches, %d with the "
                "city on the card. Refusing to delete the wrong listing.",
                title[:60],
                city,
                count,
                len(verified),
            )
            return None
        return verified[0]

    def renew(self: "Poster", ad: AdTemplate, city: str) -> Optional[AdRecord]:
        """Delete then repost, which is the only way to bump a listing.

        If the delete fails we stop rather than post a duplicate.
        """
        record = self.state.get(ad.name, city)
        if record is None:
            logger.info("No existing record for %s@%s; creating instead.", ad.name, city)
            return self.create_listing(ad, city)

        if not self.delete_listing(record.title, record.city):
            logger.warning(
                "Could not delete '%s' in %s; skipping repost to avoid a duplicate listing.",
                ad.name,
                city,
            )
            return None

        self.state.mark_inactive(ad.name, city)
        self.state.save()
        return self.create_listing(ad, city)
