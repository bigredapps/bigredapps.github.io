# Setup Shuffler

Static PWA. Serve this folder over HTTPS (GitHub Pages, Netlify, ...) or locally with `python3 -m http.server`, then open it and use "Install"/"Add to Home Screen".

## Adding a game
1. Put `games/<name>.json` and any images in `games/img/` (image paths are relative to `games/`).
2. Add `"<name>.json"` to `games/index.json`.
3. Bump `V` in `sw.js` if you want installed copies to refresh the offline cache.

## Game JSON
- `name`, `description`, `icon` (emoji fallback), `image`
- `theme` (optional): any of `background`, `glow` (top of the background gradient), `panel`, `border`, `accent`, `accentText` (text on the accent button), `text`, `muted`, `warn` (CSS colours) and `font` (heading font-family stack). Omitted keys keep the defaults; light and dark themes both work.
- `compact` (optional, true/false): show every step's result beside its label instead of below it. A step can override this with `"inline": true/false`. Item notes appear as hover text only.
- `players`: `{min, max, default}`
- `options`: `{id, label, type: "choice"|"toggle"|"number", choices|min/max, default}`
- `pools`: named lists of items `{id, name, icon?, image?, note?, tags?, weight?, when?}`
- `setup`: ordered steps, each `{id, label, kind, pool, count, note, when}`
  - `kind`: `pick` (default), `perPlayer` (one each), `shuffle` (whole pool in random order), `number` (`min`,`max`), `text` (message, uses `text`)
  - `sort`: `true` (alphabetical by name) or `"id"` sorts the picked items for display; also settable game-wide as `sort`. Ignored for `shuffle`, whose order is the result.
  - `include`: `[{when, ids}]` forces the listed item ids into a pick step whenever the condition holds (e.g. a boss chosen earlier); the remaining count is drawn randomly. Put the step after the one it depends on.
  - `exclude`: `[{when, ids}]` removes the listed item ids from the step's pool whenever the condition holds. Works on every step kind; wins over `include` if both name the same item.
  - `unique` (default true), `tags` / `notTags` (filter pool by item tags), `excludeFrom: [stepIds]` (no repeats of earlier results)
- `constraints`: `[{cond, message}]`; the whole setup re-rolls until all hold

### Dynamic values (`count`, `min`, `max`)
`5` | `{min, max}` random range | `{by: ref, map: {"2": 3, "default": 4}}` | `{by: ref, mul, add}`
Expressions nest to any depth, including inside a `map`, e.g. `{by:"players", map:{"2":3, "default":{by:"opt:difficulty", map:{"easy":4, "hard":6}}}}`.

### Conditions (`when`, constraints)
`{ref, op, value}` combined with `{all: []}`, `{any: []}`, `{not: {}}`.
Refs: `players`, `opt:<id>`, `step:<id>` (picked item ids, or the number).
Ops: `==` (default), `!=`, `>`, `>=`, `<`, `<=`, `in`, `has`, `hasAny`, `hasTag` (picked items carry a tag).
Steps and pool items can use `when` to depend on options, player count or earlier steps. Re-rolling a step also re-rolls steps that depend on it.
Text and notes can embed `{players}`, `{opt:id}`, `{step:id}`.
