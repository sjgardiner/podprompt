// Unit tests for the "+ New chat" destination picker's wiring.
//
// Run: node viewer/new-chat-picker.test.mjs
//
// The boundary itself (which paths are acceptable, what the scan returns) is
// dirscan.test.mjs's job and is tested against a real temp tree there. This
// file covers the two halves that module cannot see:
//
//   driver.mjs — that /dirs is actually routed, is NOT keyed by ?backend=
//                (one filesystem, one answer — a per-backend variant would
//                be a second source of truth for the same question), that a
//                filtered scan bypasses the cache, and that creating a
//                directory invalidates it.
//   viewer.html — that Enter takes the HIGHLIGHTED ROW and never the raw
//                text. That distinction is the entire feature: the old free
//                text box sent whatever was typed and let the first prompt
//                fail on it, losing the message with it.
//
// Both are read out of the shipped files at run time, so there is no copy to
// drift. mergeDestinations is lifted out and actually executed, because its
// ordering rules are real logic rather than a wiring assertion.

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

// ── mergeDestinations: one list out of two sources ─────────────────────────
{
  const makeMerge = (root) =>
    new Function("newChatRoot", `${bodyOf(html, "mergeDestinations")}; return mergeDestinations;`)(root);
  const merge = makeMerge("/workspace");

  const dirs = {
    root: "/workspace",
    dirs: [
      { cwd: "/workspace", label: "(root)" },
      { cwd: "/workspace/zeta", label: "zeta" },
      { cwd: "/workspace/alpha", label: "alpha" },
      { cwd: "/workspace/podprompt", label: "podprompt" },
    ],
  };
  const projects = {
    root: "/workspace",
    projects: [
      // Already in the scan — must not produce a second row.
      { cwd: "/workspace/podprompt", label: "podprompt" },
      // NOT in the scan: a known project the depth cap or exclude list left
      // out. Losing it would be a regression against the old picker, which
      // listed exactly these.
      { cwd: "/workspace/deep/past/the/cap", label: "deep/past/the/cap" },
    ],
  };

  const merged = merge(projects, dirs, "/workspace/podprompt");
  const labels = merged.map((d) => d.label);

  check("the current project is pinned first",
    labels[0] === "podprompt" && merged[0].isCurrent === true, labels);
  check("the root comes next", labels[1] === "(root)", labels);
  check("the rest are alphabetical",
    labels.slice(2).join(",") === "alpha,deep/past/the/cap,zeta", labels);
  check("a destination in both sources appears once",
    labels.filter((l) => l === "podprompt").length === 1, labels);
  check("a known project missing from the scan is kept",
    labels.includes("deep/past/the/cap"), labels);
  check("nothing is tagged by which source it came from",
    merged.every((d) => Object.keys(d).sort().join(",") === "cwd,isCurrent,label"),
    Object.keys(merged[0]));

  check("only the current destination is marked current",
    merged.filter((d) => d.isCurrent).length === 1);

  // Both halves have to survive the other being unreachable: an older
  // driver.mjs has no /dirs at all, and a backend whose project history is
  // unavailable still has a filesystem.
  check("dirs alone still produce a list", merge(null, dirs, null).length === 4);
  check("projects alone still produce a list", merge(projects, null, null).length === 2);
  check("neither source is survivable", merge(null, null, null).length === 0);

  // When the root IS the current directory, the two pins are the same row and
  // must not fight: current wins, and nothing is duplicated.
  const atRoot = merge(projects, dirs, "/workspace");
  check("the root as current project is pinned once",
    atRoot[0].label === "(root)" && atRoot.filter((d) => d.label === "(root)").length === 1,
    atRoot.map((d) => d.label));
}

