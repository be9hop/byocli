# BYOCLI Continuous Integration Guide

BYOCLI uses **GitHub Actions** to automatically run type-checking, tests, and builds on every push and pull request. This document explains what runs, why, and how to work with it.

---

## TL;DR

```bash
git push                    # triggers CI on your branch
gh run list                 # see recent runs
gh run watch                # live-watch the current branch's run
```

Every push and PR runs two jobs in parallel. If either fails, the PR shows a red ❌ and shouldn't be merged. Once green, merge with confidence.

---

## What the workflow does

The workflow lives at [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It defines **two jobs** that run in parallel:

### Job 1 — Frontend (runs on Ubuntu)

```
checkout → setup Node 20 → npm ci → tsc -b → npm test → npm run build
```

| Step | Command | What it catches |
|---|---|---|
| **Type-check** | `npx tsc -b` | Type errors across all four tsconfigs (app, vitest, node, root). Catches mismatches between the test files and the source. |
| **Tests** | `npm test` (vitest) | The 40+ unit tests in `src/lib/*.test.ts` — cron resolver, session normalization, UUID fallback, formatting. |
| **Build** | `npm run build` (vite) | Confirms the production bundle compiles. A failure here would also break installer generation (`tauri build` runs the same `beforeBuildCommand`). |

**Why Ubuntu?** The frontend test suite stubs the Tauri IPC layer via the `isTauri()` gate (see `src/lib/platform.ts`), so tests run identically on any OS. Ubuntu runners are cheaper and faster than Windows runners, so we use them where we can.

### Job 2 — Backend (runs on Windows)

```
checkout → setup Rust (stable) → cargo test → cargo build
```

| Step | Command | What it catches |
|---|---|---|
| **Tests** | `cargo test` | The 8 unit tests in `src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`) — workspace path sandboxing, directory listing (truncation, sorting, file-vs-dir rejection). |
| **Build** | `cargo build` | Confirms the Rust backend compiles, including all `cfg(windows)` code paths (hidden console allocation, PTY spawn, PowerShell invocation). |

**Why Windows?** BYOCLI is Windows-first. The PTY spawn, the `attach_hidden_console()` helper, and the automation command builder all live behind `#[cfg(windows)]` and only compile on Windows. Running the backend job on Windows validates these paths actually build — a Linux runner would silently skip them.

---

## When CI runs

```yaml
on:
  push:
    branches: ["**"]        # every push to any branch
  pull_request:
    branches: ["main"]      # every PR targeting main
```

- **Push to a feature branch** → CI runs on that branch.
- **Open/update a PR to main** → CI runs on the PR head.
- **Push directly to main** → CI runs (and must pass, once branch protection is on).
- **Tags / releases** → CI does *not* run on tags currently. Releases are built locally with `npm run tauri build`.

---

## Concurrency cancellation

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

If you push twice in quick succession to the same branch, the first CI run is **cancelled** automatically. Only the latest commit's result matters. This saves runner minutes and means you don't wait for a stale run to finish before seeing the current state.

---

## Caching

