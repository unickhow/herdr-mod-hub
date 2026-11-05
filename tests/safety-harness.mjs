// Runs the REAL mod-hub/main.js against a sandbox with hostile inputs and real shell commands.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url"; import cp from "node:child_process"; import crypto from "node:crypto";
const SRC = process.env.SRC || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mods/mod-hub/main.js");
const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "modhub-sb-")));
const APP = `${SB}/home/.config/herdr-app`, OUT = `${SB}/outdir`, CANARY = `${SB}/canary`, BIN = `${SB}/fakebin`;
const log = []; const violations = []; let failures = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) failures++; };

// ---------- sandbox
const w = (p, t = "x") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
for (const d of ["mods", "layouts", "data/mod-hub"]) fs.mkdirSync(`${APP}/${d}`, { recursive: true });
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(BIN, { recursive: true });
w(`${CANARY}/important.txt`, "DO NOT TOUCH"); w(`${CANARY}/dir/secret.txt`, "SECRET"); w(`${CANARY}/dir/main.js`, "// user's real project");
const modNames = ["good-a", "good-b", "menu", "mod-hub", "has space", "$(touch PWNED)", "a'b", "-rf", "semi;colon", "back`tick", "new\nline"];
for (const n of modNames) w(`${APP}/mods/${n}/main.js`, "// " + n);
fs.rmSync(`${APP}/mods/good-b/main.js`);                                // a mod folder without main.js
w(`${APP}/mods/.hidden/main.js`);
fs.symlinkSync("/nonexistent/target", `${APP}/mods/dead`);              // dangling link
fs.symlinkSync(CANARY + "/dir", `${APP}/mods/evil-link`);               // link out of the sandbox
w(`${APP}/installed.json`, JSON.stringify({ menu: { "main.js": "x" }, "layout:main": { json: "x" } }));
w(`${APP}/layouts/main.json`, JSON.stringify({ children: [{ content: { mod: "good-a" } }] }));
for (const [n, body] of Object.entries({ open: 'echo "open $*" >> "$LOGF"', pbcopy: 'cat >> "$LOGF.clip"', pbpaste: 'cat "$LOGF.clip" 2>/dev/null; true', osascript: "trap 'kill $c 2>/dev/null; exit 143' TERM\nsleep 120 &\nc=$!\nwait $c" })) {
  w(`${BIN}/${n}`, `#!/bin/sh\n${body}\n`); fs.chmodSync(`${BIN}/${n}`, 0o755);
}
const hostileState = { groups: { evil: ["menu", "mod-hub", "..", "../..", "good-a", "$(touch PWNED)", "-rf", "a/b", "good-b"], "__proto__": ["good-b"], "ok": ["good-a"], "bad‮type": ["good-a"], notarray: "x" }, tab: "groups" };
w(`${APP}/data/mod-hub/state.json`, JSON.stringify(hostileState));

