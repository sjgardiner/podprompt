// Unit tests for the "+ New chat" destination picker's wiring.
//
// Run: node viewer/new-chat-picker.test.mjs
//
// The boundary itself (which paths are acceptable, what one level contains)
// is dirscan.test.mjs's job and is tested against a real temp tree there.
// This file covers the two halves that module cannot see:
//
//   driver.mjs — that /dirs is routed, lists ONE level under ?under=, is NOT
//                keyed by ?backend= (one filesystem, one answer — a
//                per-backend variant would be a second source of truth for
//                the same question), and says 404 rather than quietly
//                listing somewhere else.
//   viewer.html — which row Enter takes, and whether the two meanings a
//                folder row carries ("start here" vs "look inside") can ever
//                be confused for one another. That is the whole design, and
//                asserting it by regex would be asserting the shape of the
//                code rather than what it does — so renderDestinations is
//                lifted out and actually executed against a DOM stub.
//
// Both files are read at run time, so there is no copy to drift.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const html = readFileSync(new URL("./viewer.html", import.meta.url), "utf8");
const src = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");

function bodyOf(text, name) {
  const i = text.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`no longer defines ${name}()`);
  let parens = 0, open = -1;
  for (let k = text.indexOf("(", i); k < text.length; k++) {
    if (text[k] === "(") parens++;
    else if (text[k] === ")" && --parens === 0) { open = text.indexOf("{", k); break; }
  }
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === "{") depth++;
    else if (text[k] === "}" && --depth === 0) return text.slice(i, k + 1);
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

// ── A DOM stub, so the shipped render code can actually run ────────────────
const stubDocument = {
  createElement(tag) {
    const el = {
      tagName: tag,
      children: [],
      className: '',
      title: '',
      listeners: {},
      _text: '',
      _html: '',
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      appendChild(child) { el.children.push(child); return child; },
      addEventListener(ev, fn) { (el.listeners[ev] = el.listeners[ev] || []).push(fn); },
      scrollIntoView() {},
      setAttribute() {},
      focus() {},
      get textContent() { return el._text; },
      set textContent(v) { el._text = String(v); },
      get innerHTML() { return el._html; },
      set innerHTML(v) { el._html = v; el.children.length = 0; },
    };
    return el;
  },
};

// Fires a listener the shipped code registered, with an event object real
// enough for what that code does with it.
function fire(el, ev) {
  let stopped = false;
  const event = { stopPropagation() { stopped = true; }, preventDefault() {} };
  for (const fn of (el.listeners[ev] || [])) fn(event);
  return stopped;
}

const SHIPPED = [
  bodyOf(html, 'newChatFilterValue'),
  bodyOf(html, 'splitTypedPath'),
  bodyOf(html, 'setActiveRow'),
  bodyOf(html, 'newChatNote'),
  bodyOf(html, 'newChatSectionLabel'),
  bodyOf(html, 'chooseDestination'),
  bodyOf(html, 'descendInto'),
  bodyOf(html, 'newChatRow'),
  bodyOf(html, 'renderDestinations'),
].join('\n');

const REAL_RENDER_LIMIT = Number(/const NEW_CHAT_RENDER_LIMIT = (\d+);/.exec(html)[1]);
const ROOT = '/workspace';
const scopeOf = (label) => ({
  cwd: label === '(root)' ? ROOT : `${ROOT}/${label}`,
  label,
  parent: label === '(root)' ? null : '',
});
const childrenOf = (scopeLabel, ...names) => names.map((n) => ({
  cwd: scopeLabel === '(root)' ? `${ROOT}/${n}` : `${ROOT}/${scopeLabel}/${n}`,
  name: n,
  label: scopeLabel === '(root)' ? n : `${scopeLabel}/${n}`,
}));