The backend job caches the Cargo registry and `target/` directory via [`Swatinem/rust-cache`](https://github.com/Swatinem/rust-cache):

```yaml
- name: Cache cargo
  uses: Swatinem/rust-cache@v2
  with:
    workspaces: src-tauri
```

- **First run:** ~5 minutes (compiles `portable-pty`, `rusqlite`'s bundled SQLite, the Tauri runtime).
- **Subsequent runs:** ~30–60 seconds (only recompiles what changed).

The frontend job uses `actions/setup-node` with `cache: npm`, which caches the `node_modules` download.

---

## How to work with CI

### Check the status of a run

```bash
gh run list                 # recent runs, newest first
gh run list --limit 5       # last 5
gh run view <run-id>        # detailed view with per-step status
gh run watch                # live tail of the latest run on your branch
```

Or just look at the GitHub UI: the PR checks section, or the **Actions** tab.

### Re-run a failed job

```bash
gh run rerun <run-id>                       # re-run all jobs
gh run rerun <run-id> --job <job-id>        # re-run just the failed job
gh run rerun <run-id> --failed              # re-run only the failed jobs
```

### Download logs

```bash
gh run view <run-id> --log                  # full log to stdout
gh run view <run-id> --log > run.log        # save to a file
```

### Debug a failure locally

The CI commands are identical to what you'd run locally — no special CI-only setup. To reproduce a failure:

```bash
# Frontend
npm ci
npx tsc -b
npm test
npm run build

# Backend
cd src-tauri
cargo test
cargo build
```

If it fails locally, it'll fail in CI. Fix it, push, CI re-runs.

---

## Branch protection (recommended next step)

CI only protects `main` if you enforce it. To require green CI before a PR can merge:

1. Go to **Settings → Branches → Branch protection rules → Add rule**.
2. Branch name pattern: `main`.
3. Check **"Require status checks to pass before merging"**.
4. Select the two checks: `Frontend · typecheck · test · build` and `Backend · test · build (Windows)`.
5. (Optional) Check **"Require branches to be up to date before merging"**.
6. Save.

After this, no PR can merge with a red ❌. The merge button is disabled until both jobs pass.

> _Note: I didn't enable this automatically because it's a repo-settings change that's best done deliberately by the owner. The CLI command is `gh api repos/be9hop/byocli/branches/main/protection ...` but the JSON payload is fiddly; the dashboard is more reliable for first setup._

---

## The test suite

CI runs the same tests you run locally. Here's what's covered:

### Frontend (`src/lib/*.test.ts`, 40 tests)

| File | Tests | Covers |
|---|---|---|
| `automations.test.ts` | 20 | `validateCron` (malformed/range errors), `parseCron` (expansion), `nextRunForSchedule` for all 4 schedule kinds (interval/daily/weekly/cron), the Feb-30 impossible-date terminator, `describeSchedule`, `formatRunTime` |
| `defaults.test.ts` | 15 | `createWorkspace`, `normalizeState` session preservation (M3 fix), profile merge, automationRuns 150-cap, default state |
| `uuid.test.ts` | 5 | RFC 4122 v4 format, version/variant bits, uniqueness across 1000 calls, the non-secure-context fallback (L2 fix) |

### Backend (`src-tauri/src/lib.rs`, 8 tests)

| Test | Covers |
|---|---|
| `canonical_path_allows_inside_workspace` | Sandboxed paths resolve |
| `canonical_path_rejects_outside_workspace` | **Sandbox escape blocked** |
| `canonical_path_rejects_missing_root` | Error on deleted root |
| `read_directory_lists_files_and_directories` | Basic listing, non-recursive |
| `read_directory_sorts_directories_before_files_case_insensitively` | Sort order |
| `read_directory_truncates_at_500_entries` | 500-entry cap + `truncated` flag |
| `read_directory_rejects_path_outside_workspace` | Listing sandbox escape blocked |
| `read_directory_rejects_file_as_path` | File-as-directory rejected |

The cron and session tests directly guard the audit fixes from earlier sessions — if someone refactors `parseCron` or `normalizeState` and breaks the behavior, CI catches it before merge.

---

## Adding a new test

1. Create `src/lib/<module>.test.ts` (or add to an existing test file).
2. Import from vitest: `import { describe, expect, it } from "vitest"`.
3. Write the test. Run locally: `npm test`.
4. Commit and push — CI picks it up automatically (the `include` glob in `vite.config.ts` is `src/**/*.{test,spec}.{ts,tsx}`).

For Rust, add `#[test]` functions inside the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/lib.rs`. Run locally with `cd src-tauri && cargo test`.

---

## Why no macOS / Linux backend job?

The backend job runs only on Windows because the codebase is Windows-first. Adding macOS and Linux jobs is straightforward when cross-platform work begins — duplicate the `backend` job with `runs-on: macos-latest` / `runs-on: ubuntu-latest` and gate the Windows-only code paths behind `cfg`. See [`docs/MACOS_CROSS_PLATFORM_HANDOFF.md`](MACOS_CROSS_PLATFORM_HANDOFF.md).

---

## Cost

GitHub Actions gives public repos **unlimited free minutes** for standard runners. The `ubuntu-latest` runner is free; the `windows-latest` runner is also free for public repos. The cargo cache keeps Windows runs fast after the first build, so typical usage is a few minutes per push. No billing concerns for an open-source project.

---

## Summary: the mental model

```
you push → GitHub sees .github/workflows/ci.yml
        → spins up 2 runners in parallel:
             ubuntu (frontend: tsc + vitest + vite build)
             windows (backend: cargo test + cargo build)
        → both must pass for a PR to merge (once branch protection is on)
        → if you push again, the old run is cancelled
```

That's it. The workflow file is the single source of truth — edit `.github/workflows/ci.yml` to change what runs.
