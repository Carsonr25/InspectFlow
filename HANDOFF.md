# InspectFlow — Project Handoff

Context dump for continuing work in Claude Code. Covers the QAQC analyzer tool and the marketing site.

---

## 1. What this is

**InspectFlow** — a construction QAQC inspection tool. Single-file HTML app (no build step, no backend except Supabase for saved inspections). An inspector opens a plan sheet PDF, marks up the items they're inspecting, and the app uses Claude's vision API to sort those markups into types and generate a field inspection.

**Core value prop:** you highlight the symbols, AI does the sorting and classification automatically, and out comes an inspection ready for the field app.

---

## 2. Current file — start here

**`QAQC_Analyzer_v7.html`** ← this is the live version. ~490KB single file.

### Version lineage (all in the same folder)

| File | What changed |
|---|---|
| `QAQC_Analyzer_FIXED.html` | **BROKEN — do not use.** Left mid-migration: new sidebar HTML with old JS. |
| `QAQC_Analyzer_v3.html` | Rebuilt item/session workflow from scratch |
| `QAQC_Analyzer_v4.html` | Fixed AI-analysis infinite hang; added detail/legend capture |
| `QAQC_Analyzer_v5.html` | Fixed "no confirmed markups to export" |
| `QAQC_Analyzer_v6.html` | Fixed AI not sorting into types |
| `QAQC_Analyzer_v7.html` | **CURRENT** — crop resolution/framing fix |

### Dead ends (ignore, don't delete yet)

- `InspectFlow_Fresh.html` — clean-slate rewrite attempt. Abandoned; zoom/pan was disabled mid-debug and never finished. The main file already had working zoom/pan, so this was unnecessary.
- `InspectFlow_QAQC_v2.html` — earlier simplified prototype
- `QAQC_Analyzer_BACKUP_*.html` — pre-item-workflow backups
- `QAQC_Analyzer_VECTOR_SEARCH_BACKUP.js` — stub note file, no real code

---

## 3. The workflow (as built)

Right sidebar, top to bottom:

1. **+ New Item** → prompts for a name ("Hold Downs"). Auto-assigns a color.
2. Click the item to expand → **✎ Mark Up** → drag boxes around each instance on the sheet.
3. Boxes persist on the sheet in that item's color. Each is listed under the item with individual delete.
4. **Done marking up** (or Enter; Esc cancels)
5. **+ Add to Session** → item is committed to the session
6. **Detail / Legend** section → **⬚ Highlight Detail** → drag a box around the detail or schedule. Claude reads this to name types.
7. **Create Inspection** → AI analysis → type verification screen → export

Colors auto-assign in order: red, green, blue, orange, violet, amber, pink, teal. Swatches allow manual override but shouldn't be needed.

---

## 4. Architecture — the thing you must understand

### Two parallel data models

This app has **two ways findings can exist**, and nearly every bug so far came from code reading the wrong one:

```js
// LEGACY — template-matching scanner only.
// Populated by the original vector/template scan flow.
let findings = [];

// CURRENT — manual markup workflow.
let inspectionItems = [];   // [{id, name, color, boxes:[{x,y,w,h}], inSession, baseImg, detailImg}]
let qaqcSession   = [];     // rebuilt from inspectionItems by syncSessionFromItems()
```

**Manual markups never touch the global `findings` array.** Three separate bugs were all the same root cause: a code path checking `findings.length` and reporting "nothing here" when the user's work was sitting in `inspectionItems`/`qaqcSession`.

Fixed readers so far:
- `addToQaqcSession()` — "No findings to add" (removed from the flow entirely)
- `doExportToFieldApp()` — "No confirmed markups to export" (now uses `_buildExportFindings()`)
- `createQaqcTemplate()` crop loop — hung on null `baseImg`

**If you hit another "nothing to X" error, check for `findings.length` first.** There may be more readers I didn't reach.

### Key functions (manual workflow)

| Function | Role |
|---|---|
| `promptForNewItem()` | Create item, assign color |
| `startMethodManualMarkup()` | Enter box-drawing mode |
| `finishManualMarkup()` / `cancelManualMarkup()` | Exit mode (boxes persist) |
| `addItemToSession(id)` | Snapshots sheet + detail image onto the item, commits to session |
| `syncSessionFromItems()` | Rebuilds `qaqcSession` from items; preserves non-manual scans |
| `_buildExportFindings()` | Flattens session → export list (session-first, legacy fallback) |
| `_lookupScanData(allData, query)` | Tolerant lookup of AI response keys |
| `drawMarkers()` | Draws ALL item boxes every render, plus detail outline |

### Session entry shape

`syncSessionFromItems()` produces entries matching what the legacy export/report code expects:

```js
{
  query: item.name,
  findingsCount: n,
  findingsSnap: [{x, y, w, h, score, label, typeKey?, typeColor?}],  // x,y are CENTER
  baseImg,          // sheet snapshot, captured on "Add to Session"
  detailImg,        // captured detail/legend
  templateSize: {w, h},   // average box size for the item
  types: [],        // filled by the AI step
  isManualMarkup: true,
  color, itemId
}
```

### AI pipeline

