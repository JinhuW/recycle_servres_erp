"""rs-fleetd: the host agent that keeps one Docker host's Facebook workers.

The coordinator decides which workers run where and on which image; this agent
makes one host match. It is deliberately the dumb half: it fetches the desired
state, keeps a copy on disk, and turns the difference between that and the
containers it sees into `docker` commands.

Its one rule is to fail static. Blind — the coordinator down, the network gone
— it keeps every worker it last knew about running and changes nothing else,
so a control-plane outage never stops a search. It never deletes a worker's
`/data`, where the Facebook session lives.
"""

__version__ = "0.13.5"