// ── renderDestinations, actually run ───────────────────────────────────────
//
// Lifted out of the shipped file and executed against a DOM stub, because
// what matters here is not that the source mentions the right names — it is
// which row Enter would land on, and whether the offer to CREATE a directory
// can ever appear while a real destination is still selectable. Those are
// behaviours, and asserting them by regex would be asserting the shape of the
// code instead of what it does.
{
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

  const SHIPPED = [
    bodyOf(html, 'newChatFilterValue'),
    bodyOf(html, 'setActiveRow'),
    bodyOf(html, 'newChatNote'),
    bodyOf(html, 'renderDestinations'),
  ].join('\n');

  const REAL_RENDER_LIMIT = Number(/const NEW_CHAT_RENDER_LIMIT = (\d+);/.exec(html)[1]);

  function run({ destinations, filter = '', root = '/workspace', truncated = false, renderLimit = REAL_RENDER_LIMIT }) {
    const started = [];
    const created = [];
    const destList = stubDocument.createElement('div');
    const filterInput = { value: filter };
    const api = new Function('document', 'deps', `
      let newChatDestinations = deps.destinations;
      let newChatRoot = deps.root;
      let newChatTruncated = deps.truncated;
      let newChatRows = [];
      let newChatActiveIndex = 0;
      let newChatDestList = deps.destList;
      let newChatFilterInput = deps.filterInput;
      let newChatSelectedBackend = 'claude-code';
      const NEW_CHAT_RENDER_LIMIT = deps.renderLimit;
      const startNewChatInProject = (...a) => deps.started.push(a);
      const createDestinationAndStart = (p) => deps.created.push(p);
      ${SHIPPED}
      renderDestinations();
      return {
        rows: () => newChatRows,
        active: () => newChatActiveIndex,
        move: (n) => setActiveRow(newChatActiveIndex + n),
        enter: () => newChatRows[newChatActiveIndex] && newChatRows[newChatActiveIndex].choose(),
      };
    `)(stubDocument, { destinations, root, truncated, destList, filterInput, renderLimit, started, created });
    return { ...api, started, created, destList };
  }

  const DESTS = [
    { cwd: '/workspace/podprompt', label: 'podprompt', isCurrent: true },
    { cwd: '/workspace', label: '(root)', isCurrent: false },
    { cwd: '/workspace/analysis', label: 'analysis', isCurrent: false },
    { cwd: '/workspace/podprompt/viewer', label: 'podprompt/viewer', isCurrent: false },
  ];

  {
    const r = run({ destinations: DESTS });
    check("every destination gets a row", r.rows().length === 4, r.rows().length);
    check("the current one is marked in the text",
      r.destList.children[0]._text === 'podprompt (current)', r.destList.children[0]._text);
    check("the current one is the row Enter takes", r.active() === 0);
    r.enter();
    check("choosing it starts a session in its cwd",
      JSON.stringify(r.started) === JSON.stringify([['/workspace/podprompt', 'claude-code']]), r.started);
    check("choosing it never offers to create anything", r.created.length === 0);
  }

  {
    // The root is the one destination that must send NO explicit cwd — the
    // driver's /prompt treats a missing cwd as "the default", and sending
    // the root explicitly would take a different path for the same place.
    const r = run({ destinations: DESTS });
    r.move(1);
    check("arrowing down moves off the current row", r.active() === 1);
    r.enter();
    check("the root sends undefined, not its path",
      r.started[0][0] === undefined, r.started);
  }

  {
    const r = run({ destinations: DESTS, filter: 'view' });
    check("a filter narrows to matching rows", r.rows().length === 1, r.rows().length);
    check("...and the match is the right one",
      r.destList.children[0]._text === 'podprompt/viewer', r.destList.children[0]._text);
    check("a narrowed list offers no create row", r.created.length === 0);
    r.enter();
    check("Enter on a narrowed list starts a session, it does not create",
      r.started.length === 1 && r.created.length === 0, { started: r.started, created: r.created });
  }

  {
    check("filtering is case-insensitive",
      run({ destinations: DESTS, filter: 'VIEW' }).rows().length === 1);
    check("a filter matches anywhere in the path, not just the start",
      run({ destinations: DESTS, filter: 'nalys' }).rows().length === 1);
  }

  {
    // THE FEATURE. Typing a path nothing matches is read as "make this",
    // and it is the ONLY row — so Enter cannot create a directory while a
    // real destination was still on screen and selected.
    const r = run({ destinations: DESTS, filter: 'podprompt/brand-new' });
    check("an unmatched path offers to create it", r.rows().length === 1, r.rows().length);
    check("the create row says so",
      r.destList.children[0]._text.includes('Create') &&
      r.destList.children[0]._text.includes('podprompt/brand-new'),
      r.destList.children[0]._text);
    check("the create row is visually distinct",
      r.destList.children[0].className.includes('new-chat-create-item'),
      r.destList.children[0].className);
    r.enter();
    check("Enter routes it to creation, not straight to a session",
      r.created.length === 1 && r.started.length === 0, { started: r.started, created: r.created });
    check("creation is asked for with exactly what was typed",
      r.created[0] === 'podprompt/brand-new', r.created);
  }

  {
    const r = run({ destinations: [], filter: '' });
    check("an empty list with no filter offers nothing to create",
      r.rows().length === 0, r.rows().length);
    check("...and says so", r.destList.children[0]._text === 'No directories found.',
      r.destList.children[0]._text);
  }

  {
    const many = Array.from({ length: 500 }, (_, i) => ({
      cwd: `/workspace/p${String(i).padStart(3, '0')}`,
      label: `p${String(i).padStart(3, '0')}`,
      isCurrent: false,
    }));
    const r = run({ destinations: many, renderLimit: 10 });
    check("rendering stops at the cap", r.rows().length === 10, r.rows().length);
    check("the held-back count is reported",
      r.destList.children[10]._text === '490 more directories not shown — keep typing to narrow.',
      r.destList.children[10]._text);
    // The cap must not hide anything from the FILTER, only from the paint.
    const narrowed = run({ destinations: many, filter: 'p499', renderLimit: 10 });
    check("a match past the render cap is still reachable by typing",
      narrowed.rows().length === 1 && narrowed.destList.children[0]._text === 'p499',
      narrowed.destList.children[0]._text);

    const r1 = run({ destinations: many.slice(0, 1), renderLimit: 10 });
    check("one held-back row is reported in the singular, or not at all",
      !r1.destList.children.some((c) => /more director/.test(c._text || '')),
      r1.destList.children.map((c) => c._text));
  }

  {
    // A server-side truncation is a different statement from a render cap:
    // what is missing was never sent, so it cannot be found by filtering
    // what arrived.
    const r = run({ destinations: DESTS, truncated: true });
    const texts = r.destList.children.map((c) => c._text);
    check("a truncated scan tells the user to keep typing",
      texts.some((t) => /keep typing to search the rest/.test(t || '')), texts);
    const both = run({ destinations: DESTS, truncated: true, renderLimit: 2 });
    const bothTexts = both.destList.children.map((c) => c._text);
    check("the two notices never both appear",
      bothTexts.filter((t) => /keep typing/.test(t || '')).length === 1, bothTexts);
  }

  {
    const r = run({ destinations: DESTS });
    r.move(99);
    check("the highlight clamps at the last row", r.active() === 3);
    r.move(-99);
    check("...and at the first", r.active() === 0);
  }
}