function run({
  typed = '',
  scope = scopeOf('(root)'),
  children = [],
  recents = [],
  currentCwd = null,
  renderLimit = REAL_RENDER_LIMIT,
} = {}) {
  const started = [];
  const created = [];
  const rescoped = [];
  const destList = stubDocument.createElement('div');
  const filterInput = { value: typed, focus() {} };
  const api = new Function('document', 'deps', `
    let newChatRoot = deps.root;
    let newChatScope = deps.scope;
    let newChatChildren = deps.children;
    let newChatRecents = deps.recents;
    let newChatCurrentCwd = deps.currentCwd;
    let newChatRows = [];
    let newChatActiveIndex = 0;
    let newChatDestList = deps.destList;
    let newChatFilterInput = deps.filterInput;
    let newChatSelectedBackend = 'claude-code';
    const NEW_CHAT_RENDER_LIMIT = deps.renderLimit;
    const startNewChatInProject = (...a) => deps.started.push(a);
    const createDestinationAndStart = (p) => deps.created.push(p);
    // The real one refetches the level; here it just records that the box
    // was re-read, which is the contract descendInto actually depends on.
    const onNewChatFilterChanged = () => deps.rescoped.push(deps.filterInput.value);
    ${SHIPPED}
    renderDestinations();
    return {
      rows: () => newChatRows,
      active: () => newChatActiveIndex,
      move: (n) => setActiveRow(newChatActiveIndex + n),
      enter: () => newChatRows[newChatActiveIndex] && newChatRows[newChatActiveIndex].choose(),
      tab: () => {
        const r = newChatRows[newChatActiveIndex];
        return r && r.descend ? (r.descend(), true) : false;
      },
    };
  `)(stubDocument, {
    root: ROOT, scope, children, recents, currentCwd, destList, filterInput,
    renderLimit, started, created, rescoped,
  });
  const rowEls = () => destList.children.filter((c) => /new-chat-project-item/.test(c.className));
  const textOf = (el) => el.children.map((c) => c._text).join(' ').trim();
  return { ...api, started, created, rescoped, destList, filterInput, rowEls, textOf };
}

// ── splitTypedPath: where the scope ends and the match begins ──────────────
{
  const split = new Function(`${bodyOf(html, 'splitTypedPath')}; return splitTypedPath;`)();
  const eq = (input, scope, segment) =>
    check(`"${input}" splits into ${JSON.stringify(scope)} + ${JSON.stringify(segment)}`,
      split(input).scope === scope && split(input).segment === segment, split(input));

  eq('', '', '');
  eq('pod', '', 'pod');
  eq('podprompt/', 'podprompt', '');
  eq('podprompt/vie', 'podprompt', 'vie');
  eq('podprompt/viewer/back', 'podprompt/viewer', 'back');
  // A leading slash means the workspace root, not the filesystem root —
  // everything in this picker is relative to the workspace.
  eq('/podprompt', '', 'podprompt');
  eq('/podprompt/vie', 'podprompt', 'vie');
}

// ── The root level, with nothing typed ─────────────────────────────────────
{
  const r = run({
    scope: scopeOf('(root)'),
    children: childrenOf('(root)', 'GENIE', 'analysis', 'podprompt'),
    recents: [
      { cwd: `${ROOT}/podprompt`, label: 'podprompt', isCurrent: true },
      { cwd: `${ROOT}/podprompt/viewer`, label: 'podprompt/viewer', isCurrent: false },
    ],
    currentCwd: `${ROOT}/podprompt`,
  });

  check("the current project is the row Enter takes", r.active() === 0);
  check("...and it says so", r.textOf(r.rowEls()[0]).startsWith('podprompt (current)'),
    r.textOf(r.rowEls()[0]));
  r.enter();
  check("Enter on it starts a session there",
    JSON.stringify(r.started) === JSON.stringify([[`${ROOT}/podprompt`, 'claude-code']]), r.started);

  const texts = r.rowEls().map(r.textOf);
  check("a recent two levels down is offered without descending",
    texts.some((t) => t.startsWith('podprompt/viewer')), texts);
  check("the root itself is offered as a destination",
    texts.some((t) => t.includes('(root)') && t.includes('start here')), texts);
  check("top-level folders are listed", texts.some((t) => t.startsWith('GENIE')), texts);
  check("the two groups are labelled",
    r.destList.children.filter((c) => c.className === 'new-chat-section-label')
      .map((c) => c._text).join(',') === 'Recent,Workspace',
    r.destList.children.map((c) => c.className));
}

