# 006. Run TypeScript without a build

- **Status**: accepted
- **Context**: Node 26 runs TypeScript directly by stripping types. A build step adds config, source maps, and a second set of paths to keep in sync.
- **Decision**: Run `src/` with Node as is, check types with `tsc --noEmit`, and only use syntax that strips cleanly, which `erasableSyntaxOnly` enforces.
- **Consequences**:
  - The image and `pnpm dev` run the same files the tests do.
  - Enums, namespaces, and parameter properties aren't allowed.
