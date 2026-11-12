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
// Both backends share one listing. That is not a shortcut: driver.mjs spawns
// `opencode serve` as its own child in this very container, so the two
// runtimes see the same filesystem, and cwdRoot is the same `args.cwd` for
// both (see driver.mjs's backendHooks). A per-backend listing would do
// identical work twice and could only ever differ by being stale.
//
// ONE LEVEL AT A TIME. This started out as a recursive walk of the whole
// workspace, which worked and was fast (~2000 directories in ~35ms) and was
// still wrong: it answered a question nobody asked. A picker offering every
// directory six levels down is not more helpful than one offering the four
// you actually keep projects in — it is a wall of paths to read past. So the
// listing is now per-directory, the browser asks for the next level when the
// typed path gains a "/", and everything that existed to survive a recursive
// walk (entry caps, a visit budget, truncation signalling, a server-side
// filter) went with it. A readdir of one directory needs none of that.

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";

// Directories that are never a sensible place to start a session. Short on
// purpose now that only one level is ever listed: this is about not putting
// `node_modules` in front of someone, not about keeping a walk affordable.
export const DEFAULT_EXCLUDES = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build",
  "target", ".next", ".cache", ".mypy_cache", ".pytest_cache", ".tox",
]);

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

// The immediate subdirectories of ONE directory — `scope`, given relative to
// the root ("" being the root itself).
//
// Returns:
//   {
//     root:   "/workspace",                       the boundary, normalized
//     scope:  { cwd, label, parent },             where this listing is of
//     dirs:   [{ cwd, name, label }],             its immediate children
//   }
// or null if `scope` is not a real directory under the root — the caller
// turns that into a 404 rather than quietly listing somewhere else, which
// would silently relocate the session someone was about to start.
//
// `name` is the bare directory name (what a row shows, since the path above
// it is already in the filter box) and `label` is the full root-relative path
// (what gets typed, compared and created). `parent` is the scope's own
// root-relative parent, or null at the root.
//
// `includeHidden` exists because the browser asks for it the moment the user
// types a leading dot, which is how shells have always behaved: dotfolders
// stay out of the way until you say the word.
export function listDirs(root, scope = "", { excludes = DEFAULT_EXCLUDES, includeHidden = false } = {}) {
  const base = stripTrailingSep(nodePath.resolve(root));
  const scopeAbs = resolveUnderRoot(scope === "" ? base : scope, base);
  if (!scopeAbs) return null;

  const excludeSet = excludes instanceof Set ? excludes : new Set(excludes || []);
  const dirs = [];

  let entries = [];
  try {
    entries = readdirSync(scopeAbs, { withFileTypes: true });
  } catch {
    // Unreadable (permissions, or it vanished between the resolve and here).
    // An empty listing, not a failure: the scope itself is still a valid
    // place to start a session, and the picker still offers it.
    entries = [];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const name = entry.name;
    if (!includeHidden && name.startsWith(".")) continue;
    if (excludeSet.has(name)) continue;
    // Symlinked directories are never listed. Both kinds are wrong to offer,
    // for different reasons:
    //
    //   out of the tree — resolveUnderRoot refuses it, so the row could not
    //                     be chosen even if it were shown;
    //   back INTO the tree — the real directory is already reachable under
    //                     its canonical path, and the two are NOT
    //                     interchangeable: claude-code keys a project's
    //                     session storage by the cwd STRING, so starting one
    //                     session via the alias and the next via the real
    //                     path splits one project's history in two.
    //
    // Typing an alias by hand still works — resolveUnderRoot judges safety,
    // this judges what is worth offering.
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    const full = nodePath.join(scopeAbs, name);
    dirs.push({ cwd: full, name, label: nodePath.relative(base, full) });
  }

  const scopeLabel = nodePath.relative(base, scopeAbs);
  return {
    root: base,
    scope: {
      cwd: scopeAbs,
      // "(root)" matches what both backends' projectLabelFor calls it, so the
      // same directory never reads two different ways across the UI.
      label: scopeLabel || "(root)",
      parent: scopeAbs === base ? null : nodePath.relative(base, nodePath.dirname(scopeAbs)),
    },
    dirs,
  };
}