// ── driver.mjs: the routes ─────────────────────────────────────────────────
{
  check("/dirs is routed for reading",
    /req\.method === "GET" && path === "\/dirs"/.test(src));
  check("/dirs is routed for creating",
    /req\.method === "POST" && path === "\/dirs"/.test(src));
  check("the scan is rooted at the workspace root, not process.cwd()",
    /scanDirs\(args\.cwd/.test(src));
  check("creation goes through the shared boundary, not a local mkdir",
    /createDirUnderRoot\(body\?\.path, args\.cwd\)/.test(src));
  check("a refused creation is a 400, not a silent fallback",
    /could not create that directory under the workspace root/.test(src));

  // One filesystem, one answer. A ?backend= here would imply the two
  // backends could disagree about what directories exist, which they cannot
  // — they are handed the same cwdRoot and run in the same container.
  const dirsRoute = src.slice(src.indexOf('path === "/dirs"'));
  const getBlock = dirsRoute.slice(0, dirsRoute.indexOf('req.method === "POST"'));
  check("/dirs does not branch on a backend",
    !/searchParams\.get\("backend"\)/.test(getBlock), getBlock.slice(0, 400));

  // A truncated scan cannot be filtered client-side: the match being looked
  // for may be one the entry cap cut off. So a filtered request has to walk
  // fresh rather than filtering the cached list.
  check("a filtered request bypasses the cache",
    /q \? scanDirs\(args\.cwd, \{ q \}\) : cachedDirScan\(\)/.test(getBlock), getBlock.slice(0, 600));
  check("creating a directory invalidates the cached scan",
    /dirScanCache = null/.test(src));
  check("the cache is time-bounded, so a directory made in a terminal shows up",
    /DIR_SCAN_TTL_MS/.test(src) && /Date\.now\(\) - dirScanCache\.at < DIR_SCAN_TTL_MS/.test(src));
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

// ── viewer.html: Enter takes a row, never the raw text ─────────────────────
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
  check("Escape closes the picker", /e\.key === 'Escape'/.test(keydown));

  const render = bodyOf(html, "renderDestinations");
  check("the create row only appears when nothing matched",
    /if \(!matches\.length && typed\)/.test(render), render.slice(0, 200));
  check("creating goes through the driver, not straight into a session",
    /createDestinationAndStart\(typed\)/.test(render));
  check("a chosen destination equal to the root sends no explicit cwd",
    /d\.cwd === newChatRoot \? undefined : d\.cwd/.test(render));

  // A real workspace is ~2000 directories. Only the painting stops early —
  // the filter must still run over the whole list, or narrowing could never
  // reach a match the render cap was hiding.
  check("rendering is capped", /matches\.slice\(0, NEW_CHAT_RENDER_LIMIT\)/.test(render), render);
  check("the cap has a value", /const NEW_CHAT_RENDER_LIMIT = \d+;/.test(html));
  check("filtering runs over every destination, not the rendered slice",
    /newChatDestinations\.filter\(/.test(render), render);
  check("rows are built from the capped slice",
    /shown\.forEach\(/.test(render) && !/matches\.forEach\(/.test(render), render);
  check("the user is told when rows were held back",
    /matches\.length - shown\.length/.test(render), render);

  const create = bodyOf(html, "createDestinationAndStart");
  check("creation POSTs to /dirs", /\$\{driverBase\}\/dirs/.test(create) && /method: 'POST'/.test(create));
  check("a refused creation is shown, not swallowed",
    /newChatNote\(data\.error \|\| 'Could not create that directory\.', true\)/.test(create), create);
  check("a refused creation does NOT start a session",
    create.indexOf("return;") < create.indexOf("startNewChatInProject"), create);

  const load = bodyOf(html, "loadDestinations");
  check("/projects is still fetched per backend",
    /\/projects\?backend=\$\{encodeURIComponent\(backend\)\}/.test(load), load);
  check("/dirs is fetched without a backend", /\$\{driverBase\}\/dirs\$\{q \?/.test(load), load);
  check("an older driver without /dirs degrades to projects only",
    /\.catch\(\(\) => null\)/.test(load) && /dirsRes && dirsRes\.ok \? await dirsRes\.json\(\) : null/.test(load));
  // Loopback responses are not reliably ordered, and the filter refetch is
  // debounced per keystroke: without a sequence guard an earlier filter's
  // results can land on top of a later one's.
  check("a stale filter response cannot overwrite a newer one",
    /seq !== newChatLoadSeq/.test(load), load);
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
