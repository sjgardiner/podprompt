// Unit tests for the "+ New chat" destination scanner.
//
// Run: node viewer/dirscan.test.mjs
//
// THE BUGS THIS GUARDS. Before dirscan.mjs the two backends each carried
// their own resolveValidCwd, and each one let something through:
//
//   claude-code: existsSync() with no isDirectory() check (a FILE was a
//                valid destination), and the candidate was returned VERBATIM
//                — so a relative path was resolved against the driver
//                process's cwd rather than the workspace root, and whatever
//                came back was stored unnormalized.
//   opencode:    no existence check whatsoever. A typo was accepted here and
//                surfaced much later, from somewhere that could not say what
//                was actually wrong.
//
// Both now share one implementation, so these cases are tested once and hold
// for both backends. The containment cases matter most: that comparison is
// the only thing standing between the picker and starting a session in a
// foreign tree.
//
// Everything runs against a real temp tree — symlinks and permission bits do
// not survive being mocked, and they are exactly what is being checked.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { realpathSync } from "node:fs";
import {
  createDirUnderRoot, isUnderOrEqual, resolveUnderRoot, scanDirs,
} from "./dirscan.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

// realpath'd up front: on macOS /tmp is itself a symlink to /private/tmp, and
// a root that is not already canonical makes every containment assertion
// below ambiguous for reasons that have nothing to do with the code.
const tmp = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "dirscan-")));
const root = nodePath.join(tmp, "workspace");

mkdirSync(nodePath.join(root, "podprompt", "viewer", "backends"), { recursive: true });
mkdirSync(nodePath.join(root, "podprompt", "docs"), { recursive: true });
mkdirSync(nodePath.join(root, "other-project"), { recursive: true });
mkdirSync(nodePath.join(root, "podprompt", "node_modules", "junk"), { recursive: true });
mkdirSync(nodePath.join(root, ".hidden-dir"), { recursive: true });
writeFileSync(nodePath.join(root, "README.md"), "not a directory\n");

// A sibling of the root whose name shares the root's prefix. The entire
// point of the separator-anchored comparison.
const sibling = nodePath.join(tmp, "workspace-other");
mkdirSync(nodePath.join(sibling, "secrets"), { recursive: true });

// A symlink inside the root pointing OUT of it, and one pointing back in.
symlinkSync(sibling, nodePath.join(root, "escape-hatch"));
symlinkSync(nodePath.join(root, "podprompt"), nodePath.join(root, "alias-to-podprompt"));

