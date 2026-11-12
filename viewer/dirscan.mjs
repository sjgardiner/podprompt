// Filesystem directory discovery for the "+ New chat" destination picker.
//
// WHY THIS EXISTS. Both backends' listProjects() answer "which directories
// has a session ever run in" — claude-code scans ~/.claude/projects/*,
// opencode asks its server's /api/project. Neither can name a directory that
// has never hosted a session, so starting one somewhere new meant typing the
// path by hand, and a typo was not caught until the first prompt was already
// submitted (see driver.mjs's /prompt -> resolveValidCwd). This module is the
// other half: what the filesystem actually contains, right now.
//
// Deliberately dependency-free apart from node:fs/node:path — no SDK import,
// no backend import — so it can be unit-tested against a temp tree without
// standing anything up. Same arrangement as turn-binding.mjs and
// permission-channel.mjs.
//
// Both backends share one scan. That is not a shortcut: driver.mjs spawns
// `opencode serve` as its own child in this very container, so the two
// runtimes see the same filesystem, and cwdRoot is the same `args.cwd` for
// both (see driver.mjs's backendHooks). A per-backend scan would do identical
// work twice and could only ever differ by being stale.

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";

// Directories that are never a sensible place to start a session and are
// usually the bulk of the tree. Excluding them is what keeps a scan of a
// workspace full of checkouts cheap enough to run on every picker open.
export const DEFAULT_EXCLUDES = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build",
  "target", ".next", ".cache", ".mypy_cache", ".pytest_cache", ".tox",
]);

// Depth is counted from the root: depth 1 is an immediate child. Six is deep
// enough for the nested-monorepo shapes seen in practice without inviting a
// walk of somebody's data directory.
export const DEFAULT_MAX_DEPTH = 6;
// Caps the RESULT list. Hitting it sets `truncated`, which is the browser's
// signal to stop filtering locally and let the server do it instead (see the
// `q` option below).
//
// Measured against a real multi-repo workspace: the whole tree inside the
// exclude list is ~2000 directories and ~35ms to walk, so this is set well
// clear of that. The point is not to trim a normal workspace down to a
// readable list — the browser's own render cap does that, and filtering a
// complete list locally is both instant and exact. This only exists so a
// genuinely pathological tree degrades to server-side filtering instead of
// shipping a megabyte of JSON per picker open.
export const DEFAULT_MAX_ENTRIES = 5000;
// Caps the WORK. maxEntries alone does not: a narrow `q` matches almost
// nothing, so without this a filtered scan would still walk the entire tree
// on every keystroke before returning three rows.
export const DEFAULT_MAX_VISITED = 20000;

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// Separator-anchored, NOT a bare startsWith: "/workspace-other" starts with
// "/workspace" and is a sibling, not a child. Both backends already carry
// their own copy of this warning; this is now the one implementation they
// share.
export function isUnderOrEqual(candidate, root) {
  return candidate === root || candidate.startsWith(root + nodePath.sep);
}

function stripTrailingSep(p) {
  return p.length > 1 && p.endsWith(nodePath.sep) ? p.slice(0, -1) : p;
}

