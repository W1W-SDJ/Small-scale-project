# Technical notes

Things that were non-obvious while building a transparent, always-on-top, click-through
window on Windows. Written down because each of them cost real debugging time, and none of
them are visible from the source alone.

Test environment for all numbers below: **Windows 11 (build 26100), a single 2560x1600
display at 150 % scaling** — that is a DIP space of 1707x1067 and a device pixel ratio of 1.5.

---

## 1. Dragging: drive it from the main process

The obvious implementation is to listen to `mousemove` in the renderer and move the window by
the pointer delta. That fails in a specific and annoying way: the window is *chasing* the
pointer, so it moves out from under the cursor, and the deltas stop corresponding to reality.
It also accumulates error on a fractional display scale.

Instead, the renderer only reports *press* and *release*; the main process samples
`screen.getCursorScreenPoint()` every 8 ms and sets the window position so the grab point stays
under the pointer:

```js
dragOffset = { x: cursor.x - window.x, y: cursor.y - window.y }   // on press
win.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y) // every frame
```

Two requirements fall out of this:

- **`setPosition` accepts integers only.** Passing a fractional DIP value (for example
  `Math.round(v * 1.5) / 1.5` from a "snap to the physical pixel grid" attempt) throws
  `Error processing argument at index N, conversion failure from`, and because the throw happens
  inside a `setInterval` callback the frame is simply skipped — the pet silently lags the cursor
  and lands short of where you dragged it.
- **Pointer capture matters.** `setPointerCapture` on press is what guarantees the release is
  delivered even if the pointer outruns the window.

## 2. DIP ↔ physical rounding makes the window *grow* during a drag

This is the bug that produced "the pet gets bigger every time I drag it".

Windows stores window geometry in physical pixels. On a 150 % display, a DIP size of 171
(171 × 1.5 = 256.5) is not representable, so Windows picks a neighbouring integer and the DIP
size read back through `getBounds()` wobbles by a pixel. During a programmatic drag this
rounding is applied on *every* `setPosition` call, and the reported size oscillates:

```
resize -> 172x353
resize -> 172x354
resize -> 173x354
resize -> 172x352
```

Nothing put it back, so over a long drag (and many drags) the window ratcheted from
**171x352 DIP up to 371x508 DIP** — a 2.17× / 1.44× change that also broke the aspect ratio, so
it was not a scale but genuine growth. Because the sprite is sized as a percentage of the
window, the whole pet inflated with it and stayed that way.

The fix is a size guard, and the guard has a trap of its own:

```js
win.on('resize', () => {
  if (dragging) return                    // <- essential
  const b = win.getBounds()
  if (Math.abs(b.width - width) <= SIZE_TOLERANCE &&
      Math.abs(b.height - height) <= SIZE_TOLERANCE) return
  win.setBounds({ x: b.x, y: b.y, width, height })
})
```

**Do not resize the window while the pointer is captured.** Calling `setBounds` mid-drag
changed the geometry ~30 times per drag in testing, which cancelled the pointer capture,
ended the drag early, and produced duplicated `pointerdown` events. The result was a pet that
moved in random directions. Correct the size once, at drag end, when the pointer is free.

`SIZE_TOLERANCE` (2 DIP) is deliberate: the rounding wobble is not worth fighting, and a guard
that reacts to ±1 DIP turns into a resize storm that fights itself.

## 3. Click-through: use a baked bitmask, not a canvas

To let clicks pass through the transparent parts of the sprite, the alpha at the cursor has to
be known on every mouse move. The natural approach — draw the PNG into a canvas and call
`getImageData()` — **throws on a `file://` page**, because drawing a local image taints the
canvas. `fetch()` on `file://` is blocked as well, so the data cannot be pulled in that way
either.

What works: bake the mask at build time (`tools/mask.mjs` packs one bit per pixel into
`assets/sprite-mask.js`) and load it as an ordinary `<script>`, then decode with `atob()`.