// ── The two meanings of a folder row ───────────────────────────────────────
{
  const make = () => run({
    scope: scopeOf('(root)'),
    children: childrenOf('(root)', 'GENIE', 'podprompt'),
  });

  {
    // Row 0 is the scope ("start here" for the root), so the first real
    // folder is row 1.
    const r = make();
    r.move(1);
    const row = r.rowEls()[1];
    check("a folder row shows its bare name", r.textOf(row).startsWith('GENIE'), r.textOf(row));
    fire(row, 'click');
    check("clicking the row starts a session in it",
      JSON.stringify(r.started) === JSON.stringify([[`${ROOT}/GENIE`, 'claude-code']]), r.started);
    check("...and does not descend", r.rescoped.length === 0, r.rescoped);
  }

  {
    const r = make();
    const row = r.rowEls()[1];
    const chevron = row.children.find((c) => c.className === 'new-chat-chevron');
    check("a folder row carries a chevron", !!chevron, row.children.map((c) => c.className));
    const stopped = fire(chevron, 'click');
    // Without stopPropagation the row's own click handler also runs, and the
    // click that asked to look INSIDE a folder starts a session in it instead.
    check("the chevron stops the row's own click from also firing", stopped === true);
    check("clicking the chevron re-scopes to that folder",
      r.filterInput.value === 'GENIE/', r.filterInput.value);
    check("...by re-reading the box, not by a second source of truth",
      JSON.stringify(r.rescoped) === JSON.stringify(['GENIE/']), r.rescoped);
    check("...and starts nothing", r.started.length === 0, r.started);
  }

  {
    const r = make();
    r.move(1);
    check("Tab descends into the highlighted row", r.tab() === true);
    check("...to the same place the chevron would", r.filterInput.value === 'GENIE/', r.filterInput.value);
  }

  {
    // The scope row is a destination only. Descending into where you already
    // are is not a thing, and Tab must not pretend otherwise.
    const r = make();
    check("the scope row has nothing to descend into", r.tab() === false);
    check("the scope row carries no chevron",
      !r.rowEls()[0].children.some((c) => c.className === 'new-chat-chevron'),
      r.rowEls()[0].children.map((c) => c.className));
  }
}

// ── Inside a folder ────────────────────────────────────────────────────────
{
  const r = run({
    typed: 'podprompt/',
    scope: scopeOf('podprompt'),
    children: childrenOf('podprompt', 'docs', 'extras', 'viewer'),
  });
  const texts = r.rowEls().map(r.textOf);
  check("the scope row names where you are",
    texts[0].startsWith('podprompt') && texts[0].includes('start here'), texts[0]);
  check("Enter accepts the directory you navigated to", r.active() === 0);
  r.enter();
  check("...starting a session in it",
    JSON.stringify(r.started) === JSON.stringify([[`${ROOT}/podprompt`, 'claude-code']]), r.started);
  check("its children are listed by bare name",
    texts.slice(1).map((t) => t.split(' ')[0]).join(',') === 'docs,extras,viewer', texts);
  check("recents are not repeated once you have navigated",
    !r.destList.children.some((c) => c._text === 'Recent'),
    r.destList.children.map((c) => c._text));

  const chevron = r.rowEls()[3].children.find((c) => c.className === 'new-chat-chevron');
  fire(chevron, 'click');
  check("descending twice builds the path up",
    r.filterInput.value === 'podprompt/viewer/', r.filterInput.value);
}

