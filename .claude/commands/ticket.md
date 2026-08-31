---
description: File a Jira-style ticket in docs/tickets/ from a request
---

File a ticket in `docs/tickets/` for the request below, following the
`ticket-workflow` skill.

Request: $ARGUMENTS

If the request is empty, use what the user asked for earlier in this
conversation.

Create it now with `scripts/ticket.sh new` — the user asked for a ticket, so
this is not the plan-first path where the ticket waits for approval. Fill in
every section, and keep the `## Ask` block as the user's own words, verbatim:
no tidying, no rephrasing into solution language.

Then show the path and the filled-in ticket, and stop. Do not start
implementing it.
