<p align="center">
  <img src="logo.svg" width="96" alt="noxed logo" />
</p>

<h1 align="center">noxed</h1>

<p align="center">
  SSH sessions, SFTP, databases, Redis, and Kubernetes — one desktop app.
</p>

noxed is a connection manager for people who live in terminals. Open an SSH
session with live CPU/memory metrics in the header, browse the same server
over SFTP in a side drawer, run queries against Postgres or MySQL, inspect
Redis keys, and watch a Kubernetes cluster — all in tabs of a single window.

I built noxed because I wanted this product to exist. Yes, big chunks of it were built
with AI assistance, and that is intentional: the goal is a useful, inspectable
tool, not the golden standard when it comes to software development. If you want to improve it, patches are welcome.

## Features

**SSH terminal**
- Tabbed sessions with per-host color coding, favorites, and project groups
- Split panes — up to four terminals in one tab, with keystroke broadcast
- Jump hosts (ProxyJump): reach servers behind a bastion, chained automatically
- Live CPU, memory, disk, and load metrics streamed over the existing connection
- Scrollback search (`Cmd+F`), configurable themes, fonts, and cursor styles
- Command snippets (global or per-host)
- Import hosts straight from `~/.ssh/config`, ProxyJump included

**Tunnels**
- Local and remote port forwarding plus a SOCKS5 proxy, over any saved connection
- Saved tunnel definitions with one-click start/stop and live status in the status bar

**Fleet tools**
- Mission-control dashboard: reachability, CPU sparklines, memory, disk, load,
  and uptime for every server, with alerts when CPU pins or a disk fills up
- Multi-host command runner: run one command across selected servers and
  compare outputs and exit codes side by side

**Docker — no agent required**
- Containers, images, live CPU/memory stats, and streaming logs on any host
  with the docker CLI, all over the plain SSH connection
- Start, stop, restart, and remove containers from the dashboard

**SFTP**
- Standalone browser or a drawer attached to an SSH session
- Upload, download, rename, chmod, and inline editing with CodeMirror

**Databases & Redis**
- PostgreSQL, MySQL, and MariaDB: schema browser, query editor with history,
  saved queries, and EXPLAIN
- Redis: key browser, value inspector, TTLs, and a guarded command line
  (destructive commands are blocked)

**Kubernetes**
- Multi-context dashboard: workloads, services, config, nodes, and events
- Pod logs (streamed), exec into containers, port forwarding, scale and
  restart deployments

**Security**
- Credentials live in the OS keychain, never in config files
- Optional lock screen: Touch ID, PIN, or password, with auto-lock
- Sandboxed renderer with context isolation; every IPC handler validates its
  input and the main process treats the UI as untrusted
- SSH keys and kubeconfigs are only readable from allowlisted directories

## Install

Grab a build from the releases page, or build one yourself (below).

**macOS note:** release builds are not yet signed or notarized. If macOS
reports the app as damaged after download, clear the quarantine flag:

```sh
xattr -cr /Applications/noxed.app
```

**Linux note:** credentials are stored through `libsecret`, so a keyring
service (GNOME Keyring or KWallet) must be running. On Debian/Ubuntu:
`sudo apt install libsecret-1-0`.

## Building from source

Prerequisites: Node.js 20+ and npm. `npm install` also rebuilds the native
keychain module (keytar) against Electron, so the first install needs network
access and a few extra seconds.

```sh
git clone https://github.com/Meanski/noxed.git
cd noxed
npm install
npm run dist
```

Installers land in `dist/` — a `.dmg` and `.zip` on macOS, an NSIS installer
on Windows, and an AppImage plus `.deb` on Linux. For a quick unpackaged
build to try locally, `npm run pack` produces the bare app in
`dist/<platform>/` without making installers.

## Development

```sh
npm install
npm run dev     # start with hot reload
npm test        # run the test suite (vitest)
npm run build   # production bundle (no installer)
```

The app is Electron with three strictly separated layers:

- `src/main/` — Node.js main process. All SSH/SFTP/K8s/database/keychain
  access lives here, exposed through validated IPC handlers.
- `src/preload/` — the `contextBridge` API surface, nothing else.
- `src/renderer/` — React + Zustand UI. No Node.js access.

See [AGENTS.md](AGENTS.md) for the full conventions used in this codebase.
Those conventions apply whether code is written by hand, with AI assistance,
or through a mix of both.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd+K` | Command palette |
| `Cmd+T` | New connection |
| `Cmd+W` | Close tab |
| `Cmd+F` | Search terminal scrollback |
| `Cmd+1…9` | Jump to tab |
| `Ctrl+Tab` / `Cmd+Shift+[`/`]` | Cycle tabs |

## License

[MIT](LICENSE)
