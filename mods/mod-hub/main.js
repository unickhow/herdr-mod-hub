// Mod Hub: enable/disable mods, group them, remove them, and browse community mods (copies the add-this-mod prompt for your agent).
// Right-click a row in Installed for actions. Open it with: herdr-app do mod.open --name mod-hub   (or bind a key to mod.open {name:"mod-hub"}).
// "Disabled" = the folder is moved to data/mod-hub/disabled/; "enabled" = moved back into mods/.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, appHome, readTextFile, writeTextFile, theme, props, closeOverlay, shared, setShared, pickFolder, window as appWindow } from "herdr";

const SELF = "mod-hub";
// Only the file chooser (osascript) and "Reveal in Finder" are macOS-only. Clipboard and links use Herdr's own API.
const MAC = (() => { try { return appWindow().platform === "macos"; } catch { return false; } })();
const INDEX_URL = "https://assets.herdr.dev/mods/index.json";
const SAFE = /^(?!\.)[A-Za-z0-9._-]+$/;            // a folder name: never "." or "..", never hidden
const ENTRY = /^(?!\.)[A-Za-z0-9._-]+__\d+$/;       // a folder in removed/: <name>__<epoch>
const cleanName = (x) => (typeof x === "string" ? x.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "").trim() : "");
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PICK_TAG = "Choose a Mod Hub group export";

export default class ModHub extends View {
  init(_props, cx) {
    this.home = appHome();
    this.modsDir = `${this.home}/mods`;
    this.hubDir = `${this.home}/data/mod-hub`;
    this.offDir = `${this.hubDir}/disabled`;
    this.removedDir = `${this.hubDir}/removed`;
    this.removed = [];        // "<name>__<epoch>" folders that can still be restored
    this.saveChain = Promise.resolve();
    this.pendingSaves = 0;     // saves queued or running; a rescan must not overwrite unsaved edits
    this.scanning = false; this.scanAgain = false; this.backedUp = false;
    this.picking = false;
    this.closed = false;
    this.showBuiltin = false;  // built-in mods are folded away by default
    this.menuFrom = null;      // a click on a row's "⋯" button
    this.limit = 40;           // how many catalog rows are shown
    this.refreshing = false;
    this._lastMsg = ""; this._msgId = 0;
    this.stateFile = `${this.hubDir}/state.json`;
    this.stateRaw = null;
    this.groups = {};
    this.enabled = [];
    this.disabled = [];
    this.bundled = new Set();
    this.layoutUse = {};      // mod -> [layout names]
    this.deps = {};           // mod -> [other mods whose code references it]
    this.tab = "installed";
    this.sel = null;          // selected group
    this.armed = null;        // "<action>:<name>" waiting for a second click
    this.ctx = null;          // right-click menu: { name, x, y }
    this.rowHit = null;
    this.from = null;         // tab to go back to after viewing a prompt
    this.importing = null;    // parsed import waiting for confirmation
    this.picks = new Set();   // ticked members of the shown group (for bulk actions)
    this.inMenu = false;
    this.size = { width: 780, height: 620 };
    this.msg = "";
    this.busy = false;
    this.catalog = null;
    this.catalogErr = "";
    this.pending = null;      // catalog entry whose add-this-mod prompt is shown
    this.search = InputState.new({ placeholder: "Search community mods…" });
    this.search.on("change", (_e, cx) => { this.limit = 40; cx.notify(); });
    this.newGroup = InputState.new({ placeholder: "New group name…" });
    this.newGroup.on("submit", (_e, cx) => this.createGroup(cx));
    this.handle = cx.focus_handle();
    this.refresh(cx);
  }

  // ---------- data ----------
  refreshAll(cx) {
    if (this.catalogErr) { this.catalogErr = ""; this.loadCatalog(cx); }
    this.refresh(cx);
  }

  // One scan at a time; a request that arrives meanwhile triggers exactly one more run afterwards.
  refresh(cx) {
    if (this.scanning) { this.scanAgain = true; return; }
    this.scanning = true; this.refreshing = true;
    cx.timer.after(15000, (cx) => { if (this.refreshing) { this.refreshing = false; cx.notify(); } });   // never stay stuck on "Refreshing…"
    cx.spawn(async (cx) => {
      try { await this.scan(cx); }
      catch (e) { this.msg = `Could not read the mod list: ${e}`; }
      this.scanning = false; this.refreshing = false;
      if (this.scanAgain) { this.scanAgain = false; this.refresh(cx); }
      cx.notify();
    });
  }

