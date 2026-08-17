---
name: effect
description: How to use Effect , the typescript library
---

When writing Effect code, inspect @effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

## Checklist before consulting this skill

- The @effect/ git submodule should be initialized and updated. Run `git submodule update --init --recursive` in the root of the repository if you haven't done so already.
- It looks over the entire code base under @effect/ so to save contexts consider running a subagents to analyze the code base
- If the submodule's checked out commit doesn't match the effect version in package.json, ask the user to update the submodule to the correct commit first.

## Vendored Repositories

This project vendors external repositories under @effect/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @effect/ unless explicitly asked
- Do not import from @effect/ - application code should continue importing from normal package dependencies