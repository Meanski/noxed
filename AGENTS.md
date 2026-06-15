# noxed — Agent Rules

These rules apply to all AI coding agents working on this project.

## Architecture

noxed is an Electron app with three isolated layers. Never leak concerns across them.

- **Main process** (`src/main/`) — Node.js. Owns all system access: SSH, SFTP, Docker, databases, Redis, K8s, tunnels, filesystem, keychain. Exposes functionality exclusively through IPC handlers.
- **Preload** (`src/preload/`) — Thin bridge. Only `contextBridge` + `ipcRenderer`. No logic, no transforms.
- **Renderer** (`src/renderer/`) — React + Zustand. Pure UI. All system access goes through `window.api.*`. Never import Node.js modules.

IPC is the security boundary. Every handler in `src/main/ipc/` must validate its inputs — the renderer is untrusted.

## Security

- Never trust renderer input. Validate types, ranges, and paths in every IPC handler.
- Never send secrets to the renderer without gating behind `isUnlocked()`.
- Never execute arbitrary commands from user input without a blocklist check.
- Filesystem reads must be restricted to allowlisted directories.
- Use `sandbox: true` and `contextIsolation: true`. Always.
- Credentials go through OS keychain (`keytar`), never electron-store.

## Naming

- **Files:** PascalCase for React components (`TerminalView.tsx`). camelCase for non-component modules (`security.ts`, `ssh.ts`). Tests go in `__tests__/` adjacent to source.
- **Exports:** Default export name must match filename. `FilesDrawer.tsx` exports `FilesDrawer`, not `FilesPanel`.
- **Components:** One primary component per file. Supporting sub-components are fine, but keep them private (not exported).
- **Types/interfaces:** PascalCase. No `I` prefix, no `T` prefix.
- **Constants:** UPPER_SNAKE_CASE for true constants. Regular camelCase for derived values.
- **Feature folders:** PascalCase matching the feature (`K8s/`, `SFTP/`, `Redis/`).

## Code Quality

- Prefer small, reusable primitives over one-off UI or IPC patterns. If two features share behavior or chrome, extract a shared component/helper before adding a second implementation.
- Treat new code as if it will be reviewed publicly. Keep APIs narrow, names precise, and behavior easy to reason about from the call site.
- Before adding a new helper, search for an existing canonical helper. Before duplicating logic, either reuse it or explicitly justify why it cannot be shared.
- No orphaned `console.log`. Use structured error handling instead.
- No `catch {}` or `catch () {}` — always handle or explicitly annotate why it's safe to swallow.
- No `any` in function signatures. Use `unknown` and narrow, or define a proper type. `any` in catch blocks is acceptable only as `catch (err: any)` for Electron IPC error messages.
- Never duplicate utility logic across files. Shared formatters, colors, and helpers go in `src/renderer/src/lib/`.
- No dead code. No commented-out blocks. No unused imports.
- Aim to keep files under ~500 lines; extract sub-components or hooks when one grows past it. A handful of existing files (e.g. `K8sDashboard.tsx`, `AddConnectionModal.tsx`, `Settings.tsx`) already exceed this — treat them as extraction candidates, and don't pile more onto them without splitting.

## Comments

Write comments only when the code cannot explain itself:

- **Why** something is done a non-obvious way
- **Constraints** from external systems (e.g., "ssh2 requires rows before cols")
- **Security rationale** for validation logic

Never narrate what the code does. Never leave TODO comments without a linked issue. Never comment changes you're making.

## Error Handling

- Main process: always `throw new Error(message)` or a typed subclass — never `reject(string)`.
- Renderer: catch errors from IPC and surface them to the user via the notification system or inline error state.
- Custom error classes live in `src/main/ipc/errors.ts`: `ValidationError`, `AuthError`, `ConnectionError`, `NotFoundError`, `OwnershipError`.

## Shared Code

These are the canonical locations. Do not duplicate this logic elsewhere.

- `src/renderer/src/lib/format.ts` — byte/size formatting, path joining, relative time, uptime, sparklines, date formatting, and IPC error message extraction (`ipcErrorMessage`)
- `src/renderer/src/lib/colors.ts` — metric threshold colors, connection type colors, group color hashing, pod status colors
- `src/main/ipc/security.ts` — path/key-path validation, command blocklists, text/binary file detection, and input validators (`validateHost`, `validatePort`, `validateK8sName`)
- `src/main/ipc/errors.ts` — custom error classes for IPC handlers

## React Patterns (renderer only)

- Functional components only. No class components except error boundaries.
- Props interfaces live in the same file, directly above the component.
- Destructure props in the function signature.
- Keep render logic flat — extract sub-components over deep ternary nesting.
- `useRef` for values that must survive re-renders without causing them (timers, client IDs, stream IDs).
- Cleanup effects must use refs for current values, never stale closure state.
- Global state in Zustand store. `useState` only for ephemeral UI state.
- Persisted settings go through IPC to electron-store, never local state.
- Tailwind for layout/spacing. CSS custom properties (`var(--nox-*)`) for theme colors. Never hardcode hex colors outside `lib/colors.ts`.

## IPC Handler Rules (main process only)

- Every handler must validate inputs before acting. The renderer is untrusted.
- Validate ownership for every connection/resource ID. A renderer window may only operate on clients, streams, timers, and files it created or is explicitly allowed to use.
- Validate path strings before any filesystem or remote filesystem operation. Reject null bytes, empty paths where invalid, unreasonable lengths, and paths outside the intended trust boundary.
- Throw typed `Error` subclasses, never `reject(string)`.
- Store active connections in a `Map<string, T>` keyed by UUID.
- Always clean up on disconnect: close streams, clear timers, remove from map.
- Use a `require*(id)` guard (e.g. `requireClient`, `requireOwnedConn`, `requireSession`) to validate and ownership-check connection/resource IDs, throwing a clear typed error.
- Credentials stored in OS keychain via `keytar`, never in electron-store.
- Secret values require `isUnlocked()` gate. Never log credential values.

## Testing

- Tests live in `__tests__/` directories adjacent to source.
- Test pure functions by importing them directly. Never duplicate production logic in test files.
- Name test files `<module>.test.ts`.
- Use `describe`/`it` blocks with clear descriptions that read as specifications.
- Run with `npm test` (Vitest).

## Review Gate

Before handing work back, review the touched code for:

- Security boundary violations between main, preload, and renderer.
- Missing IPC validation or missing ownership checks.
- Duplicated UI chrome, duplicated protocol logic, or one-off styling that should be shared.
- Hidden lifecycle coupling, especially mounted/unmounted terminal, SFTP, Redis, database, and K8s clients.
- Files over 500 lines, deeply nested render logic, dead code, unused imports, and stale comments.
- User-facing error states that imply the wrong subsystem failed.