// ── Matching within a level ────────────────────────────────────────────────
{
  const inside = (typed) => run({
    typed,
    scope: scopeOf('podprompt'),
    children: childrenOf('podprompt', 'docs', 'extras', 'preview', 'viewer'),
  });

  {
    const r = inside('podprompt/doc');
    check("typing narrows to matches", r.rowEls().length === 1, r.rowEls().map(r.textOf));
    check("...and the scope row steps aside while you are matching",
      !r.rowEls().some((el) => r.textOf(el).includes('start here')), r.rowEls().map(r.textOf));
    r.enter();
    check("Enter takes the match", r.started[0][0] === `${ROOT}/podprompt/docs`, r.started);
  }

  {
    // "vie" is in both "viewer" and "preview". Enter should land on the one
    // that STARTS with it — that is what someone typing a name is doing.
    const r = inside('podprompt/vie');
    check("both substring matches are offered", r.rowEls().length === 2, r.rowEls().map(r.textOf));
    check("a prefix match sorts above a mid-string one",
      r.textOf(r.rowEls()[0]).startsWith('viewer'), r.rowEls().map(r.textOf));
    r.enter();
    check("...so Enter takes the prefix match",
      r.started[0][0] === `${ROOT}/podprompt/viewer`, r.started);
  }
  {
    const r = inside('podprompt/VIEW');
    check("matching is case-insensitive",
      r.rowEls().length === 2 && r.textOf(r.rowEls()[0]).startsWith('viewer'),
      r.rowEls().map(r.textOf));
  }
  {
    const r = inside('podprompt/e');
    check("a mid-string match still matches",
      r.rowEls().map(r.textOf).some((t) => t.startsWith('preview')), r.rowEls().map(r.textOf));
  }
}

// ── Creating what isn't there ──────────────────────────────────────────────
{
  {
    const r = run({
      typed: 'podprompt/brand-new',
      scope: scopeOf('podprompt'),
      children: childrenOf('podprompt', 'docs', 'viewer'),
    });
    check("an unmatched name offers to create it", r.rowEls().length === 1, r.rowEls().map(r.textOf));
    check("the offer names the FULL path, not just what was typed",
      r.textOf(r.rowEls()[0]).includes('podprompt/brand-new'), r.textOf(r.rowEls()[0]));
    check("the create row is visually distinct",
      r.rowEls()[0].className.includes('new-chat-create-item'), r.rowEls()[0].className);
    r.enter();
    check("Enter routes it to creation, not straight to a session",
      r.created.length === 1 && r.started.length === 0, { c: r.created, s: r.started });
    check("creation is asked for with the full path",
      r.created[0] === 'podprompt/brand-new', r.created);
  }

  {
    // THE BUG THIS GUARDS, found in review: the create row's action used to
    // be patched onto the row object AFTER the element had been built, so it
    // only reached the keyboard. The element's own click listener still held
    // the default "start a session in `cwd`" — and `cwd` was null, so a
    // MOUSE click on "Create …" created nothing and silently started the
    // session in the default project instead.
    const r = run({
      typed: 'podprompt/brand-new',
      scope: scopeOf('podprompt'),
      children: childrenOf('podprompt', 'docs'),
    });
    fire(r.rowEls()[0], 'click');
    check("CLICKING the create row creates, exactly as Enter does",
      r.created.length === 1 && r.started.length === 0, { c: r.created, s: r.started });
    check("...with the same path",
      r.created[0] === 'podprompt/brand-new', r.created);
  }

  {
    // THE INVARIANT. While any real folder still matches, the create row is
    // not built at all — so Enter cannot make a directory by accident.
    const r = run({
      typed: 'podprompt/vie',
      scope: scopeOf('podprompt'),
      children: childrenOf('podprompt', 'viewer'),
    });
    check("a matching filter offers nothing to create",
      !r.rowEls().some((el) => r.textOf(el).includes('Create')), r.rowEls().map(r.textOf));
  }

  {
    // The scope itself doesn't exist — a path typed several levels past
    // anything real. There is nothing to list, but the path is still a
    // perfectly good thing to ask for.
    const r = run({ typed: 'brand/new/tree', scope: null });
    check("a path below a nonexistent parent still offers creation",
      r.rowEls().length === 1 && r.textOf(r.rowEls()[0]).includes('brand/new/tree'),
      r.rowEls().map(r.textOf));
    r.enter();
    check("...and creates the whole path", r.created[0] === 'brand/new/tree', r.created);
  }

  {
    const r = run({ typed: 'brand/new/tree/', scope: null });
    check("a trailing slash is not part of what gets created",
      r.created.length === 0 && r.textOf(r.rowEls()[0]).includes('brand/new/tree'),
      r.textOf(r.rowEls()[0]));
    r.enter();
    check("...confirmed when it is actually asked for", r.created[0] === 'brand/new/tree', r.created);
  }

  {
    const r = run({ typed: '', scope: null });
    check("an empty box with no scope offers nothing to create",
      r.rowEls().length === 0, r.rowEls().map(r.textOf));
  }
}

