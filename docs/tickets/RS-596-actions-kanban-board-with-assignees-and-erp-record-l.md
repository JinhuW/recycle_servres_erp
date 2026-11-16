---
id: RS-596
title: Actions kanban board with assignees and ERP record links
type: story
status: in-progress
priority: P2
created: 2026-11-16
reporter: jinhu
branch: feat/actions-api
pr:
version:
related: [RS-597]
---

## Ask

> Pls create an kanban board in the ERP system for tracking actions.
>
> it should be able to assign to all employee.
>
> pls create an feature plan

> pls make sure it integrate with our system infomation

## Context

Nothing in the ERP tracks action items today: follow-ups live in people's
heads, Telegram, and per-record notes (`supplier_notes`, after-sales `note`
events). The closest shapes in the code are after-sales cases
(`routes/afterSales.ts`, migration `0175`: status workflow, `assignee_id`,
event timeline) and the read-only Reddit leads board
(`pages/desktop/LeadsReddit.tsx`). Users are `manager` or `purchaser`;
`GET /api/members/names` already lists every active user for any role.

Owner decisions taken while planning:

- Any active user can be assigned, and anyone can create and assign.
- One shared board; every employee sees every card.
- Fixed columns: To do, In progress, Blocked, Done. Done cards leave the
  board 14 days after completion and stay reachable in an archive view.
- "Integrate with our system information" = a card links to one ERP record
  (purchase order, sell order, after-sales case, client, web submission,
  inventory lot) and shows its number and live status; each of those record
  pages gets an Actions panel; Home gets "My actions"; the sidebar gets a
  count.
- Phone: a "My actions" list on Home (open, move, comment, create), no drag.

## Acceptance criteria

- [ ] `action_items` and `action_item_events` tables exist (migration
      `0249`); ids are `TK-n`.
- [ ] `/api/actions` lets any signed-in user create, edit, move, comment on
      and assign a card; the assignee must be an active user.
- [ ] Removing a card is soft and allowed to its creator or a manager only.
- [ ] Moving a card renumbers its column in one transaction; two people
      moving cards at the same time never get a server error.
- [ ] A card links to at most one record of the six types; the board shows
      the record's number and live status.
- [ ] A purchaser sees a linked record's status and a link only where they can
      open that record today (own POs, own clients); otherwise the number
      only, and a client shows as "Client" with no name.
- [ ] A card keeps a readable label after its linked record is deleted.
- [ ] Assigning a card to someone else writes an in-app notification for them.
- [ ] Desktop Actions page with drag-and-drop between columns (mouse and
      iPad), a "Move to" control, card drawer with comments, archive view,
      filters All / Mine / person.
- [ ] Sidebar count of my open cards; "My actions" on desktop and phone Home.
- [ ] Actions panel on PO, sell order, after-sales case, client, web
      submission and inventory lot pages; a card can be created there.
- [ ] Strings in English and Chinese.

## Out of scope

- Cards created automatically from ERP events (new web submission, package
  delivered, PO ready to pay, ...). Possible later.
- Columns editable by managers.
- Drag-and-drop on the phone.
- MCP tools for actions; the manager activity feed.
- Per-user Telegram or email alerts (the ERP has no per-user channel).

## Notes

- Plan: five PRs to `dev` (API; desktop board; PO board RS-597; record
  panels + Home; phone).
- Card titles and comments are free text on a shared board: anything typed
  there is visible to every employee, whatever the linked record's access.
- The desktop shell has no notification bell, so desktop users see new work
  through the sidebar count and Home.