// Validates a browser-supplied destination against the workspace root. The
// single implementation behind BOTH backends' resolveValidCwd — they used to
// disagree in ways that each let something through: claude-code checked
// existsSync but never isDirectory (a FILE passed) and handed the candidate
// back verbatim (so a relative path was resolved against the driver process's
// cwd, not the root, and was then stored unnormalized); opencode resolved
// relative paths correctly but never checked existence AT ALL, so a typo was
// accepted here and only failed much deeper in.
//
// Returns the normalized ABSOLUTE path (not the realpath — a session keeps
// using the path the user actually asked for, which matters when /workspace
// is itself a mount or a link), or null.
//
// mustExist: false is for the create-it-first flow. A path that does not
// exist cannot be realpath'd, so containment is established against its
// nearest EXISTING ancestor instead; the components below that ancestor
// cannot be symlinks precisely because they do not exist yet. A plain
// path.resolve() containment check without that ancestor realpath would be
// fooled by "safe-looking/symlink-to-elsewhere/new-dir".
export function resolveUnderRoot(candidate, root, { mustExist = true } = {}) {
  if (!candidate || typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (!root || typeof root !== "string") return null;

  const base = stripTrailingSep(nodePath.resolve(root));
  // path.resolve handles both halves of the old disagreement at once: a
  // relative candidate is resolved against the ROOT (not process.cwd()), and
  // any "../" inside an absolute one is normalized away before it is tested.
  const abs = stripTrailingSep(nodePath.resolve(base, trimmed));
  if (!isUnderOrEqual(abs, base)) return null;

  const rootReal = safeRealpath(base);
  if (!rootReal) return null;

  if (mustExist) {
    let st;
    try {
      st = statSync(abs); // follows symlinks: a link TO a directory is fine
    } catch {
      return null;
    }
    if (!st.isDirectory()) return null;
    const real = safeRealpath(abs);
    if (!real || !isUnderOrEqual(real, rootReal)) return null;
    return abs;
  }

  let ancestor = abs;
  while (!existsSync(ancestor)) {
    const parent = nodePath.dirname(ancestor);
    if (parent === ancestor) return null; // walked off the top without finding one
    ancestor = parent;
  }
  let ancestorStat;
  try {
    ancestorStat = statSync(ancestor);
  } catch {
    return null;
  }
  // An existing ancestor that is a file means mkdir -p could never succeed.
  if (!ancestorStat.isDirectory()) return null;
  const ancestorReal = safeRealpath(ancestor);
  if (!ancestorReal || !isUnderOrEqual(ancestorReal, rootReal)) return null;
  return abs;
}

// Creates a destination the picker offered to create, then re-validates it
// the strict way. The second check is not paranoia for its own sake: between
// the resolve and the mkdir the path is somebody else's to change, and the
// value returned here is what a session is about to be pinned to.
export function createDirUnderRoot(candidate, root) {
  const abs = resolveUnderRoot(candidate, root, { mustExist: false });
  if (!abs) return null;
  try {
    mkdirSync(abs, { recursive: true });
  } catch {
    return null;
  }
  return resolveUnderRoot(abs, root, { mustExist: true });
}

// Breadth-first walk of the real directories under `root`.
//
// BFS rather than DFS specifically because of truncation: when the caps bite,
// what survives should be the shallow directories somebody is most likely to
// be looking for, not an exhaustive listing of whatever the first child
// happened to contain.
//
// `q` filters case-insensitively on the root-relative label and is applied to
// RESULTS only — the walk still descends through non-matching directories,
// because "viewer" matches a child of a directory that does not. That is the
// whole reason filtering is offered server-side at all: once a scan is
// truncated, filtering the truncated list in the browser can never find a
// match that the cap cut off.
//
// Returns { root, dirs: [{cwd, label}], truncated }. The root itself is
// always the first entry (labelled "(root)", matching both backends'
// projectLabelFor), because it is the one destination guaranteed to exist and
// the picker must always be able to offer it.
export function scanDirs(root, {
  maxDepth = DEFAULT_MAX_DEPTH,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxVisited = DEFAULT_MAX_VISITED,
  excludes = DEFAULT_EXCLUDES,
  includeHidden = false,
  q = "",
} = {}) {
  const base = stripTrailingSep(nodePath.resolve(root));
  const rootReal = safeRealpath(base);
  const needle = String(q || "").trim().toLowerCase();
  const excludeSet = excludes instanceof Set ? excludes : new Set(excludes || []);
  const dirs = [];
  let truncated = false;

  if (!rootReal) return { root: base, dirs, truncated };

  const matches = (label) => !needle || label.toLowerCase().includes(needle);
  const push = (cwd, label) => {
    if (!matches(label)) return;
    if (dirs.length >= maxEntries) {
      truncated = true;
      return;
    }
    dirs.push({ cwd, label });
  };

  push(base, "(root)");

  let visited = 1;
  let frontier = [base];

  for (let depth = 1; depth <= maxDepth && frontier.length && !truncated; depth++) {
    const next = [];
    for (const dir of frontier) {
      if (truncated) break;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable (permissions, vanished mid-scan) — not fatal
      }
      // Sorted so an identical tree always produces an identical list; the
      // browser sorts for display, but a stable server answer makes the
      // truncation boundary reproducible rather than readdir-order roulette.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (truncated) break;
        const name = entry.name;
        if (!includeHidden && name.startsWith(".")) continue;
        if (excludeSet.has(name)) continue;
        const full = nodePath.join(dir, name);
        // Symlinked directories are never listed and never descended into.
        // Both kinds are wrong to offer, for different reasons:
        //
        //   out of the tree — resolveUnderRoot refuses it, so the row could
        //                     not be chosen even if it were shown;
        //   back INTO the tree — the real directory is already listed under
        //                     its canonical path, and the two rows are NOT
        //                     interchangeable: claude-code keys a project's
        //                     session storage by the cwd STRING, so starting
        //                     one session via the alias and the next via the
        //                     real path splits one project's history in two.
        //
        // Skipping them also removes the only way this walk could revisit a
        // subtree, so no cycle/alias bookkeeping is needed. Typing an alias
        // by hand still works — resolveUnderRoot judges safety, this judges
        // what is worth offering.
        if (entry.isSymbolicLink()) continue;
        if (!entry.isDirectory()) continue;
        if (++visited > maxVisited) {
          truncated = true;
          break;
        }
        push(full, nodePath.relative(base, full));
        next.push(full);
      }
    }
    frontier = next;
  }

  return { root: base, dirs, truncated };
}