// ── No level to show at all ────────────────────────────────────────────────
//
// Either the root became unreadable, or this viewer is talking to a
// driver.mjs too old to have /dirs. The backend's own project history is a
// separate route and still answers, so the picker falls back to exactly what
// it offered before /dirs existed rather than to nothing.
{
  const r = run({
    typed: '',
    scope: null,
    recents: [
      { cwd: `${ROOT}/podprompt`, label: 'podprompt', isCurrent: true },
      { cwd: `${ROOT}/analysis`, label: 'analysis', isCurrent: false },
    ],
  });
  check("with no level, known projects are still offered",
    r.rowEls().length === 2, r.rowEls().map(r.textOf));
  r.enter();
  check("...and are still startable",
    r.started[0][0] === `${ROOT}/podprompt`, r.started);
  check("...with nothing to descend into, since there is no level to descend in",
    r.tab() === false);

  const bare = run({ typed: '', scope: null, recents: [] });
  check("with neither a level nor any history, the picker says so",
    bare.rowEls().length === 0
      && bare.destList.children.some((c) => c._text === 'No such directory.'),
    bare.destList.children.map((c) => c._text));
}

// ── An empty directory is still a destination ──────────────────────────────
{
  const r = run({ typed: 'podprompt/docs/', scope: scopeOf('podprompt/docs'), children: [] });
  check("a folder with no subfolders still offers itself",
    r.rowEls().length === 1 && r.textOf(r.rowEls()[0]).includes('start here'),
    r.rowEls().map(r.textOf));
  r.enter();
  check("...and Enter starts a session there",
    r.started[0][0] === `${ROOT}/podprompt/docs`, r.started);
}

// ── Caps and clamping ──────────────────────────────────────────────────────
{
  const many = Array.from({ length: 500 }, (_, i) => `d${String(i).padStart(3, '0')}`);
  const r = run({
    typed: 'podprompt/',
    scope: scopeOf('podprompt'),
    children: childrenOf('podprompt', ...many),
    renderLimit: 10,
  });
  check("rendering stops at the cap", r.rowEls().length === 11 /* scope row + 10 */,
    r.rowEls().length);
  check("the held-back count is reported",
    r.destList.children.some((c) => c._text === '490 more folders not shown — keep typing to narrow.'),
    r.destList.children.map((c) => c._text));

  const narrowed = run({
    typed: 'podprompt/d499',
    scope: scopeOf('podprompt'),
    children: childrenOf('podprompt', ...many),
    renderLimit: 10,
  });
  check("a match past the render cap is still reachable by typing",
    narrowed.rowEls().length === 1 && narrowed.textOf(narrowed.rowEls()[0]).startsWith('d499'),
    narrowed.rowEls().map(narrowed.textOf));

  const r2 = run({ scope: scopeOf('(root)'), children: childrenOf('(root)', 'a', 'b') });
  r2.move(99);
  check("the highlight clamps at the last row", r2.active() === r2.rows().length - 1);
  r2.move(-99);
  check("...and at the first", r2.active() === 0);
}