```js
const solid = (SOLID[p >> 3] & (1 << (7 - (p & 7)))) !== 0
```

`setIgnoreMouseEvents(true, { forward: true })` is what makes the toggle possible in both
directions: while the window ignores the mouse it still receives forwarded *move* messages, so
the renderer can notice the cursor has come back over an opaque pixel and re-enable input.
On Windows this flag maps to `WS_EX_TRANSPARENT` — useful when debugging, because it can be
read from outside the process with `GetWindowLong(hwnd, GWL_EXSTYLE) & 0x20`.

Note that the hit test must map through `getBoundingClientRect()` rather than the image's
natural size, because the idle animation transforms the element.

## 4. Never show the window only from `ready-to-show`

`ready-to-show` requires the renderer to have produced a first paint. If that never happens —
a blocked DLL, GPU trouble, a failed load — a window created with `show: false` stays invisible
**forever while the process keeps running**. That is a miserable failure mode: Task Manager
shows four Electron processes and nothing on screen.

Show from whichever comes first:

```js
const showTimer = setTimeout(() => showPet('fallback timer'), SHOW_FALLBACK_MS)
win.once('ready-to-show', () => { clearTimeout(showTimer); showPet('ready-to-show') })
```

For a transparent window there is no white flash to avoid, so the fallback is cheap.

## 5. An uncaught error in the main process is a modal dialog

Electron's default handler for an uncaught main-process exception raises a blocking
"A JavaScript error occurred in the main process" dialog and leaves the process alive — the
user sees a scary box and a broken app, and nothing is logged anywhere.

```js
process.on('uncaughtException', (error) => diag(`UNCAUGHT ${error?.stack ?? String(error)}`))
process.on('unhandledRejection', (reason) => diag(`UNHANDLED REJECTION ${reason?.stack ?? reason}`))
```

Corollary: **diagnostics must never be able to kill the pet.** An early revision called a
non-existent `screen.getDisplayNearestWindow()` inside a logging statement; the resulting
`TypeError` killed window creation and the pet never appeared. Anything that merely computes a
value for the log belongs inside a `try`.

## 6. A windowed app needs a log file

There is no devtools and no console in normal use, so `%APPDATA%\Blob Pet\pet-diag.log`
records: `app.getAppPath()` / `userData` / argv at startup, requested vs. actual window
geometry and the display scale factor at creation, every `resize`/`will-resize`, every
drag start/end, and every uncaught error. Every bug described in this document was diagnosed
from that file, not from the UI.

## 7. Capturing a transparent window on Windows

Two independent traps, both of which produce a screenshot that simply *does not contain* the pet:

- **`Graphics.CopyFromScreen()` does not capture layered windows.** A transparent,
  always-on-top window is a layered window. `BitBlt` must be called with `CAPTUREBLT`
  (`0x40000000`) in addition to `SRCCOPY`.
- **DPI awareness.** `GetWindowRect` answers in physical pixels for a per-monitor-aware
  process and in virtualised coordinates otherwise. A DPI-unaware capture on this machine saw
  a 171x352 window and a 1707x1067 screen that does not exist; the DPI-aware one saw the real
  257x528 window on a 2560x1600 display. Mixing the two frames of reference silently crops the
  wrong region.

`tools/capture.ps1` sets `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` first, then captures
with `CAPTUREBLT`.

## 8. Testing mouse interaction by injecting input

`tools/dragtest.ps1` injects real input with `SetCursorPos` + `mouse_event`. Notes:

- **It takes over the user's cursor.** It is therefore dry-run by default and requires an
  explicit `-Yes`; it also saves and restores the cursor position in a `finally` block. Do not
  run it while somebody is using the machine.
- **Wait for the click-through state, do not sleep.** The pet ignores mouse events over
  transparent pixels, so a press only lands once the window has processed a move over an opaque
  one. A fixed 300 ms delay produced "the pet did not move" failures; polling
  `GWL_EXSTYLE & WS_EX_TRANSPARENT` until it clears fixed them.
