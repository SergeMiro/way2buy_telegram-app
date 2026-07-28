# handoff/

Each executing agent writes its structured report here before finishing, named `NN-<role>.md`
(matching its plan.md step number), and appends one line to `../decisions.log`.
Never overwrite another agent's handoff file. See the `scratchpad-protocol` skill.

Expected files as steps complete:
- 01-database.md, 02-design.md, 03-loyalty.md, 04-campaigns.md, 05-notifications.md,
  06-scheduler.md, 07-agent.md, 08-frontend-foundation.md, 09-cards-rewards.md,
  10-notifications-ai-ui.md, 11-qa.md, 12-sre.md, 13-security.md
