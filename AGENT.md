<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.


# AGENT.md

## Purpose
This file defines the working method for this repository.
Use it to keep planning, implementation, and verification consistent across sessions.

## Repository Entry Documents
The repository should also maintain these top-level entry documents:
- `README.md`
- `AGENTS.md`

`README.md` is the repository entry point for humans and AI agents. It should explain what the project is, how the repository is organized, where the source-of-truth documents live, and how to start working safely.

`AGENTS.md` defines the working method for AI agents. It does not replace `README.md`, and `README.md` does not replace the source-of-truth documents under `docs/`.

## Core Rule
`docs/` is the source of truth for product scope, workflow, architecture, API contract, and data model.
Do not implement from assumption when a documented source exists.

## Standard Work Sequence
For any non-trivial task, follow this order:
1. Identify the active phase in `docs/implementation-roadmap.md`
2. Read the source documents referenced by that phase
3. Confirm scope, constraints, and open questions
4. Implement only the checklist items for that phase
5. Run challenge/verification for the changed area and capture explicit evidence for the checklist item being executed
6. Update roadmap and related docs before declaring completion

## Mandatory Documents
The repository should maintain at least these mandatory documents when applicable:
- `docs/project-plan.md`
- `docs/product-principles.md`
- `docs/functional-specification.md`
- `docs/technical-implementation-plan.md`
- `docs/openapi.yaml`
- `docs/database-schema-specification.md`
- `docs/implementation-roadmap.md`
- `docs/open-questions-and-challenges.md`

These files are the minimum required documentation baseline and must remain maintained and synchronized.

## Supporting Documents
Agents may add other supporting documents under `docs/` when they improve clarity, planning, implementation, verification, operations, or handoff.

Recommended supporting documents include:
- `docs/architecture-decisions.md`
- `docs/testing-strategy.md`
- `docs/deployment-and-environment.md`
- `docs/security-and-access-model.md`
- `docs/integration-contracts.md`
- `docs/operational-runbook.md`

Supporting documents do not replace the mandatory set. Add them when they reduce ambiguity or preserve important implementation and operational knowledge.

## Change Control Rules
- Every backend change must include an explicit `docs/openapi.yaml` review.
- If a backend change affects routes, payloads, headers, auth, validation, response codes, or integration contract behavior, update `docs/openapi.yaml` in the same work item.
- Do not defer `docs/openapi.yaml` updates to a later cleanup task.
- Do not change backend behavior without checking whether `docs/openapi.yaml` must change.
- Do not change workflow, approval, statuses, or user-visible behavior without updating the related docs.
- Do not close a phase until verification has passed.
- Do not skip unresolved ambiguity; record it in `docs/open-questions-and-challenges.md`.

## Phase Discipline
Each phase in `docs/implementation-roadmap.md` must contain:
- objective
- source documents
- checklist
- output
- challenge / verification

A phase is only complete when:
- checklist items are complete
- tests/debugging for that phase pass
- related docs are synchronized
- roadmap status is updated

## Verification Standard
Every meaningful implementation must include explicit verification evidence, such as:
- build/typecheck passed
- endpoint contract verified
- workflow path tested
- edge case or failure path challenged

Checklist items in `docs/implementation-roadmap.md` must not be marked complete unless their challenge/verification evidence is recorded.
Do not mark work complete without verification notes.

## Response Behavior For Agents
When starting work:
- state the active phase
- name the source docs being used
- call out ambiguity before implementing

When finishing work:
- summarize changed files
- summarize updated docs
- state whether `docs/openapi.yaml` was updated and, if not, why no contract change was required
- state verification performed
- state whether the roadmap/checklist was updated

## Escalation Rules
If documentation conflicts:
1. stop implementation
2. identify the conflicting files
3. propose the smallest clarification needed
4. wait for direction or update docs first

## Definition of Done
A task is done only if:
- implementation is complete
- relevant docs are updated
- `docs/openapi.yaml` is updated for every applicable backend change
- verification has passed
- the executed roadmap checklist step has recorded challenge/verification evidence
- roadmap/checklist reflects reality
<!-- LOVABLE:END -->