`startInspectionFlow()` → `createQaqcTemplate()` → `startTypeVerification()` → `confirmTypesAndCreateInspection()` → `doExportToFieldApp()`

`createQaqcTemplate()` sends: the detail/legend image, then one cropped image per markup (capped at 25), and asks Claude to return JSON grouping circle numbers into types with descriptive names:

```json
{"Hold Downs": {"4": {"name":"Type 4 Hold Down","circles":[1,3,5],"questions":[]}}}
```

Circle numbers are **1-based indices into `findingsSnap`**.

---

## 5. Bugs fixed — root causes worth knowing

**Infinite hang at "Sending to Claude for analysis…"**
Manual markups stored `baseImg: null`. The loop did `img.src = s.baseImg` and awaited `onload`. A null src fires neither `onload` nor `onerror`, so the promise never settled. Fixed with: real sheet snapshot on add, skip-if-missing guard, `onerror` handler, and a 15s timeout backstop.

**AI wasn't sorting into types**
Two causes. (1) The prompt literally instructed it not to — "If you cannot see any number or letter, that scan has exactly ONE type, place ALL circles in it" — and defined a type as *only* a printed character, with no visual grouping. (2) Results were looked up with `allData[s.query]`, an exact string match; any key drift returned `{}` and a fallback silently collapsed everything into one type. Both fixed.

**Crops unreadable**
`fpad = max(w,h) * 1.8` **per side** meant the crop was 4.6× the box — symbol at ~21% of frame — then downscaled to 500px, leaving the symbol ~108px regardless of box size. Plus double JPEG compression (0.85 snapshot → 0.92 crop). Now `PAD_RATIO 0.35`, `TARGET_PX 1100`, crops taken from the live canvas when possible, 0.95 quality. ~6× more pixels on the symbol.

---

## 6. Tunable constants

In `createQaqcTemplate()`, just above the crop loop:

```js
const PAD_RATIO=0.35,    // context around each box, per side, as fraction of box size
      TARGET_PX=1100,    // long edge of each crop (Claude vision caps ~1568px)
      MAX_UPSCALE=10;
const maxCrops=25;       // images per request — raising this costs tokens fast
```

If a type designator sits further from the symbol and gets clipped, raise `PAD_RATIO` to 0.5 — **don't** go back toward 1.8.

Sheet renders at `DESIRED_SCALE=7.0` (capped at 10000px) — there's real detail in the source.

---

## 7. Open issues / next up

**No persistence** — biggest gap. Everything lives in JS memory; closing the tab loses the PDF, items, boxes, and session. Two options discussed:
- `localStorage` for items/boxes/colors (PDF is the awkward part — large)
- Explicit Save/Load to a `.json` file alongside the plans

**Sorting accuracy not yet validated in the field.** v6+v7 changes are unverified against real plan sheets. If it still mis-sorts, check in this order: (1) are designators inside the cropped area — raise `PAD_RATIO`; (2) was a detail/legend captured; (3) log the raw AI JSON before `_lookupScanData` to see what keys came back.

**Text Search and Template Matching are parked.** Functions intact (`startMethodTextSearch`, `startMethodTemplateMatching`) but unreachable from the new sidebar. Intent is to reintegrate them later so they fill boxes into the same item buckets as manual markup.

**Snapshot timing gotcha.** `baseImg` is captured when you click "Add to Session." Capture the detail and finish marking an item *before* adding it.

**`QAQC_Analyzer_FIXED.html` is broken** — either delete it or restore from a backup, so nobody opens it by mistake.

**Version sprawl** — v3 through v7 in one folder. Worth collapsing to a single file under git.

---

## 8. Marketing site (separate track)

**`InspectFlow_Bold_Engineering.html`** — dark theme, accent `#ff6b35`.

- Hero: left orange border, white→orange gradient headline, benefit-focused copy (kept engineers on real QAQC work, not sales pressure)
- "How It Works" section was removed
- Logo: `INSPECT` white + `FLOW` orange

**Logo type:** no custom font. System stack `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` at `font-weight: 900`, `letter-spacing: -0.5px`. Web equivalents: Roboto 900 or Inter 900.

`inspectflow_logo.png` — 1884×152 raster export.

---

## 9. Conferences to target

- **Advancing Construction Quality 2026** — best fit; 9th edition, explicitly about QA/QC, inspections, and using AI/digital tools for inspection and reporting
- **Inspection Expo & Conference (IEC) 2026** — Feb 3–4, Austin TX; inspection community, welding/NDT focused
- **BuiltWorlds Construction Tech Conference** — has a Demo Day pitch competition judged by VCs
- **ConExpo-Con/Agg** — Mar 3–7 2026, Las Vegas; ~140k attendees, very general
- **Construction Startup Competition 2026** — pitch days at multiple industry events

---

## 10. Suggested first moves in Claude Code

1. `git init` and commit `QAQC_Analyzer_v7.html` as the baseline
2. Delete or quarantine `QAQC_Analyzer_FIXED.html`
3. Test the full loop on a real sheet: new item → mark up → detail → add to session → create inspection
4. If sorting is still off, add `console.log(rawText)` right after the API response in `createQaqcTemplate()` and inspect the actual JSON before touching the prompt
5. Then persistence