- **PowerShell resolves names case-insensitively.** A C# helper named `LeftDown()` collides with
  a constant field named `LEFTDOWN`, and the method call is rejected with
  "does not contain a method named". Name them `PressLeft` / `ReleaseLeft`.
- **Partial movement means a skipped frame**, which in practice meant a thrown conversion error
  in the position update (see §1), not a lost mouse event.

## 9. Miscellaneous Windows notes

- `focusable: false` maps to `WS_EX_NOACTIVATE`: clicking the pet never steals focus from the
  window you are working in. A side effect is that a native popup menu cannot reliably take or
  release focus, which is why the quit control is an in-page button rather than
  `Menu.popup()`.
- `setAlwaysOnTop(true, 'screen-saver')` puts the pet above ordinary always-on-top windows.
- Smart App Control (enabled and enforcing on the test machine) logs CodeIntegrity events about
  Chromium's `vk_swiftshader.dll` not meeting signing requirements. It did not prevent the app
  from rendering, but it is the first thing to check if a packaged, unsigned build misbehaves.

## 10. Version 2: reading the sites (the feed engine)

Version 2 added a polling/summarising layer. Constraints that shaped it:

- **No new runtime dependencies.** The app ships as one portable exe and has to work offline. So
  the HTML understanding in `core/html.js` is hand-written: elements are cut out of the raw
  markup by walking their own tag depth, then scored by text density × (1 − link density). A
  container that is mostly links is navigation, whatever its class name says. A container with
  lots of text is the article. Known article classes (`article`, `TRS_Editor`, `vsb_content`,
  `zoom`) get a 1.9× multiplier rather than being trusted outright, because the same class names
  appear on navigation wrappers.