// ---------- snapshot: every path under SB, with content hash / link target
const snap = (root) => { const o = {}; const walk = (p) => { const st = fs.lstatSync(p); const rel = path.relative(SB, p);
  if (st.isSymbolicLink()) o[rel] = "L>" + fs.readlinkSync(p); else if (st.isDirectory()) { o[rel] = "D"; for (const e of fs.readdirSync(p)) walk(path.join(p, e)); } else o[rel] = "F:" + crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex"); }; walk(root); return o; };
const before = snap(SB);

// ---------- host API (real shell, sandboxed env)
const ALLOWED = new Set(["mkdir", "ls", "sh", "rm", "cp", "touch", "open", "osascript", "kill", "ps", "sleep"]);   // pbcopy/pbpaste are deliberately NOT allowed: the mod must use Herdr's clipboard
const exec = (command, args = []) => new Promise((res, rej) => {
  log.push([command, ...args]);
  if (!ALLOWED.has(command)) { violations.push(`forbidden command: ${command} ${args.join(" ")}`); return rej(new Error("forbidden " + command)); }
  const p = cp.spawn(command, args, { cwd: SB, env: { PATH: `${BIN}:/usr/bin:/bin`, HOME: `${SB}/home`, LOGF: `${SB}/fake.log` } });
  let so = "", se = ""; p.stdout.on("data", (d) => so += d); p.stderr.on("data", (d) => se += d); p.on("error", rej);
  p.on("close", (code) => res({ code, stdout: so, stderr: se }));
});
const readTextFile = async (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const writeTextFile = async (p, text, expected) => { const cur = await readTextFile(p); if ((expected ?? null) !== cur) throw new Error("stale"); w(p, text); return null; };
const shared = (k) => globalThis.__sh?.[k]; const setShared = (k, v) => { (globalThis.__sh ||= {})[k] = v; };
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const inputState = { new: () => ({ _v: "", value() { return this._v; }, set_value(v) { this._v = v; }, on() {}, focus() {} }) };
let pickDir = OUT; const pickFolder = async () => pickDir;
const pending = []; const timers = [];
let clip = undefined, clipFails = false; const opened = [];
const cxStub = { read_from_clipboard: () => { if (clipFails) throw new Error("no clipboard"); return clip; }, write_to_clipboard: (t) => { if (clipFails) throw new Error("no clipboard"); clip = t; }, open_url: (u) => opened.push(u), timer: { after: (ms, f) => timers.push([ms, f]), every() {} }, spawn: (f) => { const p = Promise.resolve().then(() => f(cxStub)); pending.push(p); return p; }, notify() {}, focus_handle: () => ({}) };
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); await Promise.all(pending.splice(0)); };

let fetchImpl = async () => ({ ok: true, json: async () => ({ mods: [] }) });
let code = fs.readFileSync(SRC, "utf8").replace(/^import .*$/gm, "").replace("export default class ModHub extends View", "class ModHub extends View");
const load = (platform) => new Function("View", "div", "v_flex", "h_flex", "InputState", "Input", "exec", "appHome", "readTextFile", "writeTextFile", "theme", "props", "closeOverlay", "shared", "setShared", "pickFolder", "appWindow", "fetch",
  code + "\nreturn ModHub;")(class {}, chain, chain, chain, inputState, chain, exec, () => APP, readTextFile, writeTextFile, () => ({}), () => ({}), () => {}, shared, setShared, pickFolder, () => ({ platform }), (...a) => fetchImpl(...a));
const ModHub = load("macos");

const h = new ModHub(); h.init({}, cxStub); await settle();
const dirs = (d) => fs.readdirSync(d).sort();
const modsNow = () => dirs(`${APP}/mods`);
console.log("\n== 0. scan of the hostile sandbox");
ok(h.enabled.includes("menu") && h.bundled.has("menu"), "built-in `menu` is recognised as built-in");
ok(!h.enabled.includes(".hidden"), "hidden folders are not listed");
ok(["has space", "$(touch PWNED)", "a'b", "-rf", "back`tick"].every((n) => h.enabled.includes(n)), "odd-named folders are listed (so the user can see them)");

console.log("\n== 1. hostile state.json is cleaned, original is kept");
ok(!Object.keys(h.groups).some((k) => k.includes("‮")), "control/bidi characters stripped from group names");
console.log("   groups after cleaning:", JSON.stringify(Object.keys(h.groups)));
ok(!Object.prototype.hasOwnProperty.call(h.groups, "__proto__") && Object.keys(h.groups).every((k) => Array.isArray(h.groups[k])) && !("notarray" in h.groups), "only well-formed groups survive (no __proto__ key, no non-array group)");
ok(!h.groups.evil.some((m) => ["menu", "mod-hub", "..", "../..", "a/b"].includes(m)), "built-in, self, `..` and path members dropped from group `evil`: " + JSON.stringify(h.groups.evil));
ok(dirs(`${APP}/data/mod-hub`).some((f) => f.startsWith("state.json.corrupt-")), "a copy of the original file was kept");

console.log("\n== 2. try to toggle / remove / restore / purge EVERY name, including names that must be refused");
const evilNames = [...modsNow(), "..", "../..", "../../canary", "/etc", "~", "a/b", "mod-hub", "menu", "", " ", "good-a/../../canary", "\n"];
for (const n of evilNames) { h.armed = null; h.toggle(n, cxStub); await settle(); h.armed = null; h.remove(n, cxStub); await settle(); h.remove(n, cxStub); await settle(); }
await h.scan(cxStub);
const gone = fs.readdirSync(`${APP}/data/mod-hub/removed`);
console.log("   removed to the holding area:", gone.map((g) => JSON.stringify(g)).join(", "));
ok(modsNow().includes("menu") && modsNow().includes("mod-hub"), "built-in `menu` and `mod-hub` were NOT moved");
ok(fs.existsSync(`${CANARY}/important.txt`) && fs.existsSync(`${CANARY}/dir/secret.txt`) && fs.existsSync(`${CANARY}/dir/main.js`), "decoy files outside the sandbox mods folder still exist (incl. the one behind the symlink)");
for (const n of ["has space", "$(touch PWNED)", "a'b", "semi;colon", "back`tick", "new\nline"]) ok(modsNow().includes(n), `odd-named folder ${JSON.stringify(n)} is still exactly where it was (refused, never executed)`);
// restore everything, then purge everything, with the real functions
for (const e of fs.readdirSync(`${APP}/data/mod-hub/removed`)) { h.restore(e, cxStub); await settle(); }
await h.scan(cxStub);
for (const e of ["..", "../..", "x/../..", "a__1", "..__1", ".hidden__1", "good-a"]) { h.armed = null; h.purge(e, cxStub); await settle(); h.purge(e, cxStub); await settle(); }
for (const e of fs.readdirSync(`${APP}/data/mod-hub/removed`)) { h.armed = null; h.purge(e, cxStub); await settle(); h.purge(e, cxStub); await settle(); }
ok(fs.existsSync(`${APP}/data/mod-hub/state.json`), "purge never touched data/mod-hub itself");
ok(fs.existsSync(`${CANARY}/dir/secret.txt`) && fs.readFileSync(`${CANARY}/dir/secret.txt`, "utf8") === "SECRET", "symlink to outside folder: only the link was handled, target intact");

console.log("\n== 3. group bulk actions with hostile members");
await h.scan(cxStub);
h.groups.evil = ["menu", "mod-hub", "good-a", "$(touch PWNED)"]; h.picks = new Set();      // bypass cleaning on purpose: simulate a stale/edited group
h.armed = null; h.setGroup("evil", false, cxStub); await settle(); const armedState = h.armed; h.setGroup("evil", false, cxStub); await settle();
ok(armedState === "bulk:evil", "first Disable only asks for confirmation (good-a is used by a layout)");
ok(modsNow().includes("menu") && modsNow().includes("mod-hub"), "bulk Disable did not move `menu` or `mod-hub` even when they are in the group");
await h.scan(cxStub); ok(h.disabled.includes("good-a") && !h.enabled.includes("good-a"), "after the confirming click only good-a (a real user mod) was disabled");

console.log("\n== 4. hostile import");
const imp = JSON.stringify({ format: "mod-hub-groups", version: 1, groups: { "x‮y": ["menu", "mod-hub", "good-a", "$(rm -rf /)", "../..", "a b"], "__proto__": ["z"], "constructor": ["z"], "" : ["z"], ["n".repeat(80)]: ["z"] } });
const parsed = h.parseImport(imp); const plan = h.planFrom(parsed.groups);
ok(plan.length === 1 && plan[0].mods.join() === "good-a", "only the safe, non-built-in member survives: " + JSON.stringify(plan.map((p) => [p.name, p.mods])));
ok(parsed.skipped >= 3, `skipped count reported to the user (${parsed.skipped})`);

console.log("\n== 5. export: never overwrite, never write through links, hostile names");
w(`${OUT}/mod-hub-groups-evil.json`, "PRECIOUS"); fs.symlinkSync(`${CANARY}/important.txt`, `${OUT}/mod-hub-groups-sym.json`);
h.groups = { evil: ["good-a"], sym: ["good-a"], "../../etc/passwd": ["good-a"], "we ird\"$(x)": ["good-a"] };
for (const g of Object.keys(h.groups)) { h.exportGroups([g], g, cxStub); await settle(); h.exportGroups([g], g, cxStub); await settle(); }
ok(fs.readFileSync(`${OUT}/mod-hub-groups-evil.json`, "utf8") === "PRECIOUS", "an existing file was not overwritten");
ok(fs.readFileSync(`${CANARY}/important.txt`, "utf8") === "DO NOT TOUCH", "a symlink with the export's name did not let it write into another file");
ok(dirs(OUT).every((f) => /^mod-hub-groups-[A-Za-z0-9._-]+\.json$/.test(f) || f === "mod-hub-groups-sym.json"), "all exported file names are plain: " + dirs(OUT).join(", "));
for (const f of dirs(OUT).filter((f) => f !== "mod-hub-groups-sym.json" && f !== "mod-hub-groups-evil.json")) { try { JSON.parse(fs.readFileSync(`${OUT}/${f}`, "utf8")); } catch { ok(false, f + " is valid JSON"); } }

console.log("\n== 6. Reload never creates or alters files");
await h.scan(cxStub); const gbBefore = modsNow();
h.reload("good-b", cxStub); await settle();
ok(!fs.existsSync(`${APP}/mods/good-b/main.js`), "Reload on a mod without main.js did NOT create an empty main.js");
const cBefore = fs.readFileSync(`${CANARY}/dir/main.js`, "utf8"); h.reload("evil-link", cxStub); await settle();
ok(fs.readFileSync(`${CANARY}/dir/main.js`, "utf8") === cBefore, "Reload on a symlinked mod left its file content unchanged");
h.reload("..", cxStub); h.reload("menu/../../x", cxStub); h.reload("mod-hub", cxStub); await settle();
ok(!fs.existsSync(`${SB}/home/.config/x`), "Reload with path-like names did nothing");

console.log("\n== 7. cancelling the file chooser kills only our own osascript");
const decoy = cp.spawn("sh", ["-c", "sleep 300", "osascript Choose a Mod Hub group export"], { stdio: "ignore", detached: true });   // an unrelated process that merely mentions the same words
h.picking = true; const pk = h.pickFile(); await new Promise((r) => setTimeout(r, 1500));
const mine = fs.readFileSync(`${APP}/data/mod-hub/pick/pid.txt`, "utf8").trim();
ok(/^\d+$/.test(mine), "our osascript PID was recorded: " + mine);
await h.killPick(); const res = await Promise.race([pk, new Promise((r) => setTimeout(() => r("TIMEOUT"), 20000))]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
ok(res === null, "pickFile returned (cancelled) instead of waiting: " + String(res));
ok(!alive(Number(mine)), "our osascript is gone");
ok(alive(decoy.pid), "the unrelated look-alike process is still alive (pkill -f would have killed it)");
try { process.kill(decoy.pid); } catch {} h.picking = false;
const before2 = Object.keys(log.filter((l) => l[0] === "pkill")).length; ok(before2 === 0, "pkill is never used");

console.log("\n== 8. catalog data from the network is validated");
fetchImpl = async () => ({ ok: true, json: async () => ({ mods: [ null, 5, { owner: "o", repo: "r", name: { x: 1 }, modNames: "notalist", stars: "many", url: 5, path: "a b/../x", blurb: "z".repeat(5000) }, { owner: "ok", repo: "fine", modNames: ["m1"], stars: 3, url: "https://github.com/ok/fine", path: "p/q", defaultBranch: "main" }, { owner: "e", repo: "v", path: "x\ny", modNames: ["../.."] } ] }) });
h.catalog = null; h.busy = false; h.loadCatalog(cxStub); await settle();
ok(Array.isArray(h.catalog) && h.catalog.length === 3, `malformed entries cleaned or dropped (${h.catalog?.length} kept)`);
ok(h.catalog.every((e) => Array.isArray(e.modNames) && typeof e.stars === "number" && typeof e.name === "string" && e.blurb.length <= 400), "every entry has the expected types and bounded size");
ok(h.catalog.every((e) => !e.modNames.some((m) => m.includes("/") || m === "..")), "unsafe mod names removed");
ok(h.prompt({ owner: "e", repo: "v", path: "x\ny" }) === null && h.prompt({ owner: "o", repo: "r", path: "a b" }) === null, "prompt refused for names with newline/space");
ok(h.srcUrl({ url: "file:///etc/passwd" }) === null && h.srcUrl({ url: "https://evil.com/a/b" }) === null, "source link refused unless it is https://github.com/…");

console.log("\n== 9. quick successive saves all land, none rejected");
await h.scan(cxStub); h.groups = { g: [] }; h.sel = "g"; await h.loadState(true); h.groups = { g: [] };
h.stateRaw = await readTextFile(h.stateFile); for (const m of ["good-a", "good-b", "-rf"]) h.toggleMember("g", m, cxStub); await settle();
const saved = JSON.parse(fs.readFileSync(`${APP}/data/mod-hub/state.json`, "utf8")); ok(saved.groups.g.length === 3 && !h.msg.includes("Could not save"), "3 rapid edits => 3 members saved: " + JSON.stringify(saved.groups.g));

// ---------- ground truth: what changed on disk, and was any of it outside the allowed places?
console.log("\n== 10. ground truth: diff of the whole sandbox before/after");
await settle(); const after = snap(SB); const changed = [];
for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k]) changed.push(k);
const rel = (p) => path.relative(SB, p); const allowed = [rel(`${APP}/mods`), rel(`${APP}/data/mod-hub`), "outdir", "fake.log", "fake.log.clip"];
const outside = changed.filter((k) => !allowed.some((a) => k === a || k.startsWith(a + "/")) && !k.startsWith(rel(`${APP}/mods`)));
ok(outside.length === 0, "nothing changed outside mods/, data/mod-hub/ and the chosen export folder" + (outside.length ? ": " + outside.join(", ") : ""));
ok(Object.keys(before).filter((k) => k.startsWith("canary")).every((k) => before[k] === after[k]), "every decoy file/link under canary/ is byte-identical");
const pwned = []; const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { if (e.name === "PWNED") pwned.push(path.join(p, e.name)); if (e.isDirectory()) walk(path.join(p, e.name)); } }; walk(SB);
ok(pwned.length === 0, "no file named PWNED anywhere (command substitution in a name never executed)");
ok(violations.length === 0, "no forbidden command was run" + (violations.length ? ": " + violations.join("; ") : ""));
const destructive = log.filter((l) => ["rm", "cp", "touch", "kill"].includes(l[0]) || (l[0] === "sh" && /\b(mv|rm|touch|kill|printf)\b/.test(l[2] || "")));
const roots = [`${APP}/mods`, `${APP}/data/mod-hub`, OUT];
const stray = []; for (const l of destructive) for (const a of l.slice(l[0] === "sh" ? 4 : 1)) if (typeof a === "string" && a.startsWith("/") && !roots.some((r) => a === r || a.startsWith(r + "/") || a.startsWith(r + "-"))) stray.push(l[0] + " -> " + a);
ok(stray.length === 0, `all ${destructive.length} file-modifying commands only had arguments inside the allowed folders` + (stray.length ? ": " + [...new Set(stray)].slice(0, 5).join("; ") : ""));

