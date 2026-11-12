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

import {
  chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import {
  createDirUnderRoot, isUnderOrEqual, listDirs, resolveUnderRoot,
} from "./dirscan.mjs";

// Whether this process can read a directory regardless of its mode — true
// when running as root, which makes the permissions test meaningless.
function readableAnyway(dir) {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

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

  // ── listDirs: ONE level, which is the whole point ──────────────────────
  {
    const top = listDirs(root);
    const names = top.dirs.map((d) => d.name);
    check("the listing reports the normalized root", top.root === root, top.root);
    check("the root scope is labelled the way both backends label it",
      top.scope.label === "(root)" && top.scope.cwd === root, top.scope);
    check("the root has no parent to go up to", top.scope.parent === null, top.scope);

    check("top-level directories are listed", names.includes("podprompt"), names);
    check("...and so are their siblings", names.includes("other-project"), names);
    // THE REGRESSION THIS WHOLE REWRITE IS: a recursive scan put every
    // directory six levels down in front of someone who asked for a project.
    check("NOTHING below the top level is listed",
      !names.includes("viewer") && !names.includes("backends") && !names.includes("docs"),
      names);
    check("rows are ordered", names.join(",") === [...names].sort().join(","), names);

    check("node_modules is excluded", !names.includes("node_modules"), names);
    check("hidden directories are not offered unasked",
      !names.includes(".hidden-dir"), names);
    check("a plain file is not listed", !names.includes("README.md"), names);
    check("a symlink escaping the root is not listed",
      !names.includes("escape-hatch"), names);
    // An alias and its target are not interchangeable destinations —
    // claude-code keys session storage by the cwd string — so only the
    // canonical path is offered, and the alias must not shadow it.
    check("a symlink to a directory INSIDE the root is not listed",
      !names.includes("alias-to-podprompt"), names);
    check("the aliased directory itself is still listed under its real path",
      names.includes("podprompt"), names);

    check("every listed directory is one resolveUnderRoot would accept",
      top.dirs.every((d) => resolveUnderRoot(d.cwd, root) === d.cwd),
      top.dirs.filter((d) => resolveUnderRoot(d.cwd, root) !== d.cwd));
    check("a row carries both what it shows and what it means",
      top.dirs.every((d) => d.name && d.label && d.cwd),
      top.dirs[0]);
    check("at the top level, name and label are the same thing",
      top.dirs.every((d) => d.name === d.label), top.dirs);

    // Shell behaviour: dotfolders stay out of the way until you say the word.
    check("hidden directories can be asked for",
      listDirs(root, "", { includeHidden: true }).dirs.some((d) => d.name === ".hidden-dir"));
    check("...and asking for them does not also unhide the exclude list",
      !listDirs(root, "", { includeHidden: true }).dirs.some((d) => d.name === ".git"));
  }

  // ── listDirs: descending ───────────────────────────────────────────────
  {
    const scoped = listDirs(root, "podprompt");
    const names = scoped.dirs.map((d) => d.name);
    check("descending lists that directory's own children",
      names.includes("viewer") && names.includes("docs"), names);
    check("...and not its parent's", !names.includes("other-project"), names);
    check("...and still not its grandchildren", !names.includes("backends"), names);
    check("the scope reports where it is",
      scoped.scope.label === "podprompt" && scoped.scope.cwd === nodePath.join(root, "podprompt"),
      scoped.scope);
    check("the scope knows the way back up", scoped.scope.parent === "", scoped.scope);
    check("a row shows its bare name",
      scoped.dirs.find((d) => d.name === "viewer").name === "viewer");
    check("...but means its full path from the root",
      scoped.dirs.find((d) => d.name === "viewer").label === nodePath.join("podprompt", "viewer"));

    const deeper = listDirs(root, nodePath.join("podprompt", "viewer"));
    check("two levels down still works",
      deeper.dirs.map((d) => d.name).includes("backends"), deeper.dirs);
    check("a deeper scope's parent is its real parent",
      deeper.scope.parent === "podprompt", deeper.scope);

    const absolute = listDirs(root, nodePath.join(root, "podprompt"));
    check("an absolute scope under the root works the same as a relative one",
      JSON.stringify(absolute) === JSON.stringify(scoped));

    const leaf = listDirs(root, nodePath.join("podprompt", "docs"));
    check("a directory with no subdirectories lists nothing, and is not an error",
      leaf !== null && leaf.dirs.length === 0, leaf);
  }

  // ── listDirs: a scope is validated, never guessed ──────────────────────
  {
    check("a scope that does not exist is refused",
      listDirs(root, "no-such-dir") === null);
    check("a scope outside the root is refused", listDirs(root, "/etc") === null);
    check("a scope escaping via ../ is refused",
      listDirs(root, "podprompt/../../workspace-other") === null);
    check("the prefix-sharing sibling is refused as a scope",
      listDirs(root, sibling) === null);
    check("a FILE is not a scope", listDirs(root, "README.md") === null);
    check("an escaping symlink is not a scope",
      listDirs(root, "escape-hatch") === null);
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
    const missingRoot = nodePath.join(tmp, "no-such-root");
    check("listing a nonexistent root refuses rather than throwing",
      listDirs(missingRoot) === null);
    check("a nonexistent root resolves nothing",
      resolveUnderRoot("anything", missingRoot) === null);
  }

  // ── An unreadable directory is empty, not broken ───────────────────────
  //
  // The scope itself is still a perfectly good place to start a session, so
  // failing the whole listing because its children cannot be enumerated
  // would take away the one thing that still works.
  {
    const locked = nodePath.join(root, "locked");
    mkdirSync(locked, { recursive: true });
    try {
      chmodSync(locked, 0o000);
      const result = listDirs(root, "locked");
      // Running as root defeats the point of the test — permissions do not
      // apply, so skip rather than assert something untrue.
      if (readableAnyway(locked)) {
        check("(skipped: this process can read a 0o000 directory)", true);
      } else {
        check("an unreadable scope lists nothing but still resolves",
          result !== null && result.dirs.length === 0, result);
        check("...and still reports itself as a destination",
          result.scope.cwd === locked, result && result.scope);
      }
    } finally {
      chmodSync(locked, 0o700);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`new-chat destination scanner: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
