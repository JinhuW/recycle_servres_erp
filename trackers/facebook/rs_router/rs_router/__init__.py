"""rs-router: the mautrix-meta ↔ coordinator bridge.

mautrix-meta puts every Marketplace buyer in their own Matrix room; this worker
reads those rooms and reports each conversation to the coordinator (which fans
it out to a Telegram forum topic), then delivers the replies staff queue back
into the right room — where mautrix-meta sends them on over Messenger.

It never touches Facebook. Like the coordinator's other workers, all it does is
carry structured messages between two APIs.
"""

__version__ = "0.1.0"
