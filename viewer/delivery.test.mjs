import { readFileSync } from "node:fs";
let pass=0,fail=0; const failures=[];
function check(n,c,d){ if(c){pass++;return;} fail++; failures.push(`${n}${d!==undefined?` — ${JSON.stringify(d)}`:""}`); }
const src = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
function bodyOf(name){
  const i=src.indexOf(`function ${name}(`); if(i<0) throw new Error(name);
  const start=src.slice(Math.max(0,i-6),i)==="async "?i-6:i;
  let parens=0,open=-1;
  for(let k=src.indexOf("(",i);k<src.length;k++){ if(src[k]==="(")parens++; else if(src[k]===")"&&--parens===0){open=src.indexOf("{",k);break;} }
  let depth=0;
  for(let k=open;k<src.length;k++){ if(src[k]==="{")depth++; else if(src[k]==="}"&&--depth===0) return src.slice(start,k+1); }
  throw new Error(name);
}
// splitDeliveredMessages now references STOP_NOTICE (it strips the notice
// before its ^-anchored match), so every sandbox holding it needs the
// constant too. Extracted rather than copied, so the test cannot pass
// against wording the driver no longer uses.
function constOf(name){
  const i=src.indexOf(`const ${name} =`); if(i<0) throw new Error(name);
  const end=src.indexOf(";\n", i); if(end<0) throw new Error(name);
  return src.slice(i, end+1);
}

const f = new Function(`
  const describeSender = (e) => e.fromHandle ? "@"+e.fromHandle : "a peer";
  ${constOf("STOP_NOTICE")}
  ${bodyOf("composeDelivery")}
  ${bodyOf("splitDeliveredMessages")}
  return { composeDelivery, splitDeliveredMessages };
`)();

const E = (h,t)=>({fromHandle:h,text:t});

// round trip
{
  const entries=[E("alice","hello"),E("bob","world"),E(null,"anon")];
  const txt=f.composeDelivery(entries);
  const out=f.splitDeliveredMessages(txt);
  check("a batch round-trips", out?.length===3, out);
  check("senders survive", out?.map(x=>x.sender).join(",")==="@alice,@bob,a peer", out?.map(x=>x.sender));
  check("bodies survive exactly", out?.map(x=>x.text).join("|")==="hello|world|anon", out?.map(x=>x.text));
}
// single is never split
{
  const txt=f.composeDelivery([E("alice","just me")]);
  check("a single message is not a batch", f.splitDeliveredMessages(txt)===null);
  check("...and still carries its header", /^\[message from @alice\]/.test(txt), txt);
}
// the delimiter that used to break it
{
  const entries=[E("a","intro\n\n---\n\nsection two\n\n---\n\nthree"),E("b","second")];
  const out=f.splitDeliveredMessages(f.composeDelivery(entries));
  check("markdown rules in a body do NOT split it", out?.length===2, out?.length);
  check("...and the body keeps its rules", out?.[0].text.includes("---"), out?.[0].text);
}
// the verification
{
  const txt=f.composeDelivery([E("a","x"),E("b","y")]).replace("You have 2","You have 3");
  check("a count mismatch refuses to split", f.splitDeliveredMessages(txt)===null);
  const spoof="You have 2 messages waiting.\n\n[message from @a]\n\nsee [message from @evil]\n\nmore";
  check("a body imitating a header fails the count check",
    f.splitDeliveredMessages(spoof)===null || f.splitDeliveredMessages(spoof).length===2);
}
// junk
for (const [l,v] of [["null",null],["undefined",undefined],["number",42],["plain text","hello"],["empty",""]])
  check(`${l} input is safe`, f.splitDeliveredMessages(v)===null);

