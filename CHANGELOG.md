# Changelog

## [0.2.0] - 2026-11-22

- the status says how long the goal has been active, ticking a second at a time as /loop's does (`⇒ 12m`), instead of its round; `/goal` still tells the round

## [0.1.0] - 2026-11-13

- `/goal <objective>` keeps the model working until a reviewer, the same model asked over the same conversation, finds the objective met from the evidence in it
- `/goal`, `/goal pause`, `/goal resume` and `/goal clear`; Esc pauses a goal
- a goal pauses after 50 rounds, after three rounds that called no tools or drew the same complaint, and when the run is interrupted or fails
- nothing added to the system prompt or the tools; the goal is kept per session branch
