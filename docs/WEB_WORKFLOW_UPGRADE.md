# Web workflow upgrade

This checklist tracks the complete requested design/manager audit. A checked item requires implementation and relevant validation; sample rendering is not authenticated end-to-end verification.

## P0 — readability and shared controls
- [x] Actual header mode controls: narrow/wide, light/dark, no clipped labels (30 isolated real-component render cases; authenticated page pending)
- [ ] Consistent control sizing, focus visibility, text contrast and long content
- [ ] Explicit sidebar expand/pin action usable with touch and keyboard
- [x] ConfirmDialog focus containment, busy Escape behavior and focus return (DOM behavior test; other sheets still pending)
- [ ] Screen-specific density (tables/lists/forms rather than stretched cards)

## P1 — daily workflows
- [ ] Members: comparison columns, expiring/low balance/inactive filters, saved filters, preserve context
- [ ] Classes: day/week/month views and readable time/room/trainer/capacity
- [ ] Classes: conflict detection and explicit recurring-edit scope
- [ ] Inquiries: search/filter, per-thread drafts, composition-safe send, templates
- [ ] Inquiries: shared assignment/status/internal notes with authorized persistence
- [ ] Inquiries: member context with permission checks

## P2 — correctness
- [ ] Shared current center and matching navigation permissions
- [ ] Center changes: stale responses, selected targets and unsaved forms
- [ ] Bulk messaging: selected vs eligible/excluded targets, explicit scope
- [ ] Messaging: cost preview and per-recipient delivery/retry reporting
- [ ] Save/error/permission states preserve input and prevent duplicate submission

## P3 — action dashboard and notifications
- [ ] Actionable dashboard linking to filtered work queues
- [ ] Notifications: category/search/unread, explicit read operations
- [ ] Notifications: bulk selection, partial failure handling and readable actions

## P4 — sales and productivity
- [ ] Sales: filters, aligned transactions, consistent export scope
- [ ] Sales: defined gross/refund/net/unpaid metrics and period comparison
- [ ] Saved views/favorites and useful keyboard interactions

## P5 — verification and delivery
- [ ] Mobile/tablet/desktop and zoom checks with realistic long/empty data
- [ ] Authenticated role and multi-center workflow verification
- [ ] Unit/build and relevant behavior checks
- [ ] Reviewable PR, production deployment only with applicable authorization

Existing PR #154 is open; its compact mode-switch changes are included in this branch. Do not report it as deployed.

## Follow-up checkpoint

- Added inquiry workflow SQL and panel: status, active-center assignee, internal append-only notes, optimistic version checking, permission-checked member links, reopen on member reply. Tables are RPC-only; member-visible policies are unchanged. **Not applied or integration-tested against a database.** `NEXT_PUBLIC_INQUIRY_WORKFLOW_ENABLED` defaults off; keep it off until development role-isolation/concurrency tests pass and migration is approved for production.
- Inquiry reply drafts persist in account-scoped session storage for 24 hours and clear on sign-out. Storage failure is surfaced. This is not cross-device/server draft persistence.
- Explicit dirty-state navigation/reload guards cover inquiry/workflow and operating settings; programmatic browser/native back and all remaining sheets are not yet covered.
- Alimtalk estimate uses the existing configured center unit price for approved-template sends only. SMS pricing is unknown and shown as unavailable; the estimate is not a final bill or delivery receipt.
- Remote main has advanced through PR #153; preserve coupon-eligibility and native QA changes during integration. PR #155 is separate Android work and must not be merged as part of this request.
- Production blockers: no configured development DB/test credentials in this checkout, no executed new SQL/RLS integration tests, and remaining all-screen workflow audit items below. A branch/preview push is not completion of production rollout.

## Implementation checkpoint — 2026-09-19

Implemented, with full authenticated verification still pending:

- Shared selected-center preference on 25 manager pages; navigation uses that center's permissions. Saved IDs are validated against the page's authorized center list, not treated as authorization.
- Manager/operator sidebar explicit pin control for touch/keyboard; existing hover expansion remains.
- Members: 7-day expiration, 0–2 remaining, 30-day/no-attendance queues; saved queue preference; desktop comparison columns; visible-result selection/export; query-limit warning; separate checkbox/name/detail controls.
- Classes: day/week/month selection, adjacent-month coverage for weekly views, date-boundary tests, room/trainer/capacity context, keyboard-accessible detail action, latest-request-wins loading. Explicit single/group radio selection and pre-save group/conflict confirmation; existing server update scope retained. All-occurrence conflict and atomicity verification remain pending.
- Inquiries: search/unread filter, in-memory per-thread draft retention, IME-safe Enter, submission lock, preset reply insertion. Drafts do not yet survive leaving the page.
- Notifications: search/category/unread, explicit read operations, selected read/delete, partial-delete failure retention, refreshed navigation badge. Search scope is explicitly latest 100 records, not full history.
- Messaging: candidate/excluded counts and channel confirmation, duplicate-send guard, per-recipient result including uncertain transport outcomes, no automatic retry, retained content on failures. Delivery acceptance is not final delivery. Exact costs are deliberately not invented.
- Dashboard links to actionable member work queues, without invented task counts.
- Sales search/status filters and matching CSV scope; optional previous equal-duration comparison; metric definitions and "registered expense deduction" wording instead of implying accounting net profit. Existing accounting/payment/RLS operations were not changed.

Validation checkpoint: 454 unit tests passing (including actual ConfirmDialog keyboard behavior and InquiryChat IME/double-send behavior); Next production build passing (78 routes, dummy build-only environment); isolated Chromium header rendering across 390/600/768/1024/1440 and two themes (30 cases). The visual test mocks navigation/current-center lookup; it does not claim a signed-in workflow passed.

Still required before calling the full audit complete:

- Shared inquiry assignment/status/internal notes: authenticated schema/RLS design, migration, persistence UI, cross-role tests. Not substituted with browser-only fake shared state.
- Permission-checked member context in inquiries; custom shared templates; page-navigation draft preservation.
- Complete saved filter sets/favorites, context/scroll restoration, consistent unsaved-change guards and keyboard behavior on all sheets.
- Conflicts across all affected recurring occurrences, including atomicity and partial-update outcomes (scope confirmation is implemented).
- All-center stale-response/form-switch audit beyond the member/class/sales/message entry points already improved.
- Exact billable cost preview from configured contract/pricing source; authoritative delivery receipts and safe idempotent retry.
- Authenticated owner/staff/multi-center end-to-end tests; full page layout, long-data, zoom, touch, and mobile regression checks (header checks alone are insufficient).
- Review/commit/PR/deployment. No production merge or deployment performed for this checkpoint.