// wiring
{
  check("both backends use the shared helper",
    /broadcastUserPrompt\(sessionId, promptText/.test(readFileSync(new URL("./backends/opencode.mjs",import.meta.url),"utf8"))
    && /broadcastUserPrompt\(sessionId, promptText/.test(readFileSync(new URL("./backends/claude-code.mjs",import.meta.url),"utf8")));
  check("the live broadcast only splits a peer delivery", /origin === "peer" \? splitDeliveredMessages/.test(src));
  check("history reconstruction splits identically", /MD11: a coalesced delivery is ONE durable message/.test(src));
  check("no '---' separator remains in the format", !/join\("\\n\\n---\\n\\n"\)/.test(src));
}
// ── The stop notice (MD12) ───────────────────────────────────────────────
//
// WHAT THIS GUARDS. An agent cannot tell from inside its own transcript that
// a HUMAN stopped it — being stopped and having a tool call glitch look
// identical, because the turn just ends mid-action. Observed live: five
// seconds after the user pressed Stop, mail woke the session and the agent
// reasoned "my tool call was interrupted (probably because a message
// arrived)", concluded nothing was wrong, and resumed the exact plan that
// had just been halted, for another 36 seconds.
{
  const sandbox = `
    const turnState = arguments[0];
    ${bodyOf("sessionWasStopped")}
    ${constOf("STOP_NOTICE")}
    ${bodyOf("withStopNotice")}
    return { withStopNotice, sessionWasStopped, STOP_NOTICE };
  `;
  const d = new Function(sandbox)({
    stopped: { resumable: { reason: "aborted" } },
    crashed: { resumable: { reason: "error" } },
    restarted: { resumable: { reason: "restart" } },
    fine: {},
  });

  check("a stopped session gets the notice",
    d.withStopNotice("stopped", "hello").startsWith(d.STOP_NOTICE), d.withStopNotice("stopped", "hello"));
  check("...and the original text survives intact",
    d.withStopNotice("stopped", "hello").endsWith("hello"));

  // Only a HUMAN stop. A crashed or restarted session is resumed by the
  // supervisor with its own wording, and telling it a user pressed Stop
  // would be a plain lie about what happened.
  check("a crashed session does not", d.withStopNotice("crashed", "hello") === "hello");
  check("a restarted session does not", d.withStopNotice("restarted", "hello") === "hello");
  check("a healthy session does not", d.withStopNotice("fine", "hello") === "hello");
  check("an unknown session does not", d.withStopNotice("nobody", "hello") === "hello");

  // The wording the user settled on. "Do not resume it, stop and ask" was
  // rejected: it trains an agent to halt for permission every time it is
  // woken, which is its own failure mode, and the user may well want the
  // prior work continued once the new message is accounted for.
  check("the notice asks for re-assessment, not permission",
    /re-assess/i.test(d.STOP_NOTICE), d.STOP_NOTICE);
  check("...and does not forbid resuming outright",
    !/do not resume/i.test(d.STOP_NOTICE), d.STOP_NOTICE);
  check("...and does not tell it to stop and ask",
    !/stop and ask/i.test(d.STOP_NOTICE), d.STOP_NOTICE);
}

// ── The notice must not break the MD11 split ─────────────────────────────
//
// splitDeliveredMessages is ^-anchored on "You have N messages waiting". A
// prepended notice would fail that match and the split would silently
// degrade to one bubble — no error, just yesterday's feature quietly absent
// whenever a stopped session is woken by several messages at once.
{
  const sandbox = `
    ${constOf("STOP_NOTICE")}
    ${bodyOf("splitDeliveredMessages")}
    return { splitDeliveredMessages, STOP_NOTICE };
  `;
  const d = new Function(sandbox)();
  const body = "You have 2 messages waiting.\n\n"
    + "[message from @a]\n\nfirst\n\n[message from @b]\n\nsecond";

  const plain = d.splitDeliveredMessages(body);
  check("a plain delivery still splits", plain?.length === 2, plain);

  const noticed = d.splitDeliveredMessages(`${d.STOP_NOTICE}\n\n${body}`);
  check("a notice-prefixed delivery still splits", noticed?.length === 2, noticed);
  check("...into the same senders",
    JSON.stringify(noticed) === JSON.stringify(plain), noticed);
}

// ── Stop must not RELEASE mail (MD12) ────────────────────────────────────
//
// THE BUG. /abort, /stop-all and /stop-subtree all routed through
// noteUserDirectedAction(), which zeroes the autonomy counter AND calls
// releaseAutonomyParked() -> drainAllInboxes(). So Stop — the one action
// meaning "do LESS" — was the single most autonomy-ENABLING action in the
// system: it handed out a fresh budget of automatic turns and then started
// turns with it.
//
// MD7 listed the actions that count as the user directing the system, but
// missed that direction has a SIGN.
{
  const stop = bodyOf("noteUserStopAction");
  check("the stop path still records human presence",
    /autonomy\.noteHumanAction\(\)/.test(stop), stop);
  // The whole point: presence yes, release no.
  check("...but does NOT release parked mail",
    !/releaseAutonomyParked/.test(stop), stop);

  // The do-more path is unchanged — Continue and approve SHOULD release.
  const go = bodyOf("noteUserDirectedAction");
  check("the do-more path still releases", /releaseAutonomyParked/.test(go), go);

  // All three stop routes, or the bug returns via a different button.
  for (const route of ["/abort", "/stop-all", "/stop-subtree"]) {
    const at = src.indexOf(`path === "${route}"`);
    check(`${route} exists`, at > 0, route);
    const window = src.slice(at, at + 400);
    check(`${route} uses the stop path`, /noteUserStopAction\(\)/.test(window), window.slice(0, 160));
    check(`${route} does not use the do-more path`,
      !/noteUserDirectedAction\(\)/.test(window), window.slice(0, 160));
  }

  // Answering a permission is a "do more" action and must keep releasing.
  const perm = src.slice(src.indexOf('path === "/permission-response"'), src.indexOf('path === "/permission-response"') + 300);
  check("/permission-response still counts as do-more",
    /noteUserDirectedAction\(\)/.test(perm), perm.slice(0, 160));
}

// ── The notice is actually applied at delivery ───────────────────────────
{
  check("the drain wraps the composed text",
    /withStopNotice\(sessionId, composeDelivery\(group\)\)/.test(src));
  // It must NOT live inside composeDelivery: that function's output shape is
  // load-bearing for splitDeliveredMessages.
  check("...and not inside composeDelivery",
    !/STOP_NOTICE/.test(bodyOf("composeDelivery")));
  check("the browser is told the session is stopped",
    /stopped: sessionWasStopped\(sessionId\)/.test(src));
}

console.log(`delivery split (MD11): ${pass} passed, ${fail} failed`);
for(const x of failures) console.log("  FAIL "+x);
process.exit(fail?1:0);
