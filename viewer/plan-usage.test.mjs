// The header's plan-usage indicator — driven against the SHIPPED
// renderPlanUsage(), not a copy of it.
//
// WHAT THIS PROTECTS. The driver collects both rate-limit windows and
// broadcasts both. The indicator used to show the five-hour one whenever it
// existed and fall back to seven-day only in its absence — so on a
// subscription reporting both, the WEEKLY figure was gathered, sent to the
// browser, and never once displayed. That is the slower and more
// consequential of the two: five-hour says whether you can keep working this
// afternoon, seven-day says whether you can keep working this week.
//
// Read out of viewer.html at run time so there is no second copy here to
// drift from the real thing.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const html = readFileSync(new URL("./viewer.html", import.meta.url), "utf8");
const from = html.indexOf("function renderPlanUsage()");
if (from < 0) throw new Error("viewer.html no longer defines renderPlanUsage()");
const body = html.slice(from, html.indexOf("\n}\n", from) + 3);

const el = {
  textContent: "", title: "",
  classList: {
    _s: new Set(),
    add(c) { this._s.add(c); },
    remove(c) { this._s.delete(c); },
    toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
    has(c) { return this._s.has(c); },
  },
};
const settings = { planResetFormat: "absolute" };
const formatTs = (iso) => `${new Date(iso).toISOString().slice(11, 16)}Z`;
const formatRelativeReset = () => "in a bit";

const render = new Function(
  "lastPlanUsageStatus", "planUsageWrap", "settings", "formatTs", "formatRelativeReset",
  `${body}; return renderPlanUsage();`,
);

function run(status) {
  el.textContent = ""; el.title = ""; el.classList._s.clear();
  render(status, el, settings, formatTs, formatRelativeReset);
  return { text: el.textContent, title: el.title, warn: el.classList.has("warn"), shown: el.classList.has("show") };
}

// The payload shape driver.mjs actually broadcasts.
const W = (utilization, resets_at) => ({ utilization, resets_at });
const RESET = "2026-11-13T17:00:00.000Z";
const sub = (rate_limits) => ({ subscription_type: "max", rate_limits });

{
  const r = run(sub({ five_hour: W(42, RESET), seven_day: W(61, RESET) }));
  check("both windows are shown, each labelled", r.text === "5h 42% · 7d 61%", r);
  check("...with no warning below the threshold", r.warn === false, r);
  check("...and the tooltip spells both out", /Five-hour/.test(r.title) && /Seven-day/.test(r.title), r.title);
}

{
  // The case the old code could not express at all.
  const r = run(sub({ five_hour: W(42, RESET), seven_day: W(88, RESET) }));
  check("a spent WEEK warns even when the afternoon is fine", r.warn === true, r);
  check("...and the reset shown belongs to the window that warned",
    r.text === "5h 42% · 7d 88% · 7d resets 17:00Z", r);
}

{
  const r = run(sub({ five_hour: W(91, RESET), seven_day: W(12, RESET) }));
  check("a spent five hours warns even when the week is fine", r.warn === true, r);
  check("...and names the five-hour reset", r.text.includes("5h resets"), r);
}

{
  const r = run(sub({ five_hour: W(42, RESET) }));
  check("one window alone still renders", r.text === "5h 42%" && r.shown, r);
}

{
  // Subscriptions that report only the weekly window — the old fallback path.
  const r = run(sub({ seven_day: W(61, RESET) }));
  check("seven-day alone renders", r.text === "7d 61%" && r.shown, r);
}

{
  const r = run(sub({ five_hour: { utilization: 88 } }));
  check("a window with no reset time warns without a dangling 'resets'",
    r.warn === true && r.text === "5h 88%", r);
}

{
  check("no subscription type hides it",
    run({ subscription_type: null, rate_limits: { five_hour: W(42, RESET) } }).shown === false);
  check("no windows hides it", run(sub({})).shown === false);
  check("a payload with no rate_limits at all hides it",
    run({ subscription_type: "max" }).shown === false);
}

{
  settings.planResetFormat = "relative";
  const r = run(sub({ five_hour: W(95, RESET) }));
  check("the relative-format setting is honoured", r.text === "5h 95% · 5h resets in a bit", r);
  settings.planResetFormat = "absolute";
}

console.log(`\nplan-usage.test.mjs: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail === 0 ? 0 : 1);
