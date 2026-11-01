# <Change name>

<!--
Canonical /crew plan template. Keep every top-level section, in this order.
Write facts you verified; record unknowns as Variables or open decisions, never as invented facts.
Delete these comments when you write a real plan.
-->

## Problem

<!-- What is wrong or missing today, for whom, and the evidence (paths, issues, specification references). -->

## Solution

<!-- The intended outcome in a few bullets. Name the specification requirements (R1, R2, ...) this change must satisfy so phases can trace back to them. -->

## Variables

<!-- Unknowns and open decisions. For each: what is unknown, why it matters, how it will be resolved (Scout fact, Oracle advice, user decision), and its current state. -->

## Constraints/Invariants

<!-- Rules that must hold throughout: existing behavior to preserve, security and data rules, AGENTS.md decisions, network/deployment limits (no mainnet broadcasts unless explicitly agreed). -->

## Implementation Notes

<!-- Relevant existing architecture, reusable code, Scout facts (with path:line), Oracle recommendations, and accepted decisions. -->

## Workflow

Baseline: <!-- how the starting source state was captured, e.g. `.crew/baseline.json` -->

Phases are **vertical slices**: each delivers one thin, observable outcome across only the layers it needs
(database/contract, service/API, frontend, validation). Layers are subtasks inside a phase, never separate phases.
Fold enabling work into the first phase that needs it. Tests belong to the phase whose behavior they establish.

Rules for every phase:

- **Outcome form.** Write the outcome as "A <actor> can <do X> and sees <Y>", where the actor is a user, caller,
  or operator. "Tests pass", "X is deployed", or "Y exists" are evidence, not outcomes.
- **Slice by behavior, never by component.** Split by what the actor can do (tip, then withdraw), not by layer
  (contract, then UI). If phase titles read like layers, regroup.
- **Walking skeleton first.** P1 runs the whole path from the real entry point (UI, API, or CLI) to the real
  persistence or contract, even if every layer is minimal. Later phases add capability to that path.
- **Demo from the entry point.** Each phase has a demo script whose first step is at the real entry point.
- **Say what is thin.** List what is deliberately stubbed or deferred so a thin phase is never a hidden one.
- **Shippable alone.** If later phases were cancelled, the accepted phases must still be usable.

Wrong: P1 contract + deploy script, P2 frontend. Right: P1 a visitor tips and sees the tip in a minimal page
(contract, deploy, UI, tests, all thin); P2 the owner withdraws (contract + UI button).

### P1 — <A <actor> can <do X>, no layer names>

- **Outcome:** A <actor> can <do X> and sees <Y>.
- **Demo script:** <3-5 steps a human performs starting at the real entry point, each with its expected result>
- **Stubbed or deferred:** <what is intentionally minimal or left to later phases>
- **Satisfies:** <requirement IDs / accepted decisions>
- **Scope:** <included; explicitly excluded>
- **Subtasks:**
  - [ ] <layer>: <thin change needed for this outcome>
  - [ ] <layer>: <...>
  - [ ] checks: <tests or scripted checks that prove the integrated outcome>
- **Depends on:** <earlier phases, or "baseline">; **Open decisions:** <none | variable IDs>
- **Acceptance criteria:**
  1. <observable behavior, including relevant failure behavior>
- **Checks/evidence:** <exact commands or observations that prove each criterion end to end>
- **Regression coverage:** <how previously accepted behavior stays covered>
- **Status:** pending <!-- pending | current | implemented | accepted | blocked -->
- **Evidence:** <filled in on acceptance: check results, review verdict, scope fingerprint>

### P2 — <next outcome>

<!-- Same fields. Prefer more, thinner phases over one large phase. -->

### Phase boundary check (complete before asking for agreement)

- [ ] Every phase is demonstrable on its own; none waits for a later "integration" or "testing" phase.
- [ ] Every outcome has the form "A <actor> can <do X> and sees <Y>" and every demo script starts at the real entry point.
- [ ] No phase title or outcome names a layer (contract, schema, API, frontend, tests).
- [ ] P1 touches every layer the final product has, even if thinly.
- [ ] A single-layer phase is allowed only when the repository evidence (quoted) shows the change has only that layer.
- [ ] If every later phase were cancelled, the accepted phases would still be usable.
- [ ] Every requirement in Solution maps to at least one phase.
- [ ] Dependencies run forward only, and each phase lists regression coverage for earlier ones.

## Deliverables

<!-- Concrete files, behaviors, docs, and AGENTS.md knowledge updates expected at the end. -->

## Definition of Done

<!-- Every phase accepted; cumulative checks pass; integrated review PASS over the whole change; AGENTS.md updated with accepted durable decisions only. -->

## Validation

<!-- Cumulative checks to run at the end across all phases, and how the integrated review is scoped (baseline → final). -->
