# herdr-mod-hub — recipe

Build a Herdr mod called `mod-hub`: an overlay dialog (780×620) that manages installed mods.
`mod.json`: `{ "place": "none", "title": "Mod Hub", "overlay": { "kind": "dialog", "width": 780, "height": 620 } }`.
Optional key: `"cmd-shift-m": "mod.open:mod-hub"`. Preview: `preview.png`. Reference implementation: `main.js` in this folder.
Read `~/.config/herdr-app/AGENTS.md` first for the mod API. Verify with `herdr-app check <mod folder>`.

## Features
1. **Installed tab**: "Your mods", a collapsed "Built-in" list, "Recently removed". Each row: on/off dot, name, Enable/Disable, `⋯` and right-click menu (Enable/Disable, add/remove from groups, Reload for enabled mods, Reveal in Finder on macOS, Remove).
2. **Groups tab**: create/delete groups (delete needs a second click, the button text changes), list members with a per-row Disable/Enable and ✕, a "Select all" checkbox, Enable all / Disable all for the group (counts in the labels), an "add to this group" list.
3. **Browse tab**: fetch `https://assets.herdr.dev/mods/index.json` (20 s timeout), search box with ✕, first 40 results + "Show more", Retry on error. Selecting a mod shows the prompt
   `Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/<owner>/<repo>[--<path segments joined by -->]`
   with Copy prompt / View source / Back. **Never install anything.**
4. **Export / import groups**: JSON `{ "format": "mod-hub-groups", "version": 1, "groups": { name: [mods] } }`. Export through `pickFolder`; import by Paste (clipboard) and, on macOS only, Import file… via a background `osascript` chooser polled in 15 s chunks (`exec` is limited to 30 s) with a Cancel button. Import shows a preview and how many entries were skipped; mods not installed get a "Get prompt" button.
5. Footer status line (auto-clears after 7 s), Refresh button, Esc closes layer by layer.

## Data and behaviour
- Disable = move `mods/<n>` to `data/mod-hub/disabled/<n>`; Enable = move back; Remove = move to `data/mod-hub/removed/<n>__<epoch>`; Restore = move back; Purge = `rm -rf` of one `removed/` entry matching `^(?!\.)[A-Za-z0-9._-]+__\d+$`.
- State in `data/mod-hub/state.json` `{ groups: {name: [mods]}, tab }`, written with `writeTextFile(path, text, expected)`; serialise writes, and on a stale-write error show it and reload.
- Publish `shared("modhub.disabled")` (array of disabled names) with `setShared` so other mods can hide their own buttons.
- Scan `mods/`, `installed.json` (marks built-ins), layouts (which mod a layout uses) and mods' `main.js` (which mod reads another) to warn before disabling something in use.

## Safety rules (the part that must not be skipped)
- One guard `manageable(name)`: matches `^(?!\.)[A-Za-z0-9._-]+$`, exists, is not built-in, is not `mod-hub`. Every move/delete goes through it.
- Pass every name/path to `exec("sh", ["-c", script, "_", arg1, ...])` as positional parameters (`"$1"`), never concatenated into the script. No `eval`.
- Move only if the destination does not exist (`[ ! -e ] && [ ! -L ] && mv`); never overwrite. Pick a unique `removed/` suffix.
- Export: `set -C` (noclobber), numbered file names, filename characters limited to `[A-Za-z0-9._-]`.
- Reload: `[ -f "$1" ] && touch -c -h "$1"`; never creates a file.
- Kill only the `osascript` PID this mod saved, after checking `ps -p PID -o command=` contains `osascript` and the dialog title. Never `pkill -f`.
- Clipboard and URLs through `cx.write_to_clipboard`, `cx.read_from_clipboard`, `cx.open_url`; never `pbcopy`/`open` for URLs.
- Treat state.json, imported JSON and the catalog as hostile: validate shapes and types, drop built-ins/self/invalid names, cap lengths, strip control and bidi characters from group names, use `Object.create(null)` for parsed maps and reject `__proto__`/`constructor`/`prototype`. Keep a `state.json.corrupt-<time>` copy of a bad file.
- A source link is only shown if it matches `https://github.com/<owner>/<repo>`; a prompt is only built if every segment matches the name rule.
- Odd-named folders are listed as "unsupported name" with no destructive buttons.
