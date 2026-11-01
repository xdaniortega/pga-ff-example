# `/crew` — plan, deliver, review, resume

`/crew` turns the main Claude Code session into the **brain** that coordinates four subagents. The
authoritative rules are in [SKILL.md](SKILL.md); this page explains how to use them.

## Invoke

```text
/crew <what you want changed>     plan a new change (stops for your agreement)
/crew resume                      continue from .crew/state.md in a fresh session
/crew status                      report where the work stands, change nothing
```

## What happens

1. **Orient.** The brain reads `AGENTS.md`, your spec or plan, and current source. It asks `scout` for facts
   and `oracle` for advice on consequential choices.
2. **Plan.** It writes `plan.md` from [plan-template.md](plan-template.md): ordered **vertical phases**,
   each a thin observable outcome with its own subtasks across layers, acceptance criteria, checks, and
   regression coverage. It runs the template's phase boundary check, then **stops** for your agreement.
   A supplied plan is kept; horizontal pending work is regrouped only with your agreement.
3. **Deliver one authorized phase.** Baseline snapshot → `executor` implements the whole phase → the
   brain inspects the diff and re-runs the checks itself → candidate `AGENTS.md` knowledge → frozen review
   scope (content fingerprint) → review packet → fresh `reviewer` verdict.
4. **Correct.** Blocking findings go back to `executor` (or to the brain for its own plan/knowledge edits),
   then re-check and re-review. At most two correction rounds, then the brain asks you.
5. **Accept.** Only with `PASS`, passing checks, and an unchanged fingerprint. Then the phase is marked
   `accepted` in the plan and the next *authorized* phase starts.
6. **Finish.** After the last phase of a multi-phase change, cumulative checks and one integrated review
   over the whole change from the first baseline.

## Where things live

| Path | Owner | Committed? |
|---|---|---|
| `plan.md` (or the path you choose) | brain | your choice |
| `AGENTS.md` section *Project knowledge (maintained by /crew)* | brain, reviewed with each phase | yes, it is project knowledge |
| `.crew/state.md`, `.crew/*.json`, `.crew/reviews/` | brain | no (git-ignored) |
| Application source | executor | your choice; the workflow never commits |

## Review identity

`scripts/snapshot.mjs` hashes file contents, not names or line counts, so a review applies to exactly the
source it saw. It works with untracked files, in a repository without commits, and outside Git.

```bash
node .claude/skills/crew/scripts/snapshot.mjs capture .crew/P1.base.json --exclude plan.md
node .claude/skills/crew/scripts/snapshot.mjs scope .crew/P1.base.json .crew/P1.scope.json --criteria plan.md
node .claude/skills/crew/scripts/snapshot.mjs verify .crew/P1.scope.json   # exit 1 on any content change
```

## Resuming

Everything needed to continue is on disk: the plan, `AGENTS.md`, and `.crew/`. Start a new session and run
`/crew resume`. No conversation history or personal configuration is required.

## Next steps

- **Hooks:** add a `PreToolUse` hook that blocks `Edit`/`Write` in the main session on source paths, turning
  the "brain does not implement" rule into enforcement.
- **Stronger state:** generate `.crew/state.md` with a script and validate it on resume.
- **Checkpoint policy:** if your team wants them, add a commit or branch per accepted phase; the fingerprint
  stays the review identity either way.
- **Broader review:** add specialist reviewers (security, performance) for high-risk phases, or run a
  multi-agent review at the end. Expect more cost and setup; keep the single reviewer as the gate.
