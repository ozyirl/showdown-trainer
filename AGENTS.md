<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- You have access to the Nx MCP server and its tools, use them to help the user
- When answering questions about the repository, use the `nx_workspace` tool first to gain an understanding of the workspace architecture where applicable.
- When working in individual projects, use the `nx_project_details` mcp tool to analyze and understand the specific project structure and dependencies
- For questions around nx configuration, best practices or if you're unsure, use the `nx_docs` tool to get relevant, up-to-date docs. Always use this instead of assuming things about nx configuration
- If the user needs help with an Nx configuration or project graph error, use the `nx_workspace` tool to get any errors

<!-- nx configuration end-->

## Repo-Specific Workflows

- Install dependencies with `npm ci` (matches CI workflow).
- Common API shortcuts from root `package.json`:
  - `npm run start` (`nx serve api`)
  - `npm run build` (`nx build api`)
  - `npm run test` (`nx test api`)
  - `npm run lint` (`nx lint api`)
  - `npm run graph` (`nx graph`)
  - `npm run affected:build` (`nx affected -t build`)
  - `npm run affected:test` (`nx affected -t test`)
- E2E tests are defined on `api-e2e` as target `e2e` (`npx nx run api-e2e:e2e`).
- CI currently runs `npx nx run-many -t lint test build typecheck e2e-ci`.
  - TODO: confirm whether `e2e-ci` is an inferred alias in this workspace or should be `e2e` for local parity.
