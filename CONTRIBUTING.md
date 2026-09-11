# Contributing to Mozi

Thanks for your interest in contributing!

## Getting Started

1. Node >= 20, pnpm >= 9
2. `pnpm install`
3. `pnpm build && pnpm test`  — all green before you commit

## Pull Requests

- Keep PRs small and focused
- New modules must ship with tests in the same PR (CI enforced)
- Follow the existing code style (Biome, enforced via `pnpm lint`)
- See `docs/` for architecture context before touching `packages/core`

## Branching

Trunk-based: short-lived branches off `main`, squash-merge.