try {
  // ── resolveUnderRoot: the containment boundary ─────────────────────────
  {
    check("the root itself is a valid destination",
      resolveUnderRoot(root, root) === root);
    check("a real subdirectory resolves to its absolute path",
      resolveUnderRoot(nodePath.join(root, "podprompt", "viewer"), root)
        === nodePath.join(root, "podprompt", "viewer"));

    // claude-code's old bug: this was resolved against process.cwd().
    check("a RELATIVE path resolves against the root, not process.cwd()",
      resolveUnderRoot("podprompt/viewer", root) === nodePath.join(root, "podprompt", "viewer"));
    check("a relative path with a leading ./ works too",
      resolveUnderRoot("./podprompt", root) === nodePath.join(root, "podprompt"));

    // opencode's old bug: no existence check at all.
    check("a path that does not exist is refused",
      resolveUnderRoot(nodePath.join(root, "no-such-dir"), root) === null);
    check("a typo'd subdirectory is refused",
      resolveUnderRoot("podprompt/veiwer", root) === null);

    // claude-code's other old bug: existsSync says yes to a file.
    check("a FILE is not a destination",
      resolveUnderRoot(nodePath.join(root, "README.md"), root) === null);

    check("the sibling directory sharing the root's prefix is refused",
      resolveUnderRoot(sibling, root) === null);
    check("a child of that sibling is refused",
      resolveUnderRoot(nodePath.join(sibling, "secrets"), root) === null);
    check("../ escaping the root is normalized and then refused",
      resolveUnderRoot(nodePath.join(root, "podprompt", "..", "..", "workspace-other"), root) === null);
    check("a relative ../ escape is refused",
      resolveUnderRoot("../workspace-other", root) === null);
    check("a symlink pointing out of the root is refused",
      resolveUnderRoot(nodePath.join(root, "escape-hatch"), root) === null);
    check("a symlink pointing back INSIDE the root is accepted",
      resolveUnderRoot(nodePath.join(root, "alias-to-podprompt"), root)
        === nodePath.join(root, "alias-to-podprompt"));

    check("empty input is refused", resolveUnderRoot("", root) === null);
    check("whitespace-only input is refused", resolveUnderRoot("   ", root) === null);
    check("a non-string is refused", resolveUnderRoot(42, root) === null);
    check("a trailing slash does not change the answer",
      resolveUnderRoot(nodePath.join(root, "podprompt") + "/", root)
        === nodePath.join(root, "podprompt"));
  }

  // ── resolveUnderRoot(mustExist:false): the create-it-first path ─────────
  {
    check("a not-yet-existing path under the root is allowed",
      resolveUnderRoot(nodePath.join(root, "brand-new"), root, { mustExist: false })
        === nodePath.join(root, "brand-new"));
    check("a deep not-yet-existing path is allowed",
      resolveUnderRoot("podprompt/viewer/new/deeper", root, { mustExist: false })
        === nodePath.join(root, "podprompt", "viewer", "new", "deeper"));
    check("a not-yet-existing path OUTSIDE the root is still refused",
      resolveUnderRoot(nodePath.join(sibling, "brand-new"), root, { mustExist: false }) === null);
    // The case a plain path.resolve() containment check cannot see: every
    // component is lexically under the root, but the existing ancestor is a
    // symlink out of it.
    check("a new dir UNDER an escaping symlink is refused",
      resolveUnderRoot(nodePath.join(root, "escape-hatch", "brand-new"), root,
        { mustExist: false }) === null);
    check("a new dir under a file is refused",
      resolveUnderRoot(nodePath.join(root, "README.md", "nope"), root,
        { mustExist: false }) === null);
  }

  // ── createDirUnderRoot ─────────────────────────────────────────────────
  {
    const made = createDirUnderRoot("fresh/nested/dir", root);
    check("creating a nested destination returns its absolute path",
      made === nodePath.join(root, "fresh", "nested", "dir"), made);
    check("the created destination now validates strictly",
      resolveUnderRoot("fresh/nested/dir", root) === nodePath.join(root, "fresh", "nested", "dir"));
    check("creating outside the root creates nothing and returns null",
      createDirUnderRoot(nodePath.join(sibling, "made-by-mistake"), root) === null);
    check("creating under an escaping symlink returns null",
      createDirUnderRoot(nodePath.join(root, "escape-hatch", "made"), root) === null);
    check("creating an EXISTING directory is a no-op that still succeeds",
      createDirUnderRoot("podprompt", root) === nodePath.join(root, "podprompt"));
    check("creating over an existing FILE fails",
      createDirUnderRoot("README.md", root) === null);
  }

  // ── scanDirs: what the picker is handed ────────────────────────────────
  {
    const { dirs, truncated, root: reported } = scanDirs(root);
    const labels = dirs.map((d) => d.label);
    check("the scan reports the normalized root", reported === root, reported);
    check("the root is always offered, and first",
      labels[0] === "(root)" && dirs[0].cwd === root, labels.slice(0, 3));
    check("an untruncated scan says so", truncated === false);
    check("a nested directory is found",
      labels.includes(nodePath.join("podprompt", "viewer", "backends")), labels);
    check("a sibling project at the top level is found",
      labels.includes("other-project"), labels);
    check("node_modules is excluded", !labels.some((l) => l.includes("node_modules")), labels);
    check("hidden directories are excluded by default",
      !labels.some((l) => l.includes(".hidden-dir")), labels);
    check("a plain file is not listed",
      !labels.some((l) => l.includes("README.md")), labels);
    check("a symlink escaping the root is not listed",
      !labels.some((l) => l.includes("escape-hatch")), labels);
    // An alias and its target are not interchangeable destinations —
    // claude-code keys session storage by the cwd string — so only the
    // canonical path is offered, and the alias must not shadow it.
    check("a symlink to a directory INSIDE the root is not listed",
      !labels.some((l) => l.includes("alias-to-podprompt")), labels);
    check("the aliased directory itself is still listed under its real path",
      labels.includes("podprompt"), labels);
    check("every listed directory is one resolveUnderRoot would accept",
      dirs.every((d) => resolveUnderRoot(d.cwd, root) === d.cwd),
      dirs.filter((d) => resolveUnderRoot(d.cwd, root) !== d.cwd));
    check("hidden directories can be opted back in",
      scanDirs(root, { includeHidden: true }).dirs.some((d) => d.label === ".hidden-dir"));
  }

  // ── scanDirs: the caps, and why BFS ────────────────────────────────────
  {
    const shallow = scanDirs(root, { maxDepth: 1 });
    check("maxDepth 1 lists only immediate children (plus the root)",
      shallow.dirs.every((d) => d.label === "(root)" || !d.label.includes(nodePath.sep)),
      shallow.dirs.map((d) => d.label));
    check("maxDepth 1 still finds the top-level projects",
      shallow.dirs.some((d) => d.label === "podprompt")
        && shallow.dirs.some((d) => d.label === "other-project"));

    const capped = scanDirs(root, { maxEntries: 3 });
    check("maxEntries caps the result list", capped.dirs.length === 3, capped.dirs.length);
    check("hitting the cap reports truncated", capped.truncated === true);
    // BFS: what survives a cap is the shallow rows, not one deep branch.
    check("a truncated scan keeps the SHALLOWEST rows",
      capped.dirs.every((d) => d.label === "(root)" || !d.label.includes(nodePath.sep)),
      capped.dirs.map((d) => d.label));

    const workCapped = scanDirs(root, { maxVisited: 2 });
    check("maxVisited bounds the walk even when few rows match",
      workCapped.truncated === true);
  }

  // ── scanDirs: server-side filtering ────────────────────────────────────
  {
    const hits = scanDirs(root, { q: "backends" });
    check("a filter returns the matching row",
      hits.dirs.some((d) => d.label === nodePath.join("podprompt", "viewer", "backends")),
      hits.dirs.map((d) => d.label));
    check("a filter excludes non-matching rows",
      !hits.dirs.some((d) => d.label === "other-project"), hits.dirs.map((d) => d.label));
    check("filtering is case-insensitive",
      scanDirs(root, { q: "BACKENDS" }).dirs.length === hits.dirs.length);
    // The reason filtering is offered server-side at all: a match that lives
    // below a non-matching parent is only reachable if the walk descends
    // through directories it will never return.
    check("a filter still descends through non-matching parents",
      scanDirs(root, { q: "viewer" }).dirs.some(
        (d) => d.label === nodePath.join("podprompt", "viewer")));
    check("a filter matching nothing returns nothing",
      scanDirs(root, { q: "zzz-no-such-thing" }).dirs.length === 0);
  }

  // ── isUnderOrEqual, directly ───────────────────────────────────────────
  {
    check("a path equal to the root is under it", isUnderOrEqual("/workspace", "/workspace"));
    check("a child is under the root", isUnderOrEqual("/workspace/a", "/workspace"));
    check("a prefix-sharing sibling is NOT under the root",
      !isUnderOrEqual("/workspace-other", "/workspace"));
    check("a prefix-sharing sibling's child is NOT under the root",
      !isUnderOrEqual("/workspace-other/a", "/workspace"));
  }

  // ── A missing root is survivable, not fatal ────────────────────────────
  {
    const gone = scanDirs(nodePath.join(tmp, "no-such-root"));
    check("scanning a nonexistent root returns an empty list, not a throw",
      gone.dirs.length === 0 && gone.truncated === false);
    check("a nonexistent root resolves nothing",
      resolveUnderRoot("anything", nodePath.join(tmp, "no-such-root")) === null);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`new-chat destination scanner: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