- **Charset, then decoding.** CAU serves UTF-8, but GBK (`gb2312`) pages are still common on
  Chinese university CMSes. `core/net.js` resolves the charset from the HTTP header, then the
  `<meta>` tag, then falls back to `gb18030` (which also covers `gbk`/`gb2312` in Node's ICU), then
  UTF-8. Getting this wrong produces mojibake that looks like a parser bug.
- **URL guessing is a scoring problem.** A list page's anchors are ranked, not filtered
  absolutely: 32-hex filenames and `/art/2024/`, `/ttgznew/` paths score high, `/col/col123/`
  column pages and `index.htm` score zero, and a date found within ~400 characters *before* the
  anchor adds points. Only the top-N unseen candidates are fetched, because detail pages are the
  expensive part.
- **The budget must be shared fairly.** The first implementation had a single global budget of 36
  detail fetches; the notice board (18 candidates) plus the news homepage (56) consumed all of it
  and the remaining two sources were never visited — silently. The loop now allocates
  `budget / remainingSites` per source. This is the kind of failure that produces no error and
  just "some sites never show up".
- **Recency must never be the only reason.** A date within 7 days adds 3 points. With a threshold
  of 3, that alone let completely off-topic items through. Items now need at least one keyword hit
  in the title (or a strong body match) before the recency bonus can matter.
- **Dates come from the detail page, not the list.** CAU's notice list splits the date into a day
  box and a month box (`22` + `2026.10`). Parsing only the month turned every item into the 1st of
  the month; the day has to be dug out of the adjacent markup. The detail page's
  `<meta name="PubDate">` is authoritative when present.
- **Titles need the same treatment in three places**: inside `<a>` labels (some templates put the
  date and category *inside* the link), in `<title>` (some templates append `- 通知公告 -
  中国农业大学`), and in news pages where `<title>` contains the first paragraph. `cleanLabel` and
  `cleanTitle` peel date/category/site segments repeatedly until stable, and the list label wins
  when it is a crisp prefix of an overlong page title.
- **Summaries are extractive on purpose.** With no model in the loop, the only honest option is to
  copy sentences: lead sentence for "what is this", then the highest-value sentences (deadline >
  eligibility > materials > contact). Every sentence is verbatim from the source, so a fabricated
  deadline or email address is impossible. `core/llm.js` is the optional upgrade and returns
  `null` on any failure, so the rule summary is always the floor.
- **Cross-source duplicates.** The same story is often linked from several sections with different
  URLs. Dedupe is URL-normalised *plus* a punctuation-stripped title fingerprint, checked both
  before fetching and again after extraction.
- **All fetching is in the main process.** Renderers get prepared JSON only, and the panel's
  `setWindowOpenHandler` denies popups and routes links through `shell.openExternal` with a
  protocol check.
- **Renderers can write to the log.** A desktop pet has no devtools. `window.pet.log()` forwards
  breadcrumbs to `pet-diag.log`, which is how the click-vs-drag path was verified from outside.

### Diagnosing "the panel did not open"

`pet:activate` is sent from the renderer's pointerup handler when the pointer moved < 6 px and was
held < 700 ms. Three independent things can break it, and the log distinguishes them:

1. No `drag-start` line → the click never reached the window (another window on top, or the pet
   was in click-through state because no mousemove had been processed yet).
2. `drag-start` but no `pointerup moved=…` line → the renderer never got the release.
3. Both, but no `activate received from renderer` → the IPC channel or preload is missing.

While verifying this from PowerShell, injected clicks missed because the helper process was
DPI-unaware: `SetCursorPos` and `GetWindowRect` are both virtualised then, so a coordinate taken
from a DPI-aware capture lands 1.5× off and `WindowFromPoint` returns 0. The click helper must set
`DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` before doing anything else.

## 11. Smart App Control blocks the packaged exe (not an app bug)

The packaged build refuses to start on this machine with no error dialog at all. Two facts explain
it:

```powershell
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy').VerifiedAndReputablePolicyState
# 1  -> enforcement (2 = evaluation/log only, 0 = off)

Get-AuthenticodeSignature .\dist\BlobPet-2.0.0-portable.exe | Select Status
# NotSigned
```

`Microsoft-Windows-CodeIntegrity/Operational` then logs **3033 / 3077** naming the exe, and
`Start-Process` fails with "An Application Control policy has blocked this file". The NSIS wrapper
extracts and launches our own unsigned `Blob Pet.exe`, so the inner binary is what gets blocked;
the wrapper just exits with code 1.

The workaround needs no security-setting change: our `electron.exe` is byte-identical to the official
release binary, and *that* binary carries reputation with Microsoft's service. This is worth stating
precisely because it is easy to get wrong — the official `electron.exe` is **not** Authenticode-signed
either (`Get-AuthenticodeSignature` reports `NotSigned` for it). What protects it is reputation, not a
signature, so changing a single byte throws the trust away: electron-builder rewrites the icon and
version resources, which is exactly why `win-unpacked\Blob Pet.exe` (sha256 `BE2556…`, 512 bytes
larger) is blocked while this folder form (sha256 `4E0699…`) runs.
`dist\BlobPet-2.0.0-folder\` is that form (see the README). This is also why "run from source" never
hit the problem: no unsigned image is loaded, only JS and the asar.

Practical consequence for delivery: a single-file exe is the nicer product but is only usable where
Smart App Control is off/permissive (or where the user explicitly allows it). The folder form is
the one that works everywhere without touching security settings.

## 12. Two log/lifecycle decisions that came out of debugging

- **The diagnostic log is append-only across launches.** It used to be rewritten per process, which
  silently destroyed the evidence of the very crash you restarted to investigate — the third
  restart in a row left only six lines. It is now appended, opens with a `--- session start ---`
  header, and is trimmed to the last ~1500 lines past 512 KB.
- **The digest panel is destroyed on close and recreated on open**, instead of hidden and shown.
  Reason: a transparent frameless window that has been hidden does not reliably repaint when shown
  again — Electron reported `isVisible() === true` while the window was absent from `EnumWindows`
  and invisible on screen. Recreating it guarantees a first paint, and the idle renderer goes away.

  Worth recording as a debugging lesson: for a while this looked like "the panel closes itself
  after ~6 seconds". It did not. The user was interacting with the pet on the desktop at the same
  time, and their click on ✕ was genuine. What settled it was logging
  `event.isTrusted` + click coordinates: `trusted=true at=372,34 target=close` while the injected
  cursor was parked elsewhere, plus `GetLastInputInfo` showing an idle time that kept resetting to
  0 ms. Instrument the *source* of an event before treating it as a bug in your own code.

## 13. Skins: variable sprites, variable windows

Making the sprite swappable exposed a coupling that v1 did not have to think about: the artwork,
the window size and the click-through mask were all baked from one PNG at build time.

- **The mask moved into the renderer, and that is what unlocked everything.** v1 pre-generated
  `assets/sprite-mask.js` because a canvas that has drawn a `file://` image is *tainted*, so
  `getImageData()` throws. But a `data:` URL does not taint it. So the main process reads the
  sprite and pushes it in as a data URL, the renderer decodes it, and `skinprep.js` packs a
  fresh 1-bit mask from the actual pixels. Result: any PNG is a skin, no build step, no
  per-skin mask file.
- **The window follows the sprite.** `PET_HEIGHT` stays 340 DIP and the width is derived from the
  aspect ratio (capped at `MAX_SPRITE_WIDTH`), plus `BUBBLE_WIDTH` for the bubble strip. Swapping
  pins the sprite's bottom-right corner so the pet does not appear to jump, then re-clamps into
  the work area.
- **The size guard has to stand down during a skin swap**, exactly like it stands down during a
  drag: a `resizingForSkin` flag skips the correction, otherwise the window gets fought over by
  two writers. Same class of bug as §1.
- **Skin registry** (`core/skins.js`): built-ins in `assets/skins/<id>/pet.png` beside a
  `meta.json`, imports in `%APPDATA%\Blob Pet\skins\<id>\`, ids namespaced `user:`. `resolve()`
  always falls back to the first available skin, so a deleted folder or a hand-edited config
  cannot leave the pet spriteless.

Two real bugs found while building this:

1. **UTF-8 BOM in `meta.json`.** `Set-Content -Encoding UTF8` in PowerShell 5.1 writes a BOM, and
   `JSON.parse` on the raw string throws — so every skin silently fell back to its directory name
   ("whale-omushi" instead of "鲸鱼娘·白米饭"). The store now strips `\uFEFF` before parsing. Any
   JSON file a *user* might edit deserves the same treatment on Windows.
2. **IPC sent to a window that had not loaded yet.** "换皮肤" created the panel and immediately
   sent `panel:section`; the renderer had not subscribed yet, so the message vanished and the panel
   opened on the digest list. Fixed by remembering the request and flushing it on
   `did-finish-load` (and sending immediately only when the page is already loaded).

### Turning artwork into a skin

One tool per failure mode, chained (see the README for the commands). The interesting one is
`tools/strip-lines.mjs`: the whale-girl art had decorative wave lines that survived both the flood
fill *and* connected-component cleanup, because they touch the subject — they are part of the same
component as the body. Thickness separates them (a squiggle is a few pixels tall per column, the
subject's pale areas are thick blobs), but thickness alone ate the pale wave pattern printed on
the rice bowl. The working rule needs both tests: pale + cool + thin **and** within 3 px of
transparent background. Printed artwork is thick and interior; decoration is thin and on the edge.

`tools/test-skinprep.cjs` runs the panel's own preparation code (canvas decode → matte → trim →
mask) inside a hidden BrowserWindow, because that code only exists in a browser context. It is the
difference between "the import path looks right" and "the import path produced a 607x761 sprite
with 35 % transparency from a white-background picture".
