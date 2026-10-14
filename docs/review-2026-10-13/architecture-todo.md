# Architecture follow-ups

The existing monorepo boundaries, shared pure hardware rules, centralized Hono middleware, migration ledger, integer-cent arithmetic and persisted desktop packing queue are useful foundations. The verified defects point mainly to fragmented ownership of invariants and asynchronous work. These tasks consolidate related repairs; they are not additional independently counted bugs and do not require a broad rewrite.

- [ ] **Centralize session and credential validity.** Bind access cookies, OAuth consent/codes, refresh families, bearers and VNC to one explicit session/credential-version model. Make reset/offboarding atomic with redemption and use live role checks where needed. Coordinate SEC-01–03 with FE-01/FE-06 so the browser also invalidates retained data and old responses.

- [ ] **Define one domain transaction/lock protocol.** Document ordering for PO/SO headers, inventory lots, payment groups, client reassignment and manager membership. Move validation of authoritative ownership/state inside that boundary. Share it between HTTP routes, background sync and MCP entrypoints. Apply BD-01–03/05–06/09, SUP-01 and INT-01; keep barrier-controlled tests for the conflicting operations.

- [ ] **Extract a single persisted capture/edit state machine.** Represent line IDs, dirty state, pending writes, failures, retries and finalization explicitly. Own camera/photo/scanner callbacks by a capture epoch and user session. Reuse the desktop queue lessons for mobile instead of maintaining separate informal protocols. Apply FE-02–03/14, UI-06 and the existing frontend structural checklist.

- [ ] **Move packing persistence below HTTP registration.** Implement BD-11 by moving keyed-line identity/read/write/pruning into a service consumed by routers and lifecycle services. Keep route→service→database/shared dependency direction. Introduce a lightweight automated import-boundary check once the cycle is removed.

- [ ] **Separate financial facts, projections and list presentation.** Aggregate historical revenue from durable sale snapshots, retain needed cost/attribution snapshots independently of mutable inventory references, and compute full scoped totals on the server. Expose cursors/truncation explicitly. Clearly label estimated data in the UI. Apply BD-04, SUP-03, FE-09/13/15 and UI-03.

- [ ] **Give external side effects durable lifecycle state.** Use quota reservations, provider registration claims, pending object records and cleanup retries for operations that span SQL and R2/Shippo. Specify outcomes when the provider succeeds but the response/stamp is lost. Apply SEC-05/07–09/15 and INF-03; avoid relying on process-local flags for cross-replica invariants.

- [ ] **Add focused integration gates around the verified boundaries.** Preserve pure-helper coverage while adding rendered session/capture tests, real route-launch handoffs, keyboard modal tests, Worker forwarding tests and deterministic database concurrency cases. Make CI checks prerequisites for deployment (INF-01), add reviewed dependency-audit dispositions (DEP-03), and schedule isolated restore drills (INF-06). Make BD-10 deterministic first so unrelated test noise does not obscure failures.
