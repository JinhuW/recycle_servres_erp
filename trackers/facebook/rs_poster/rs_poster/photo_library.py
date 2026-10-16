"""Photo library for buy ads.

Photos live in ads/photos/ and are grouped into named sets by ads/manifest.toml.
An ad template references a set by name, so swapping the imagery for every city
is a one-line edit.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib  # type: ignore

# Facebook accepts up to 10 photos per listing.
MAX_PHOTOS = 10
VALID_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}


class PhotoLibraryError(RuntimeError):
    pass


@dataclass
class PhotoSet:
    name: str
    files: List[Path]

    def __len__(self: "PhotoSet") -> int:
        return len(self.files)


class PhotoLibrary:
    def __init__(self: "PhotoLibrary", root: str | Path) -> None:
        self.root = Path(root)
        self.photos_dir = self.root / "photos"
        self.manifest_path = self.root / "manifest.toml"
        self._sets: Dict[str, PhotoSet] = {}
        self._load()

    def _load(self: "PhotoLibrary") -> None:
        if not self.manifest_path.exists():
            raise PhotoLibraryError(f"No photo manifest at {self.manifest_path}")

        with open(self.manifest_path, "rb") as handle:
            manifest = tomllib.load(handle)

        for name, spec in manifest.get("photo_set", {}).items():
            files = [self.photos_dir / filename for filename in spec.get("files", [])]
            self._sets[name] = PhotoSet(name=name, files=files)

    def get(self: "PhotoLibrary", name: str) -> PhotoSet:
        if name not in self._sets:
            raise PhotoLibraryError(
                f"Photo set '{name}' is not in {self.manifest_path}. "
                f"Known sets: {', '.join(sorted(self._sets)) or 'none'}"
            )
        return self._sets[name]

    def resolve(self: "PhotoLibrary", name: str) -> List[str]:
        """Return existing photo paths for a set, validated and capped."""
        photo_set = self.get(name)
        if not photo_set.files:
            raise PhotoLibraryError(f"Photo set '{name}' lists no files.")

        missing = [str(path) for path in photo_set.files if not path.exists()]
        if missing:
            raise PhotoLibraryError(
                f"Photo set '{name}' references missing files: {', '.join(missing)}"
            )

        bad_type = [
            str(path) for path in photo_set.files if path.suffix.lower() not in VALID_SUFFIXES
        ]
        if bad_type:
            raise PhotoLibraryError(
                f"Photo set '{name}' has unsupported file types: {', '.join(bad_type)}"
            )

        return [str(path) for path in photo_set.files[:MAX_PHOTOS]]

    def validate_all(self: "PhotoLibrary") -> Dict[str, str]:
        """Check every set; return {set_name: error} for the broken ones."""
        problems: Dict[str, str] = {}
        for name in self._sets:
            try:
                self.resolve(name)
            except PhotoLibraryError as e:
                problems[name] = str(e)
        return problems

    @property
    def set_names(self: "PhotoLibrary") -> List[str]:
        return sorted(self._sets)