// ── driver.mjs: the routes ─────────────────────────────────────────────────
{
  check("/dirs is routed for reading",
    /req\.method === "GET" && path === "\/dirs"/.test(src));
  check("/dirs is routed for creating",
    /req\.method === "POST" && path === "\/dirs"/.test(src));
  check("the listing is rooted at the workspace root, not process.cwd()",
    /listDirs\(args\.cwd, under/.test(src));
  check("creation goes through the shared boundary, not a local mkdir",
    /createDirUnderRoot\(body\?\.path, args\.cwd\)/.test(src));
  check("a refused creation is a 400, not a silent fallback",
    /could not create that directory under the workspace root/.test(src));

  const dirsRoute = src.slice(src.indexOf('path === "/dirs"'));
  const getBlock = dirsRoute.slice(0, dirsRoute.indexOf('req.method === "POST"'));

  check("the level to list comes from ?under=",
    /searchParams\.get\("under"\)/.test(getBlock), getBlock.slice(0, 400));
  check("dotfolders are opt-in via ?hidden=",
    /searchParams\.get\("hidden"\) === "1"/.test(getBlock), getBlock.slice(0, 400));
  // One filesystem, one answer. A ?backend= here would imply the two
  // backends could disagree about what directories exist, which they cannot
  // — they are handed the same cwdRoot and run in the same container.
  check("/dirs does not branch on a backend",
    !/searchParams\.get\("backend"\)/.test(getBlock), getBlock.slice(0, 400));
  // A scope that doesn't resolve must not be answered with a listing of
  // somewhere else — that would silently relocate the session.
  check("an unresolvable scope is a 404",
    /res\.writeHead\(404/.test(getBlock) && /no such directory under the workspace root/.test(getBlock),
    getBlock);

  // A readdir of one directory is sub-millisecond. The cache that served the
  // old recursive scan would now only buy the chance to show a directory
  // that is no longer there.
  check("one-level listings are not cached",
    !/dirScanCache|DIR_SCAN_TTL_MS/.test(src));
  check("the recursive scanner is gone from the driver",
    !/scanDirs/.test(src));
}

// ── driver.mjs: both backends share one boundary ───────────────────────────
{
  const cc = readFileSync(new URL("./backends/claude-code.mjs", import.meta.url), "utf8");
  const oc = readFileSync(new URL("./backends/opencode.mjs", import.meta.url), "utf8");
  check("claude-code resolves through dirscan",
    /import \{ resolveUnderRoot \} from "\.\.\/dirscan\.mjs"/.test(cc));
  check("opencode resolves through dirscan",
    /import \{ resolveUnderRoot \} from "\.\.\/dirscan\.mjs"/.test(oc));
  // The old hand-rolled copies are what disagreed. Neither file should still
  // be deciding containment for itself inside resolveValidCwd.
  check("claude-code's resolveValidCwd no longer rolls its own check",
    !/existsSync\(candidate\)/.test(bodyOf(cc, "resolveValidCwd")), bodyOf(cc, "resolveValidCwd"));
  check("claude-code still registers a newly chosen project",
    /knownProjects\.reachable\.set\(resolved, null\)/.test(cc));
}

// ── viewer.html: the wiring the DOM stub can't reach ───────────────────────
{
  const picker = html.slice(html.indexOf("async function openNewChatPicker"));
  const keydown = picker.slice(0, picker.indexOf("filterRow.appendChild"));

  check("Enter takes the highlighted row",
    /newChatRows\[newChatActiveIndex\]\?\.choose\(\)/.test(keydown), keydown.slice(0, 200));
  // THE BUG THIS REPLACES: `if (e.key === 'Enter' && input.value.trim())
  // startNewChatInProject(input.value.trim(), ...)` — the typed string went
  // straight to the session with nothing having checked it exists.
  check("Enter never starts a session on the raw input value",
    !/startNewChatInProject\(input\.value/.test(html) &&
    !/startNewChatInProject\(newChatFilterInput\.value/.test(html));
  check("the arrows move the highlight", /ArrowDown/.test(keydown) && /ArrowUp/.test(keydown));
  check("Tab descends", /e\.key === 'Tab' \|\| e\.key === 'ArrowRight'/.test(keydown), keydown);
  // Hijacking ArrowRight mid-text would make the box impossible to edit.
  check("ArrowRight only descends from the end of the text",
    /selectionStart === newChatFilterInput\.value\.length/.test(keydown), keydown);
  check("Escape closes the picker", /e\.key === 'Escape'/.test(keydown));

  const load = bodyOf(html, "loadNewChatLevel");
  check("/projects is still fetched per backend",
    /\/projects\?backend=\$\{encodeURIComponent\(backend\)\}/.test(load), load);
  check("/dirs is fetched without a backend", /\$\{driverBase\}\/dirs\$\{query/.test(load), load);
  check("the scope rides along as ?under=", /params\.set\('under', scope\)/.test(load), load);
  check("a dot in the typed name asks for dotfolders",
    /params\.set\('hidden', '1'\)/.test(load) &&
    /segment\.startsWith\('\.'\)/.test(bodyOf(html, "onNewChatFilterChanged")), load);
  // Loopback responses are not reliably ordered: without a sequence guard an
  // earlier level's results can land on top of a later one's.
  check("a stale level response cannot overwrite a newer one",
    /seq !== newChatLoadSeq/.test(load), load);

  const changed = bodyOf(html, "onNewChatFilterChanged");
  check("only a change of SCOPE goes back to the server",
    /scope === newChatScopeRel && hidden === newChatScopeHidden/.test(changed), changed);
  check("...otherwise matching is local and immediate",
    /renderDestinations\(\);\s*return;/.test(changed), changed);

  const create = bodyOf(html, "createDestinationAndStart");
  check("creation POSTs to /dirs", /\$\{driverBase\}\/dirs/.test(create) && /method: 'POST'/.test(create));
  check("a refused creation is shown, not swallowed",
    /newChatNote\(data\.error \|\| 'Could not create that directory\.', true\)/.test(create), create);
  check("a refused creation does NOT start a session",
    create.indexOf("return;") < create.indexOf("chooseDestination"), create);

  const choose = bodyOf(html, "chooseDestination");
  check("the root sends no explicit cwd",
    /cwd === newChatRoot \? undefined : cwd/.test(choose), choose);
}

// ── viewer.html: a failed send is retryable ────────────────────────────────
{
  const submit = bodyOf(html, "submitPrompt");
  check("the unsent prompt is restored on an error response",
    /if \(!res\.ok\) \{\s*setTurnInFlight\(false\);\s*restoreUnsentPrompt\(\);/.test(submit), submit);
  check("...and when the request itself throws",
    /catch \(e\) \{\s*setTurnInFlight\(false\);\s*restoreUnsentPrompt\(\);/.test(submit), submit);
  // The old behaviour: the pending cwd was consumed unconditionally, so a
  // retry after any failure silently started the session in the DEFAULT
  // directory instead of the one that was picked.
  check("the picked destination survives a failed send",
    /pendingCwdForNewSession = pendingCwdUsed/.test(submit), submit);
  check("the picked backend survives it too",
    /pendingBackendForNewSession = pendingBackendUsed/.test(submit), submit);
  check("the restore does not clobber something already retyped",
    /if \(!promptInput\.value\.trim\(\)\)/.test(submit), submit);
}

console.log(`new-chat destination picker: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
