# pi-goal

`/goal` for [pi](https://pi.dev): keep working on one objective until it is met. Each time the model would stop, a
reviewer checks the conversation against the objective, believes only the evidence in it, and sends the model back
with what is missing. After [opencode](https://github.com/anomalyco/opencode)'s `/goal`.

```bash
pi install npm:@mrq/pi-goal
```

## Use

```
/goal make the tests pass and keep the build green
```

| Command | |
|---|---|
| `/goal <objective>` | set the goal and start on it |
| `/goal` | the goal, its round and the reviewer's last word |
| `/goal pause` | no more rounds after the current one; Esc pauses it too |
| `/goal resume` | go on with a paused goal, with 50 more rounds |
| `/goal clear` | drop it |

While a goal is active, pi's status shows how long it has been at it, `⇒ 12m` (`⇒ paused` once paused), and each
round starts with a notice saying what the reviewer found missing; `/goal` tells the round. Objectives that name a
checkable end state work best: "until `npm test` passes", "until the endpoint returns 200".

## How it works

- **Kickoff.** The objective goes to the model in a note it reads as the user's: work on this until it is met, and
  show the evidence (command output, test results, file contents), because a reviewer will check.
- **Review.** Where the run would end, pi asks the same model once more, over the same conversation, to stop working
  and judge, without calling tools. It answers with one line of JSON: `done` (with the evidence), `continue` (what is
  missing and the next step), `blocked` (what it needs from the user) or `paused` (the user asked to stop). The model
  saying the goal is met is not evidence; when unsure, the reviewer says `continue`.
- **Rounds.** On `continue` the run goes on with a note carrying the reviewer's reason and next step. `done` ends the
  goal; `blocked` and `paused` pause it.
- **Limits.** A goal pauses after 50 rounds, after three rounds in a row that called no tools or drew the same
  complaint, when the run is interrupted or fails, and when a session starts with it active, since no run drives it
  then.
- **State.** The goal is kept in the session, on the branch: `/tree`, forks and resumed sessions each have their own.
- **Compaction.** If a compaction takes the kickoff and the round notes out of view, each request carries a reminder of
  the objective at its end until the next round brings it back. The reminder is never saved.

## What it costs

- **Nothing without a goal.** The extension registers no tools and adds nothing to the system prompt, so a session
  without a goal sends exactly what it sent before.
- **One review per round.** The reviewer's request is the model's last request with its reply and the question after
  it, so a prompt cache serves everything but the question. It goes out without the session's id, so the session's
  own requests keep their Anthropic message thread.
- **Two kinds of note** in the history: the kickoff, and one per round.

## For frontends

The kickoff and the round notes are hidden custom messages of type `goal` (`GOAL_NOTE`). The kickoff's details carry
the `/goal` as typed (`GoalNoteDetails.command`), for a frontend that shows the kickoff as the user's prompt, as
[pi-vt420](https://github.com/mrq1911/pi/tree/vt420/packages/coding-agent/src/experimental/vt420) does. The package
also exports `parseVerdict`, `remindOfGoal`, `MAX_ROUNDS` and `MAX_STALLS`.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
```

The tests drive a real pi session through pi's SDK, on a scripted model.

## License

MIT
