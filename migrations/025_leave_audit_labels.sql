-- Migration 025: honest audit titles for the leave workflow.
--
-- LOUD NOTE, because minting an "Actions" row is not a free act: these two rows
-- ARE NEW ACTIONS, and they are needed. Audit-log titles render from
-- "Actions".action_name, so without them a filed leave request would appear in
-- History as "Attendance Clock Event" and an approval as "Approve Attendance" —
-- logged, but describing something that did not happen and unfindable by anyone
-- searching for a leave. That is exactly the bug migration 023 was written to
-- fix; re-creating it knowingly would be worse than adding a label.
--
-- THESE ARE LABELS, NOT GATES. Neither id is ever passed to validateAction.
-- Every leave route is gated on the EXISTING 'Review Attendance'
-- (2e7b9c40-1f83-4d6a-b902-5a8c3e1f6047), the same permission that already
-- guards GET /attendance and POST /attendance/:id/approve — whoever reviews a
-- clock-in is exactly who should review a day off. Gating on a brand-new id
-- would strip leave review from every role that exists today the moment this
-- migration landed, because no role has been granted an id that did not exist
-- until now. Logging must never become a permission gate.
--
-- (Both rows still render as grantable checkboxes in the role editors — that is
-- how "Actions" works — so each action_desc says outright that ticking it
-- changes nothing, rather than leaving someone to wonder why.)

INSERT INTO "Actions" (id, action_name, action_desc, "group")
VALUES
  (
    '4455a271-5610-49a3-be8e-3f2e9990170a',
    'Leave Requested',
    'Audit label for filing an employee leave request. Granting it does nothing on its own — filing a leave for someone else is gated by Review Attendance, and filing your own needs no permission.',
    'Restaurant Specific'::"Action_groups"
  ),
  (
    '6465027f-a3a1-4851-bd8a-cc3360b67993',
    'Leave Reviewed',
    'Audit label for approving or rejecting an employee leave request. Granting it does nothing on its own — the decision is gated by Review Attendance.',
    'Restaurant Specific'::"Action_groups"
  )
ON CONFLICT (id) DO NOTHING;