console.log("\n== 11. clipboard and links use Herdr's own API (no shell), and fail softly");
const n0 = log.length;
const prompt = "Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/o/r";
clip = undefined; h.copy(prompt, cxStub); await settle();
ok(clip === prompt && h.copied === true, "Copy prompt wrote exactly the prompt to the clipboard through cx.write_to_clipboard");
clipFails = true; h.copied = false; h.copy(prompt, cxStub); await settle();
ok(h.copied === false && /copy it by hand/i.test(h.msg), "when the clipboard is unavailable the user is told, nothing throws");
clipFails = false; clip = undefined; h.startImport(cxStub); await settle();
ok(!h.importing && /no text/i.test(h.msg), "Paste with an empty clipboard says so and starts no import");
clip = "not json {{{"; h.startImport(cxStub); await settle();
ok(!h.importing && !!h.msg, "Paste with garbage shows an error and starts no import: " + h.msg);
clip = JSON.stringify({ format: "mod-hub-groups", version: 1, groups: { t: ["good-a", "menu", "$(touch PWNED)"] } }); h.startImport(cxStub); await settle();
ok(h.importing && h.importing.length === 1 && h.importing[0].mods.join() === "good-a", "Paste of a valid export previews only the safe member");
ok(!log.slice(n0).some((l) => /pbcopy|pbpaste/.test(l.join(" "))), "no pbcopy/pbpaste command was run");

console.log("\n== 12. non-macOS: macOS-only features are inert");
const L = load("linux"); const hl = new L(); hl.init({}, cxStub); await settle();
const nl = log.length; hl.importFile(cxStub); await settle();
ok(!hl.picking && !log.slice(nl).some((l) => /osascript/.test(l.join(" "))), "Import file does nothing on Linux and never runs osascript");
clip = JSON.stringify({ format: "mod-hub-groups", version: 1, groups: { t: ["good-a"] } }); hl.startImport(cxStub); await settle();
ok(!!hl.importing && hl.importing.length === 1, "Paste import still works on Linux (it only uses the clipboard)");

console.log(`\nSANDBOX: ${SB}\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
if (failures === 0 && !process.env.KEEP) fs.rmSync(SB, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