  async scan(cx) {
    await exec("mkdir", ["-p", this.offDir, this.removedDir]);
    const ls = async (d) => {
      try { const r = await exec("ls", ["-1", d]); return r.code === 0 ? r.stdout.split("\n").filter((x) => x && !x.startsWith(".")) : []; }
      catch { return []; }
    };
    this.enabled = (await ls(this.modsDir)).sort();
    this.disabled = (await ls(this.offDir)).sort();
    this.removed = (await ls(this.removedDir)).sort().reverse();
    try {
      const inst = JSON.parse((await readTextFile(`${this.home}/installed.json`)) || "{}");
      this.bundled = new Set(Object.keys(inst).filter((k) => !k.startsWith("layout:")));
    } catch { this.bundled = new Set(); }
    try {
      const r = await exec("sh", ["-c", 'grep -H -o -E \'"mod" *: *"[^"]+"\' "$1"/layouts/*.json 2>/dev/null || true', "_", this.home]);
      this.layoutUse = {};
      for (const l of r.stdout.split("\n")) {
        const m = l.match(/\/layouts\/([^/]+)\.json:"mod" *: *"([^"]+)"/);
        if (m) (this.layoutUse[m[2]] ||= []).includes(m[1]) || this.layoutUse[m[2]].push(m[1]);
      }
    } catch { this.layoutUse = {}; }
    try {
      // which mods' code mentions another mod (assets "mods/<n>/", "mod: \"<n>\"", "mod.open:<n>"); only inside mods/
      const r = await exec("sh", ["-c", `grep -r -H -o -E 'mods/[A-Za-z0-9._-]+/|mod"? *: *"[A-Za-z0-9._-]+"|mod\\.open:[A-Za-z0-9._-]+' --include=*.js --exclude-dir=node_modules --exclude-dir=.git "$1" 2>/dev/null || true`, "_", this.modsDir]);
      const d = {};
      for (const l of r.stdout.split("\n")) {
        const f = l.match(/\/mods\/([^/]+)\/[^:]*:(.*)$/);
        if (!f) continue;
        const t = (f[2].match(/^mods\/([^/]+)\/$/) || f[2].match(/"([^"]+)"$/) || f[2].match(/open:(.+)$/) || [])[1];
        if (t && t !== f[1]) ((d[t] ||= new Set()).add(f[1]));
      }
      this.deps = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, [...v].sort()]));
    } catch { this.deps = {}; }
    if (JSON.stringify(shared("modhub.disabled") ?? []) !== JSON.stringify(this.disabled)) setShared("modhub.disabled", this.disabled);
    await this.loadState();
    const have = new Set([...this.enabled, ...this.disabled]);
    const missing = Object.values(this.groups).some((l) => l.some((m) => !have.has(m)));
    if (this.tab === "browse" || missing) this.loadCatalog(cx);
  }

  // Keep only well-formed groups: { "name": ["mod", ...] }. Returns the clean groups and whether anything was dropped.
  cleanGroups(g) {
    const out = {}; let dropped = false;
    if (!g || typeof g !== "object" || Array.isArray(g)) return { out, dropped: g !== undefined };
    for (const [k, v] of Object.entries(g)) {
      const key = cleanName(k);
      if (!key || key.length > 60 || BAD_KEYS.has(key) || !Array.isArray(v)) { dropped = true; continue; }
      const list = [...new Set(v.filter((m) => typeof m === "string" && SAFE.test(m) && m !== SELF && !this.bundled.has(m)))].slice(0, 200);
      if (list.length !== v.length) dropped = true;
      out[key] = list;
    }
    return { out, dropped };
  }

  async loadState(force = false) {
    const raw = await readTextFile(this.stateFile);
    if (!force && this.pendingSaves > 0) return;          // don't overwrite edits that haven't reached the disk yet
    this.stateRaw = raw;
    let st = null, bad = false;
    try { st = JSON.parse(raw || "{}"); } catch { bad = true; }
    if (!bad && (!st || typeof st !== "object" || Array.isArray(st))) bad = true;
    if (bad) { this.groups = {}; }
    else {
      const c = this.cleanGroups(st.groups);
      this.groups = c.out; bad = c.dropped;
      if (!this.tabLoaded) { this.tabLoaded = true; if (["installed", "groups", "browse"].includes(st.tab)) this.tab = st.tab; }
    }
    if (bad && raw && !this.backedUp) {                    // keep the original before the next save replaces it
      this.backedUp = true;
      const copy = `${this.stateFile}.corrupt-${Date.now()}`;
      const r = await exec("cp", [this.stateFile, copy]).catch(() => ({ code: 1 }));
      this.msg = r.code === 0 ? `The group list file had problems. A copy was kept as ${copy.split("/").pop()}.` : "The group list file had problems and could not be backed up.";
    }
    if (!this.sel || !this.groups[this.sel]) this.sel = Object.keys(this.groups).sort()[0] || null;
  }

  // Save the groups. Saves run one after another, so quick successive edits can't refuse each other.
  // If the file really changed on disk since we read it, say so, reload it, and report false.
  persist(cx, quiet = false) {
    this.pendingSaves++;
    const run = async () => {
      try { await this.saveState(); return true; }
      catch {
        if (!quiet) this.msg = "Could not save groups: the state file changed outside Mod Hub. It was reloaded, so your last change was not kept. Please redo it.";
        await this.loadState(true).catch(() => {});
        this.refresh(cx);
        cx.notify();
        return false;
      }
      finally { this.pendingSaves--; }
    };
    this.saveChain = this.saveChain.then(run, run);
    return this.saveChain;
  }

  async saveState() {
    const text = JSON.stringify({ groups: this.groups, tab: this.tab }, null, 2);
    await writeTextFile(this.stateFile, text, this.stateRaw);
    this.stateRaw = text;
  }

  usedBy(n) {
    const ds = (this.deps[n] || []).filter((d) => d !== SELF && this.isOn(d));
    const ls = this.layoutUse[n] || [];
    const parts = [];
    if (ds.length) parts.push(`mod ${ds.join(", ")}`);
    if (ls.length) parts.push(`layout ${ls.join(", ")}`);
    return parts.join(" and ");
  }

  reload(name, cx) {
    if (!SAFE.test(name) || name === SELF || !this.enabled.includes(name)) return;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", '[ -f "$1" ] && touch -c -h "$1"', "_", `${this.modsDir}/${name}/main.js`]).catch(() => ({ code: 1 }));
      this.msg = r.code === 0 ? `Reloaded ${name}` : `Could not reload ${name}`;
      cx.notify();
    });
  }

  // The only names Mod Hub will ever move, restore or delete: plain folder names of mods that are really
  // there, and that are neither Herdr's own (built-in) nor Mod Hub itself.
  manageable(n) {
    return typeof n === "string" && SAFE.test(n) && n !== SELF && !this.bundled.has(n) && (this.enabled.includes(n) || this.disabled.includes(n));
  }

  userMods() { return [...this.enabled, ...this.disabled].filter((n) => !this.bundled.has(n) && n !== SELF); }
  isOn(n) { return this.enabled.includes(n); }
  // Wait for a second click; the confirm state expires after 5 s.
  arm(key, cx) {
    this.armed = key;
    cx.timer.after(5000, (cx) => { if (this.armed === key) { this.armed = null; this.msg = ""; cx.notify(); } });
  }
  say(cx, m) { this.msg = m; cx.notify(); }

  // Esc / "back": undo the innermost thing on screen. Returns false when there is nothing left to leave.
  back(cx) {
    if (this.ctx) { this.ctx = null; }
    else if (this.picking) { return this.cancelPick(cx), true; }
    else if (this.importing) { this.importing = null; }
    else if (this.pending) { this.pending = null; this.copied = false; if (this.from) { this.tab = this.from; this.from = null; } }
    else if (this.armed) { this.armed = null; this.msg = ""; }
    else if (this.tab === "browse" && this.search.value()) { this.search.set_value(""); }
    else return false;
    cx.notify(); return true;
  }

  canGoBack() {
    return !!(this.ctx || this.picking || this.importing || this.pending || this.armed || (this.tab === "browse" && this.search.value()));
  }

  // ---------- actions ----------
  async setEnabled(name, on) {
    if (!this.manageable(name)) return false;
    const from = on ? `${this.offDir}/${name}` : `${this.modsDir}/${name}`;
    const to = on ? `${this.modsDir}/${name}` : `${this.offDir}/${name}`;
    const r = await exec("sh", ["-c", `{ [ -e "$1" ] || [ -L "$1" ]; } && [ ! -e "$2" ] && [ ! -L "$2" ] && mv "$1" "$2"`, "_", from, to]);
    return r.code === 0;
  }

  toggle(name, cx) {
    if (!this.manageable(name)) return this.say(cx, `"${name}" can't be enabled or disabled here (built-in, Mod Hub itself, or an unsupported folder name).`);
    const on = this.isOn(name);
    const key = `off:${name}`;
    const ub = this.usedBy(name);
    if (on && ub && this.armed !== key) { this.arm(key, cx); return this.say(cx, `"${name}" is used by ${ub}. Disabling may leave broken buttons. Click again to disable anyway.`); }
    this.armed = null;
    cx.spawn(async (cx) => {
      const ok = await this.setEnabled(name, !on).catch(() => false);
      this.msg = ok ? `${on ? "Disabled" : "Enabled"} ${name}` : `Could not ${on ? "disable" : "enable"} ${name}: its folder is missing or a copy already exists at the destination.`;
      this.refresh(cx);
    });
  }

  // Removing moves the folder to data/mod-hub/removed/ so it can be restored.
  remove(name, cx) {
    if (!this.manageable(name)) return this.say(cx, `"${name}" can't be removed here (built-in, Mod Hub itself, or an unsupported folder name).`);
    const key = `rm:${name}`;
    if (this.armed !== key) { this.arm(key, cx); return this.say(cx, `Click Remove again to remove "${name}"${this.usedBy(name) ? ` (used by ${this.usedBy(name)})` : ""}. You can restore it afterwards.`); }
    this.armed = null;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'ts=$(date +%s); while [ -e "$4/$3__$ts" ] || [ -L "$4/$3__$ts" ]; do ts=$((ts+1)); done; for d in "$1/$3" "$2/$3"; do if [ -e "$d" ] || [ -L "$d" ]; then mv "$d" "$4/$3__$ts" && exit 0; fi; done; exit 1', "_", this.modsDir, this.offDir, name, this.removedDir]).catch(() => ({ code: 1 }));
      if (r.code !== 0) { this.msg = `Could not remove ${name}: its folder was not found.`; return this.refresh(cx); }
      for (const g of Object.keys(this.groups)) this.groups[g] = this.groups[g].filter((m) => m !== name);
      if (!(await this.persist(cx))) return;
      this.msg = `Removed ${name}. Restore it from "Recently removed" at the bottom of Installed.`; this.refresh(cx);
    });
  }

  restore(entry, cx) {
    const m = entry.match(/^(.+)__\d+$/);
    if (!m || !ENTRY.test(entry)) return;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", '{ [ -e "$1/$2" ] || [ -L "$1/$2" ]; } && [ ! -e "$3/$4" ] && [ ! -L "$3/$4" ] && [ ! -e "$5/$4" ] && [ ! -L "$5/$4" ] && mv "$1/$2" "$3/$4"', "_", this.removedDir, entry, this.modsDir, m[1], this.offDir]).catch(() => ({ code: 1 }));
      this.msg = r.code === 0 ? `Restored ${m[1]}.` : `Could not restore ${m[1]}: a mod with that name already exists.`;
      this.refresh(cx);
    });
  }

  purge(entry, cx) {
    if (!ENTRY.test(entry)) return;
    const key = `purge:${entry}`;
    if (this.armed !== key) { this.arm(key, cx); return this.say(cx, "Click again to delete it permanently. This cannot be undone."); }
    this.armed = null;
    cx.spawn(async (cx) => {
      const r = await exec("rm", ["-rf", `${this.removedDir}/${entry}`]).catch(() => ({ code: 1 }));
      this.msg = r.code === 0 ? "Deleted permanently." : "Could not delete it.";
      this.refresh(cx);
    });
  }

  createGroup(cx) {
    const n = cleanName(this.newGroup.value());
    if (!n) return this.say(cx, "Type a name for the group first.");
    if (n.length > 60) return this.say(cx, "Group names can be at most 60 characters.");
    if (BAD_KEYS.has(n) || Object.prototype.hasOwnProperty.call(this.groups, n)) return this.say(cx, `A group named "${n}" already exists.`);
    this.groups[n] = []; this.sel = n; this.newGroup.set_value("");
    cx.spawn(async (cx) => { if (await this.persist(cx)) cx.notify(); });
  }

  deleteGroup(g, cx) {
    const key = `delg:${g}`;
    if (this.armed !== key) { this.arm(key, cx); return this.say(cx, `Click Delete group again to delete "${g}" (its ${this.groups[g].length} member(s) are listed only here). Mods themselves are not touched.`); }
    this.armed = null;
    delete this.groups[g]; if (this.sel === g) this.sel = Object.keys(this.groups).sort()[0] || null;
    cx.spawn(async (cx) => { if (await this.persist(cx)) cx.notify(); });
  }

  toggleMember(g, m, cx) {
    const a = this.groups[g] || [];
    this.groups[g] = a.includes(m) ? a.filter((x) => x !== m) : [...a, m];
    this.picks.delete(m);
    cx.spawn(async (cx) => { if (await this.persist(cx)) cx.notify(); });
  }

  // ---------- export / import ----------
  exportJson(names) {
    const groups = {};
    for (const n of names) if (this.groups[n]) groups[n] = [...this.groups[n]];
    return JSON.stringify({ format: "mod-hub-groups", version: 1, groups }, null, 2);
  }

  // Ask for a folder, write the JSON there (never overwriting), and also copy it to the clipboard.
  exportGroups(names, label, cx) {
    if (!names.length) return this.say(cx, "No groups to export.");
    const text = this.exportJson(names);
    cx.spawn(async (cx) => {
      let dir = null;
      try { dir = await pickFolder({ prompt: "Save here" }); } catch (e) { this.msg = `Could not open the folder picker: ${e}`; return cx.notify(); }
      if (!dir) { this.msg = "Export cancelled."; return cx.notify(); }
      const base = `${dir}/mod-hub-groups-${label.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
      const w = await exec("sh", ["-c", 'set -C; f="$2"; n=1; while [ -e "$f" ]; do f="${2%.json}-$n.json"; n=$((n+1)); done; printf "%s\\n" "$1" > "$f" && printf %s "$f"', "_", text, base]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      this.msg = w.code === 0
        ? `Saved to ${w.stdout}`
        : `Could not save there: ${(w.stderr || "").trim().slice(-160) || "write failed"}`;
      cx.notify();
    });
  }

  // Validate pasted JSON. Returns { groups } or { error }.
  parseImport(text) {
    let j;
    try { j = JSON.parse(text); } catch { return { error: "The clipboard doesn't hold valid JSON. Copy an exported group first." }; }
    if (!j || j.format !== "mod-hub-groups" || typeof j.groups !== "object" || Array.isArray(j.groups)) return { error: "That JSON isn't a Mod Hub group export." };
    if (j.version !== 1) return { error: `Unsupported export version: ${j.version}.` };
    const out = Object.create(null); let skipped = 0;
    const entries = Object.entries(j.groups).slice(0, 50);
    for (const [name, list] of entries) {
      const key = cleanName(name);
      if (!key || key.length > 60 || BAD_KEYS.has(key) || !Array.isArray(list)) continue;
      const clean = [...new Set(list.filter((m) => typeof m === "string" && SAFE.test(m) && m !== SELF && !this.bundled.has(m)))].slice(0, 200);
      skipped += list.length - clean.length;
      out[key] = clean;
    }
    if (!Object.keys(out).length) return { error: "The export has no usable groups." };
    return { groups: out, skipped };
  }

  // Turn parsed groups into a plan; a clashing name gets a number, existing groups stay as they are.
  planFrom(groups) {
    const taken = new Set(Object.keys(this.groups)), plan = [];
    for (const [name, mods] of Object.entries(groups)) {
      let final = name, i = 2;
      while (taken.has(final)) final = `${name} (${i++})`;
      taken.add(final);
      plan.push({ from: name, name: final, mods });
    }
    return plan;
  }

  startImport(cx) {
    let text;
    try { text = cx.read_from_clipboard(); } catch { text = undefined; }
    if (typeof text !== "string" || !text.trim()) { this.msg = "The clipboard holds no text. Copy an exported group first."; return cx.notify(); }
    const p = this.parseImport(text);
    if (p.error) { this.msg = p.error; return cx.notify(); }
    this.importing = this.planFrom(p.groups); this.importSkipped = p.skipped; this.msg = ""; cx.notify();
  }

  // macOS file chooser via osascript. exec() is limited to 30 s, so the dialog runs in the
  // background and we poll for its result file instead.
  async pickFile() {
    const dir = `${this.hubDir}/pick`;
    await exec("mkdir", ["-p", dir]);
    const out = `${dir}/result.txt`, rc = `${dir}/rc.txt`;
    const pidFile = `${dir}/pid.txt`;
    await exec("rm", ["-f", out, rc, pidFile]);
    const script = `tell me to activate\nPOSIX path of (choose file with prompt "${PICK_TAG}" of type {"public.json", "json"})`;
    await exec("sh", ["-c", '( osascript -e "$1" > "$2" 2>/dev/null & p=$!; echo $p > "$4"; wait $p; echo $? > "$3" ) >/dev/null 2>&1 &', "_", script, out, rc, pidFile]);
    for (let i = 0; i < 20 && !this.closed; i++) {       // up to ~5 minutes, waiting 15 s at a time
      await exec("sh", ["-c", 'n=0; while [ ! -s "$1" ] && [ $n -lt 50 ]; do sleep 0.3; n=$((n+1)); done', "_", rc]).catch(() => {});
      const code = (await readTextFile(rc).catch(() => null)) ?? "";
      if (code.trim() !== "") {
        if (code.trim() !== "0") return null;           // cancelled (or osascript unavailable)
        return ((await readTextFile(out)) || "").trim() || null;
      }
    }
    return null;
  }

  // Stop the chooser: kill the one osascript we started (found by the PID we saved, and only if that
  // process really is our osascript). When it dies, the background shell writes a non-zero exit code itself.
  async killPick() {
    await exec("sh", ["-c", 'p=$(cat "$1" 2>/dev/null); case "$p" in ""|*[!0-9]*) exit 0;; esac; c=$(ps -p "$p" -o command= 2>/dev/null); case "$c" in *osascript*"$2"*) kill "$p";; esac', "_", `${this.hubDir}/pick/pid.txt`, PICK_TAG]).catch(() => {});
  }

  cancelPick(cx) {
    this.killPick();
    this.msg = "Import cancelled."; cx.notify();
  }

  // Choose a Mod Hub export file, then show the import preview.
  importFile(cx) {
    if (this.picking || !MAC) return;
    this.picking = true;
    cx.spawn(async (cx) => {
      this.msg = "Choose the exported .json file in the window that just opened…"; cx.notify();
      let path = null;
      try { path = await this.pickFile(); } catch (e) { this.picking = false; this.msg = `Could not open the file chooser: ${e}`; return cx.notify(); }
      this.picking = false;
      if (this.closed) return;
      if (!path) { this.msg = "Import cancelled."; return cx.notify(); }
      const text = await readTextFile(path).catch(() => null);
      if (text === null) { this.msg = "Could not read that file (is it larger than 1 MB?)."; return cx.notify(); }
      const p = this.parseImport(text);
      if (p.error) { this.msg = p.error; return cx.notify(); }
      this.importing = this.planFrom(p.groups); this.importSkipped = p.skipped; this.msg = ""; cx.notify();
    });
  }

  async close() {
    this.closed = true;
    if (this.picking) await this.killPick();
  }

  confirmImport(cx) {
    const plan = this.importing; if (!plan) return;
    for (const p of plan) this.groups[p.name] = p.mods;
    this.sel = plan[0].name; this.importing = null; this.picks = new Set();
    if (plan.some((p) => p.mods.some((m) => !this.enabled.includes(m) && !this.disabled.includes(m)))) this.loadCatalog(cx);
    cx.spawn(async (cx) => {
      if (await this.persist(cx)) { this.msg = `Imported ${plan.length} group(s).`; cx.notify(); }
    });
  }

  // Enable or disable every ticked mod of the group.
  setGroup(g, on, cx) {
    const members = this.groups[g] || [];
    const base = (this.picks.size ? members.filter((m) => this.picks.has(m)) : members).filter((m) => this.manageable(m));
    const sel = base.filter((m) => this.isOn(m) !== on);
    if (!sel.length) return this.say(cx, members.length ? (on ? "Already enabled." : "Already disabled.") : "This group has no mods yet. Add some below.");
    const risky = on ? [] : sel.filter((m) => this.usedBy(m));
    const key = `bulk:${g}`;
    if (risky.length && this.armed !== key) {
      this.arm(key, cx); return this.say(cx, `${risky.map((m) => `"${m}" (used by ${this.usedBy(m)})`).join("; ")}. Click Disable selected again to continue.`);
    }
    this.armed = null;
    cx.spawn(async (cx) => {
      let n = 0;
      for (const m of sel) if (await this.setEnabled(m, on)) n++;
      this.msg = `${on ? "Enabled" : "Disabled"} ${n} mod(s)`; this.refresh(cx);
    });
  }

  // The community entry that provides a mod folder name (most starred wins).
  entryFor(name) {
    return (this.catalog || []).find((e) => (e.modNames || []).includes(name)) || null;
  }

  showPrompt(entry, cx) {
    this.pending = entry; this.copied = false; this.from = this.tab; this.tab = "browse"; this.msg = "";
    cx.notify();
  }

  // Catalog data comes from the network, so every field is checked before it reaches the UI.
  cleanEntry(e) {
    if (!e || typeof e !== "object") return null;
    const str = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
    const c = {
      owner: str(e.owner, 100), repo: str(e.repo, 100), fullName: str(e.fullName, 200), url: str(e.url, 300),
      defaultBranch: str(e.defaultBranch, 100), path: str(e.path, 300), blurb: str(e.blurb, 400),
      stars: Number.isFinite(e.stars) ? e.stars : 0,
      modNames: Array.isArray(e.modNames) ? e.modNames.filter((x) => typeof x === "string" && SAFE.test(x)).slice(0, 50) : [],
    };
    c.name = str(e.name, 100) || c.repo;
    c.hay = `${c.name} ${c.owner} ${c.modNames.join(" ")} ${c.blurb}`.toLowerCase();   // searched on every keystroke
    return c.owner && c.repo ? c : null;
  }

  loadCatalog(cx) {
    if (this.catalog || this.busy) return;
    this.busy = true;
    const id = (this.catId = (this.catId || 0) + 1);
    cx.timer.after(20000, (cx) => {                      // a request that never answers must not block retries
      if (this.busy && this.catId === id) { this.busy = false; this.catId++; this.catalogErr = "Could not load catalog: it took too long. Press Refresh to retry."; cx.notify(); }
    });
    cx.spawn(async (cx) => {
      let list = null, err = "";
      try {
        const r = await fetch(INDEX_URL);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!j || !Array.isArray(j.mods)) throw new Error("unexpected format");
        list = j.mods.slice(0, 5000).map((e) => this.cleanEntry(e)).filter(Boolean).sort((a, b) => b.stars - a.stars);
      } catch (e) { err = `Could not load catalog: ${e}`; }
      if (this.catId !== id) return;                     // timed out meanwhile: ignore the late answer
      this.catId++; this.busy = false;
      if (list) this.catalog = list; else this.catalogErr = err;
      cx.notify();
    });
  }

  // Same wording as herdr.dev: the person's own agent reads the recipe and installs it.
  // Catalog fields come from other people's repos, so anything unusual is refused rather than pasted.
  prompt(e) {
    const segs = (e.path || "").split("/").filter(Boolean);
    if (![e.owner, e.repo, ...segs].every((x) => typeof x === "string" && SAFE.test(x))) return null;
    return `Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/${e.owner}/${e.repo}${segs.length ? `--${segs.join("--")}` : ""}`;
  }

  srcUrl(e) {
    if (typeof e.url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(e.url)) return null;
    const ok = (x) => typeof x === "string" && /^[A-Za-z0-9._\/-]+$/.test(x) && !x.includes("..");
    return e.path && ok(e.path) && ok(e.defaultBranch) ? `${e.url}/tree/${e.defaultBranch}/${e.path}` : e.url;
  }

  copy(text, cx) {
    let ok = false;
    try { cx.write_to_clipboard(text); ok = true; } catch { ok = false; }
    this.copied = ok;
    this.msg = ok ? "Prompt copied. Paste it to your agent." : "Could not copy. Select the text and copy it by hand.";
    cx.notify();
  }

  // ---------- ui bits ----------
  btn(t, id, label, onClick, tone) {
    const c = tone === "danger" ? t.blocked : tone === "primary" ? t.accent : t.muted;
    return h_flex().id(id).px(12).h(30).flex_none().items_center().justify_center().rounded(7).border_1().cursor_pointer()
      .border_color(tone === "primary" ? t.accent : t.border).bg(t.surface)
      .text_size(12).text_color(c).hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  tabBtn(t, key, label) {
    const on = this.tab === key;
    return h_flex().id(`tab-${key}`).px(14).h(30).items_center().justify_center().rounded(7).text_size(12.5).cursor_pointer()
      .bg(on ? t.selected : t.popover).text_color(on ? t.foreground : t.muted)
      .on_click((_e, cx) => { this.tab = key; this.from = null; this.armed = null; if (key !== "browse") this.pending = null;
        if (key === "browse") { this.loadCatalog(cx); cx.timer.after(200, () => this.search.focus()); } else { this.refresh(cx); if (key === "groups") cx.timer.after(200, () => { if (!Object.keys(this.groups).length) this.newGroup.focus(); }); }
        cx.notify(); cx.spawn(async (cx) => { await this.persist(cx, true); }); })
      .child(label);
  }

  row(t, id, left, right) {
    return h_flex().id(id).min_h(46).px(12).py(6).gap(12).items_center().justify_between().rounded(8).bg(t.surface).hover((s) => s.bg(t.hover))
      .child(left).child(h_flex().gap(6).flex_none().items_center().children(right));
  }

  dot(t, on) { return div().w(8).h(8).rounded(4).flex_none().bg(on ? t.done : t.dim); }

  moreBtn(t, n) {
    return h_flex().id(`mo-${n}`).w(30).h(30).flex_none().items_center().justify_center().rounded(7).border_1().border_color(t.border).bg(t.surface)
      .cursor_pointer().text_size(15).text_color(t.muted).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e) => { this.menuFrom = { name: n, x: e.position.x, y: e.position.y, same: this.ctx?.name === n }; })
      .child("⋯");
  }

  installedTab(t) {
    const names = [...this.enabled, ...this.disabled].filter((n) => n !== SELF).sort();
    const mine = names.filter((n) => !this.bundled.has(n)), built = names.filter((n) => this.bundled.has(n));
    const mk = (n) => {
      const on = this.isOn(n), locked = this.bundled.has(n), odd = !SAFE.test(n);
      const tags = [on ? null : "disabled", locked ? null : (this.usedBy(n) ? `used by ${this.usedBy(n)}` : null), ...Object.keys(this.groups).filter((g) => this.groups[g].includes(n)).map((g) => `#${g}`)].filter(Boolean);
      return this.row(t, `m-${n}`,
        h_flex().gap(8).items_center().min_w(0).child(this.dot(t, on))
          .child(div().text_size(13).text_color(on ? t.foreground : t.muted).truncate().child(n))
          .child(div().text_size(11.5).text_color(on ? t.muted : t.working).truncate().child(tags.join("  "))),
        odd
          ? [div().text_size(11.5).text_color(t.working).child("unsupported name"), this.moreBtn(t, n)]
        : locked
          ? [div().text_size(11.5).text_color(t.muted).child("built-in"), this.moreBtn(t, n)]
          : [this.btn(t, `t-${n}`, this.armed === `off:${n}` ? "Confirm disable" : on ? "Disable" : "Enable", (cx) => this.toggle(n, cx), this.armed === `off:${n}` ? "danger" : on ? undefined : "primary"), this.moreBtn(t, n)]
      ).on_mouse_down("right", () => { this.rowHit = n; });
    };
    const head = (txt, sub) => h_flex().px(4).gap(8).items_baseline().child(div().text_size(12).font_semibold().text_color(t.foreground).child(txt)).child(div().text_size(11.5).text_color(t.muted).child(sub || ""));
    const gone = this.removed.map((entry) => {
      const m = entry.match(/^(.+)__(\d+)$/);
      const name = m ? m[1] : entry, when = m ? new Date(Number(m[2]) * 1000).toLocaleString() : "";
      return this.row(t, `rm-${entry}`,
        v_flex().gap(1).min_w(0).child(div().text_size(13).text_color(t.muted).truncate().child(name)).child(div().text_size(11.5).text_color(t.muted).child(`removed ${when}`)),
        [this.btn(t, `rs-${entry}`, "Restore", (cx) => this.restore(entry, cx), "primary"),
         this.btn(t, `pg-${entry}`, this.armed === `purge:${entry}` ? "Confirm delete" : "Delete forever", (cx) => this.purge(entry, cx), "danger")]);
    });
    return v_flex().gap(6)
      .child(div().px(4).pb(4).text_size(11.5).text_color(t.muted).child("Disable moves a mod aside so Herdr stops loading it; Enable brings it back. Nothing is deleted. Use ⋯ or right-click a row for more."))
      .child(head("Your mods", `${mine.length}`))
      .children(mine.length ? mine.map(mk) : [div().px(8).py(6).text_size(12).text_color(t.muted).child("No mods of your own yet. Find some in Browse community.")])
      .child(h_flex().id("builtin-head").mt(10).px(4).h(28).gap(6).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.showBuiltin = !this.showBuiltin; cx.notify(); })
        .child(div().w(12).text_size(11).text_color(t.muted).child(this.showBuiltin ? "▾" : "▸"))
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Built-in"))
        .child(div().text_size(11.5).text_color(t.muted).child(`${built.length} · part of Herdr, can't be disabled or removed`)))
      .when(this.showBuiltin, (el) => el.children(built.map(mk)))
      .when(gone.length > 0, (el) => el.child(div().mt(10).px(4).text_size(12).font_semibold().text_color(t.foreground).child(`Recently removed (${gone.length})`)).children(gone));
  }

  ctxItem(t, id, label, onDown, opts = {}) {
    return h_flex().id(id).h(32).px(10).gap(8).flex_none().items_center().rounded(6)
      .text_size(12.5).text_color(opts.danger ? t.blocked : opts.dim ? t.dim : t.foreground)
      .when(!opts.dim, (el) => el.hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => onDown(cx)))
      .child(h_flex().w(14).flex_none().items_center().text_color(t.accent).child(opts.check ? "✓" : ""))
      .child(div().flex_1().min_w(0).truncate().child(label));
  }

  ctxMenu(t) {
    const n = this.ctx.name, odd = !SAFE.test(n), locked = this.bundled.has(n) || n === SELF || odd, on = this.isOn(n);
    const close = (cx) => { this.ctx = null; cx.notify(); };
    const sep = (k) => div().h(1).my(4).bg(t.border).id(`sep-${k}`);
    const items = [];
    if (locked) items.push(this.ctxItem(t, "c-ro", odd ? "Unsupported folder name · manage it in Finder" : "Built-in · read-only", () => {}, { dim: true }));
    else {
      items.push(this.ctxItem(t, "c-toggle", this.armed === `off:${n}` ? "Click again to confirm disable" : on ? "Disable" : "Enable", (cx) => { this.toggle(n, cx); if (this.armed !== `off:${n}`) this.ctx = null; }, { danger: this.armed === `off:${n}` }));
      const gs = Object.keys(this.groups).sort();
      items.push(sep("g"));
      items.push(this.ctxItem(t, "c-gh", gs.length ? "Groups" : "No groups yet (create one in Groups)", () => {}, { dim: true }));
      for (const g of gs) items.push(this.ctxItem(t, `c-g-${g}`, g, (cx) => this.toggleMember(g, n, cx), { check: this.groups[g].includes(n) }));
    }
    if (on && !odd) items.push(this.ctxItem(t, "c-reload", "Reload", (cx) => { this.reload(n, cx); close(cx); }));
    items.push(sep("f"));
    if (MAC) items.push(this.ctxItem(t, "c-open", "Reveal in Finder", (cx) => { exec("open", ["-R", `${this.isOn(n) ? this.modsDir : this.offDir}/${n}`]); close(cx); }));
    if (!locked) items.push(this.ctxItem(t, "c-rm", this.armed === `rm:${n}` ? "Click again to remove (can be restored)" : "Remove…", (cx) => { this.remove(n, cx); if (!this.armed) this.ctx = null; }, { danger: true }));
    const W = 240, H = 44 + items.length * 34;
    const x = Math.max(4, Math.min(this.ctx.x, this.size.width - W - 8));
    const y = Math.max(4, Math.min(this.ctx.y, this.size.height - H - 8));
    return v_flex().id("ctx").absolute().left(x).top(y).w(W).p(6).gap(1).rounded(10).border_1().border_color(t.border).bg(t.popover)
      .on_mouse_down("left", () => { this.inMenu = true; })
      .on_mouse_down("right", () => { this.inMenu = true; })
      .child(h_flex().px(10).h(24).items_center().text_size(11).text_color(t.dim).child(div().truncate().child(n)))
      .children(items);
  }

  groupsTab(t) {
    const names = Object.keys(this.groups).sort();
    const g = this.sel && this.groups[this.sel] ? this.sel : null;
    const left = v_flex().w(230).flex_none().h_full().min_h(0).gap(8)
      .child(h_flex().gap(6).items_center()
        .child(Input.new(this.newGroup).flex_1().min_w(0).h(30).px(10).rounded(7).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground))
        .child(this.btn(t, "g-add", "Add", (cx) => this.createGroup(cx), "primary")))
      .child(h_flex().gap(6)
        .when(MAC, (r) => r.child(this.picking
          ? this.btn(t, "g-impf", "Cancel", (cx) => this.cancelPick(cx), "danger")
          : this.btn(t, "g-impf", "Import file…", (cx) => this.importFile(cx))))
        .child(this.btn(t, "g-imp", "Paste", (cx) => { if (!this.picking) this.startImport(cx); })))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(4).children(names.map((n) => {
        const members = this.groups[n], inst = members.filter((m) => this.enabled.includes(m) || this.disabled.includes(m));
        const on = inst.length ? inst.filter((m) => this.isOn(m)).length : 0, gone = members.length - inst.length;
        return h_flex().id(`g-${n}`).h(40).cursor_pointer().px(12).flex_none().items_center().justify_between().gap(8).rounded(8)
          .bg(this.sel === n ? t.selected : t.surface).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.sel = n; this.armed = null; this.picks = new Set(); cx.notify(); })
          .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).truncate().child(n))
          .child(div().flex_none().text_size(11).text_color(gone ? t.working : t.dim).child(inst.length || !gone ? `${on}/${inst.length} on${gone ? ` · ${gone} missing` : ""}` : `${gone} missing`));
      })));
    const mods = this.userMods();
    const members = g ? [...this.groups[g]] : [];
    const others = mods.filter((m) => !members.includes(m));
    const here = (m) => mods.includes(m);
    const inst = members.filter(here), missing = members.length - inst.length;
    const picked = inst.filter((m) => this.picks.has(m));
    const all = inst.length > 0 && picked.length === inst.length, some = picked.length > 0 && !all;
    const word = picked.length ? `selected (${picked.length})` : `all (${inst.length})`;
    const box = (state, id, onClick) => h_flex().id(id).w(16).h(16).flex_none().rounded(4).border_1().cursor_pointer()
      .border_color(state ? t.accent : t.border).bg(state ? t.accent : t.background).items_center().justify_center()
      .text_size(11).text_color(t.accent_foreground).on_click((_e, cx) => onClick(cx)).child(state === "some" ? "–" : state ? "✓" : "");
    const label = (txt) => div().text_size(11.5).font_medium().text_color(t.dim).child(txt);
    const empty = (txt) => div().px(8).py(6).text_size(12).text_color(t.dim).child(txt);
    const imp = this.importing;
    const right = imp
      ? v_flex().flex_1().min_w(0).h_full().min_h(0).gap(10).p(12).rounded(10).bg(t.surface)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child(`Import ${imp.length} group(s)?`))
          .child(div().text_size(11.5).text_color(t.dim).child(`Nothing is installed or changed besides the group list. Existing groups are kept; a clashing name gets a number.${this.importSkipped ? ` ${this.importSkipped} name(s) of built-in mods or unsupported names were left out.` : ""}`))
          .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(8).children(imp.map((p, i) =>
            v_flex().id(`imp-${i}`).gap(4).p(10).flex_none().rounded(8).bg(t.background)
              .child(div().text_size(13).font_medium().text_color(t.foreground).child(p.name === p.from ? p.name : `${p.from}  →  ${p.name}`))
              .child(div().text_size(12).text_color(t.muted).child(p.mods.length ? p.mods.map((m) => (here(m) ? m : `${m} (not installed)`)).join(", ") : "empty group")))))
          .child(h_flex().gap(8)
            .child(this.btn(t, "imp-ok", "Import", (cx) => this.confirmImport(cx), "primary"))
            .child(this.btn(t, "imp-no", "Cancel", (cx) => { this.importing = null; cx.notify(); })))
      : !g
      ? v_flex().flex_1().h_full().items_center().justify_center().rounded(10).bg(t.surface)
          .child(div().text_size(12.5).text_color(t.dim).child("Create a group on the left to get started."))
      : v_flex().flex_1().min_w(0).h_full().min_h(0).gap(10).p(12).rounded(10).bg(t.surface)
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).text_size(14).font_semibold().text_color(t.foreground).truncate().child(g))
            .child(this.btn(t, "g-exp", "Export…", (cx) => this.exportGroups([g], g, cx)))
            .child(this.btn(t, "g-del", this.armed === `delg:${g}` ? "Confirm delete" : "Delete group", (cx) => this.deleteGroup(g, cx), "danger")))
          .child(label(`Members (${members.length}${missing ? ` · ${missing} not installed` : ""})`))
          .when(inst.length > 0, (el) => el.child(h_flex().h(36).px(8).gap(10).items_center().rounded(7).bg(t.background)
            .child(box(all ? true : some ? "some" : false, "g-all", (cx) => { this.picks = all ? new Set() : new Set(inst); cx.notify(); }))
            .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.muted).child(picked.length ? `${picked.length} of ${inst.length} selected` : "Select all"))
            .child(this.btn(t, "g-on", `Enable ${word}`, (cx) => this.setGroup(g, true, cx), "primary"))
            .child(this.armed === `bulk:${g}`
              ? this.btn(t, "g-off", "Confirm disable", (cx) => this.setGroup(g, false, cx), "danger")
              : this.btn(t, "g-off", `Disable ${word}`, (cx) => this.setGroup(g, false, cx)))))
          .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(2)
            .children(members.length === 0 ? [empty("No mods in this group yet. Add some from the list below.")] : members.map((m) => {
              const on = this.isOn(m), miss = !here(m);
              if (miss) return h_flex().id(`gm-${m}`).h(40).px(8).flex_none().gap(10).items_center().rounded(7)
                .child(box(false, `gb-${m}`, () => {}).opacity(0.35))
                .child(div().flex_1().min_w(0).text_size(13).text_color(t.dim).truncate().child(m))
                .child(div().text_size(11).text_color(t.working).child(this.bundled.has(m) ? "built-in" : "not installed"))
                .child(this.bundled.has(m) ? div().text_size(11).text_color(t.dim).child("can't be managed") : this.catalog
                  ? (this.entryFor(m)
                      ? this.btn(t, `gp-${m}`, "Get prompt", (cx) => this.showPrompt(this.entryFor(m), cx), "primary")
                      : div().text_size(11).text_color(t.dim).child("not in catalog"))
                  : div().text_size(11).text_color(t.dim).child(this.catalogErr ? "catalog unavailable" : "looking up…"))
                .child(h_flex().id(`gx-${m}`).w(26).h(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
                  .text_size(12).text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.blocked))
                  .on_click((_e, cx) => this.toggleMember(g, m, cx)).child("✕"));
              return h_flex().id(`gm-${m}`).h(40).px(8).flex_none().gap(10).items_center().rounded(7).hover((s) => s.bg(t.hover))
                .child(box(this.picks.has(m), `gb-${m}`, (cx) => { this.picks.has(m) ? this.picks.delete(m) : this.picks.add(m); cx.notify(); }))
                .child(div().flex_1().min_w(0).text_size(13).text_color(on ? t.foreground : t.muted).truncate().child(m))
                .child(this.dot(t, on))
                .child(this.btn(t, `gt-${m}`, this.armed === `off:${m}` ? "Confirm disable" : on ? "Disable" : "Enable", (cx) => this.toggle(m, cx), this.armed === `off:${m}` ? "danger" : on ? undefined : "primary"))
                .child(h_flex().id(`gx-${m}`).w(26).h(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
                  .text_size(12).text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.blocked))
                  .on_click((_e, cx) => this.toggleMember(g, m, cx)).child("✕"));
            })))
          .child(div().h(1).bg(t.border))
          .child(label(`Add to this group (${others.length})`))
          .child((others.length > 0 ? v_flex().flex_1() : v_flex().flex_none().h(30)).min_h(0).overflow_y_scrollbar().gap(2)
            .children(others.length === 0 ? [empty(mods.length ? "Every mod is already in this group." : "No installable mods. Built-in mods can't be grouped.")] : others.map((m) =>
              h_flex().id(`ga-${m}`).h(38).px(8).flex_none().gap(10).items_center().rounded(7).hover((s) => s.bg(t.hover))
                .child(div().flex_1().min_w(0).text_size(13).text_color(t.muted).truncate().child(m))
                .child(this.btn(t, `gadd-${m}`, "+ Add", (cx) => this.toggleMember(g, m, cx))))));
    return h_flex().flex_1().min_h(0).gap(14).child(left).child(right);
  }

  browseTab(t) {
    if (this.catalogErr) return v_flex().gap(10).p(10).items_start()
      .child(div().text_size(12.5).text_color(t.blocked).child(this.catalogErr))
      .child(this.btn(t, "cat-retry", "Retry", (cx) => this.refreshAll(cx), "primary"));
    if (!this.catalog) return div().text_size(12.5).text_color(t.dim).child("Loading community catalog…");
    if (this.pending) {
      const e = this.pending, text = this.prompt(e), src = this.srcUrl(e);
      return v_flex().gap(12).p(10)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child(e.name))
          .child(div().text_size(11.5).text_color(t.dim).child(`${e.owner} · ★ ${e.stars}`)))
        .child(div().text_size(12.5).text_color(t.muted).child(e.blurb || ""))
        .child(div().text_size(11.5).text_color(t.dim).child("Paste this prompt to your agent. It reads each file first and tells you if the mod reaches the network or runs programs."))
        .child(div().id("prompt-box").p(12).rounded(8).border_1().border_color(t.border).bg(t.background)
          .text_size(12.5).text_color(text ? t.foreground : t.blocked)
          .child(text || "This entry has an unusual name, so no prompt is offered. Open its source and check it yourself."))
        .child(h_flex().gap(8)
          .when(!!text, (r) => r.child(this.btn(t, "p-copy", this.copied ? "Copied ✓" : "Copy prompt", (cx) => this.copy(text, cx), "primary")))
          .when(!!src, (r) => r.child(this.btn(t, "p-open", "View source", (cx) => cx.open_url(src))))
          .child(this.btn(t, "p-no", "Back", (cx) => { this.pending = null; this.copied = false; this.msg = ""; if (this.from) { this.tab = this.from; this.from = null; } cx.notify(); })));
    }
    const q = this.search.value().trim().toLowerCase();
    const have = new Set([...this.enabled, ...this.disabled]);
    const matches = this.catalog.filter((e) => !q || e.hay.includes(q));
    const hits = matches.slice(0, this.limit), left = matches.length - hits.length;
    const summary = q ? `${matches.length} match${matches.length === 1 ? "" : "es"} for "${this.search.value().trim()}"` : `${this.catalog.length} community mods`;
    return v_flex().gap(2)
      .child(div().text_size(11.5).text_color(t.muted).px(10).pb(4).child(`${summary} · most starred first${left > 0 ? ` · showing ${hits.length}` : ""}`))
      .when(matches.length === 0, (el) => el.child(v_flex().gap(10).p(10).items_start()
        .child(div().text_size(12.5).text_color(t.muted).child(`Nothing in the community catalog matches "${this.search.value().trim()}".`))
        .child(this.btn(t, "no-hit-clear", "Clear search", (cx) => { this.search.set_value(""); cx.notify(); }))))
      .children(hits.map((e) => {
        const same = (e.modNames || []).length > 0 && e.modNames.every((n) => have.has(n));
        return this.row(t, `c-${e.fullName}-${e.path}`,
          v_flex().gap(2).min_w(0).flex_1()
            .child(h_flex().gap(8).items_baseline().child(div().text_size(13).text_color(t.foreground).child(e.name)).child(div().text_size(11.5).text_color(t.muted).child(`${e.owner} · ★ ${e.stars}`))
              .when(same, (r) => r.child(div().text_size(11.5).text_color(t.done).child("✓ a mod with this name is installed"))))
            .child(div().text_size(11.5).text_color(t.muted).truncate().child(e.blurb || "")),
          [this.btn(t, `i-${e.fullName}-${e.path}`, "Get prompt", (cx) => { this.pending = e; this.copied = false; cx.notify(); }, same ? undefined : "primary")]);
      }))
      .when(left > 0, (el) => el.child(h_flex().mt(8).justify_center()
        .child(this.btn(t, "more", `Show ${Math.min(40, left)} more (${left} left)`, (cx) => { this.limit += 40; cx.notify(); }))));
  }

  msgColor(t) {
    const m = this.msg;
    if (/^(could not|no |that json|the clipboard|the export|unsupported|import cancelled|export cancelled|this entry)/i.test(m)) return t.blocked;
    if (/^(enabled|disabled|removed|restored|deleted|imported|saved|reloaded|prompt copied|copied)/i.test(m)) return t.done;
    return t.accent;
  }

  render(cx) {
    const t = theme();
    if (this.msg !== this._lastMsg) {                    // a new message: clear it after a while
      this._lastMsg = this.msg; const id = ++this._msgId;
      if (this.msg && !this.armed && !this.picking) cx.timer.after(7000, (cx) => { if (this._msgId === id) { this.msg = ""; cx.notify(); } });
    }
    const body = this.tab === "installed" ? this.installedTab(t) : this.tab === "groups" ? this.groupsTab(t) : this.browseTab(t);
    return v_flex().id("hub").relative().track_focus(this.handle).size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(12)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_key_down((e, cx) => { if (e.key === "escape" && !this.back(cx)) closeOverlay(props().overlay); })
      .on_mouse_down("right", (e, cx) => {
        if (this.inMenu) { this.inMenu = false; return; }
        if (this.rowHit && this.tab === "installed" && e.bounds) {
          this.ctx = { name: this.rowHit, x: e.position.x - e.bounds.x, y: e.position.y - e.bounds.y };
        } else this.ctx = null;
        this.rowHit = null; cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        if (this.menuFrom) {                              // the ⋯ button of a row: open (or close) its menu
          const m = this.menuFrom; this.menuFrom = null; this.inMenu = false;
          this.ctx = m.same || !e.bounds ? null : { name: m.name, x: m.x - e.bounds.x - 190, y: m.y - e.bounds.y + 14 };
          return cx.notify();
        }
        if (this.inMenu) { this.inMenu = false; return; }
        if (this.ctx) { this.ctx = null; cx.notify(); }
      })
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Mod Hub"))
        .child(h_flex().gap(10).items_center()
          .child(this.btn(t, "refresh", this.refreshing ? "Refreshing…" : "Refresh", (cx) => this.refreshAll(cx)))
          .child(div().text_size(11).text_color(t.dim).child(this.canGoBack() ? "Esc to go back" : "Esc to close"))))
      .child(h_flex().gap(6).items_center()
        .child(this.tabBtn(t, "installed", `Installed (${this.enabled.length + this.disabled.length - (this.enabled.includes(SELF) ? 1 : 0)})`))
        .child(this.tabBtn(t, "groups", `Groups (${Object.keys(this.groups).length})`))
        .child(this.tabBtn(t, "browse", "Browse community"))
        .child(div().flex_1())
        .when(this.tab === "browse" && this.catalog && !this.pending, (el) => el.child(
          h_flex().w(260).h(30).pl(10).pr(4).gap(4).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
            .child(Input.new(this.search).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
            .when(this.search.value().length > 0, (b) => b.child(
              h_flex().id("search-clear").w(22).h(22).flex_none().items_center().justify_center().rounded(11).cursor_pointer()
                .text_size(12).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => { this.search.set_value(""); this.search.focus(); cx.notify(); }).child("✕"))))))
      .child(this.tab === "groups"
        ? v_flex().flex_1().min_h(0).child(body)
        : v_flex().id("scroll").flex_1().min_h(0).overflow_y_scrollbar().child(body))
      .child(div().h(32).flex_none().overflow_hidden().pt(8).border_t(1).border_color(t.border).text_size(12).text_color(this.msgColor(t)).child(this.msg || " "))
      .when(!!this.ctx && this.tab === "installed", (el) => el.child(this.ctxMenu(t)));
  }
}
