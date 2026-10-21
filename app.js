'use strict';
/*
 * Setup Shuffler: a generic board-game setup randomiser.
 *
 * Everything game-specific lives in a JSON file under games/ (see README.md). This file is the
 * engine that reads those files, rolls a random setup, and draws it on screen.
 *
 * How a setup is built
 * --------------------
 * A game's JSON lists "steps" in order. Rolling a setup runs each step once, top to bottom, and stores
 * the outcome in a "setup" object:
 *
 *   setup = {
 *     playerCount,      // the number of players chosen on screen
 *     optionValues,     // { optionId: chosenValue } for the game's options (choices, toggles, numbers)
 *     stepResults,      // { stepId: stepResult } filled in as each step runs
 *     allConstraintsMet // true if the final setup passed every rule in the game's "constraints"
 *   }
 *
 *   stepResult = {
 *     skipped,   // true if the step's "when" condition was false, so nothing was drawn
 *     items,     // the pool items that were picked (full objects)
 *     itemIds,   // just the ids of those items
 *     numberValue, // only for "number" steps
 *     warning    // optional message, e.g. when the pool ran out of items
 *   }
 *
 * Later steps can look at earlier steps' results, which is how interdependencies work.
 */

/* =====================================================================
 * Small helpers
 * ===================================================================== */

// Shorthand for document.querySelector.
const queryOne = selector => document.querySelector(selector);

// Make text safe to put inside HTML, so game files can't inject markup.
const escapeHtml = text => String(text ?? '').replace(/[&<>"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
}[character]));

// Random decimal from 0 (inclusive) up to `limit` (exclusive), using the browser's secure random source.
const randomBelow = limit => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 * limit;

// Random whole number from `low` to `high`, both included.
const randomIntInclusive = (low, high) => low + Math.floor(randomBelow(high - low + 1));

/* =====================================================================
 * Application state
 * ===================================================================== */

const gamesById = {};         // every loaded game JSON, keyed by game id
let currentGame = null;       // the game JSON being shown (null on the home screen)
let currentChoices = null;    // what the user picked on screen: { playerCount, optionValues }
let currentSetup = null;      // the most recent rolled setup (see the shape at the top of this file)

/* =====================================================================
 * References, conditions and numbers
 * These let a game's JSON refer to the player count, options and earlier results.
 * ===================================================================== */

/*
 * Look up the value a "ref" points at:
 *   "players"       -> the number of players
 *   "opt:<id>"      -> the current value of that option
 *   "step:<id>"     -> the number from a "number" step, otherwise the array of picked item ids
 * A skipped or not-yet-run step gives undefined.
 */
function resolveReference(reference, setup) {
  if (reference === 'players') return setup.playerCount;
  if (reference.startsWith('opt:')) return setup.optionValues[reference.slice('opt:'.length)];
  if (reference.startsWith('step:')) {
    const stepResult = setup.stepResults[reference.slice('step:'.length)];
    if (!stepResult || stepResult.skipped) return undefined;
    return stepResult.numberValue !== undefined ? stepResult.numberValue : stepResult.itemIds;
  }
  return undefined;
}

/*
 * Decide whether a condition is true. A condition is one of:
 *   { all: [...] }   every sub-condition is true
 *   { any: [...] }   at least one is true
 *   { not: {...} }   the sub-condition is false
 *   { ref, op, value }  compare a referenced value (op defaults to "==")
 * A missing condition counts as true, so steps and items without a "when" always apply.
 */
function evaluateCondition(condition, setup) {
  if (!condition) return true;
  if (condition.all) return condition.all.every(sub => evaluateCondition(sub, setup));
  if (condition.any) return condition.any.some(sub => evaluateCondition(sub, setup));
  if (condition.not) return !evaluateCondition(condition.not, setup);

  const actual = resolveReference(condition.ref, setup);
  const expected = condition.value;
  const actualIsList = Array.isArray(actual); // step results are lists of item ids

  switch (condition.op || '==') {
    case '==':  return actualIsList ? actual.includes(expected) : actual === expected;
    case '!=':  return actualIsList ? !actual.includes(expected) : actual !== expected;
    case '>':   return actual > expected;
    case '>=':  return actual >= expected;
    case '<':   return actual < expected;
    case '<=':  return actual <= expected;
    case 'in':  return expected.includes(actual);              // actual value is one of a list
    case 'has': return actualIsList && actual.includes(expected); // a picked item has this id
    case 'hasAny': return actualIsList && expected.some(id => actual.includes(id));
    case 'hasTag': {
      // true if any item picked by that step carries the given tag
      const stepResult = setup.stepResults[condition.ref.slice('step:'.length)];
      return !!stepResult && !stepResult.skipped
        && stepResult.items.some(item => (item.tags || []).includes(expected));
    }
  }
  return false; // unknown operator
}

/*
 * Turn a "number expression" from the JSON into a number. Accepted forms:
 *   5                                   a plain number
 *   { min, max }                        random whole number in that range (each end can be an expression)
 *   { by: ref, map: { "2": 3, default: 4 } }   look the referenced value up in a table; the table's values
 *                                       are themselves expressions, so these can nest to any depth
 *   { by: ref, mul, add }               referenced value x mul + add (mul defaults to 1, add to 0)
 * `fallback` is returned when nothing applies.
 */
function evaluateNumber(expression, setup, fallback = 0) {
  if (expression === undefined || expression === null) return fallback;
  if (typeof expression === 'number') return expression;

  if (expression.by) {
    const referencedValue = resolveReference(expression.by, setup);
    if (expression.map) {
      const matchingEntry = expression.map[String(referencedValue)];
      return evaluateNumber(matchingEntry !== undefined ? matchingEntry : expression.map.default, setup, fallback);
    }
    return Number(referencedValue) * (expression.mul ?? 1) + (expression.add ?? 0);
  }
  if ('min' in expression) {
    return randomIntInclusive(
      evaluateNumber(expression.min, setup),
      evaluateNumber(expression.max, setup));
  }
  return fallback;
}

/*
 * Fill {placeholders} in a note or text message with live values, e.g. "Use {step:boss} ({players} players)".
 * {step:<id>} becomes the names of the picked items (or the number); anything unknown is left as written.
 */
function fillTemplate(templateText, setup) {
  return String(templateText).replace(/\{([^}]+)\}/g, (placeholder, reference) => {
    if (reference.startsWith('step:')) {
      const stepResult = setup.stepResults[reference.slice('step:'.length)];
      if (!stepResult || stepResult.skipped) return '';
      return stepResult.numberValue !== undefined
        ? stepResult.numberValue
        : stepResult.items.map(item => item.name).join(', ');
    }
    const resolved = resolveReference(reference, setup);
    return resolved === undefined ? placeholder : resolved;
  });
}

/* =====================================================================
 * Drawing items from pools
 * ===================================================================== */

/*
 * Work out which pool items a step is allowed to pick from right now. An item is removed if:
 *   - its own "when" condition is false
 *   - an earlier step listed in the step's "excludeFrom" already picked it
 *   - an "exclude" rule on the step (whose "when" holds) bans its id
 *   - the step has a "tags" filter and the item has none of those tags
 *   - the step has a "notTags" filter and the item has one of those tags
 */
function getEligibleItems(step, setup) {
  // "pool" is normally the name of a shared pool, but an inline array also works.
  const sourceItems = typeof step.pool === 'string'
    ? (currentGame.pools || {})[step.pool] || []
    : step.pool || [];

  const idsPickedByOtherSteps = new Set((step.excludeFrom || []).flatMap(otherStepId => {
    const otherResult = setup.stepResults[otherStepId];
    return (otherResult && otherResult.itemIds) || [];
  }));

  const bannedIds = new Set((step.exclude || [])
    .filter(rule => evaluateCondition(rule.when, setup))
    .flatMap(rule => rule.ids));

  return sourceItems.filter(item => {
    const itemTags = item.tags || [];
    return evaluateCondition(item.when, setup)
      && !idsPickedByOtherSteps.has(item.id)
      && !bannedIds.has(item.id)
      && (!step.tags || itemTags.some(tag => step.tags.includes(tag)))
      && !(step.notTags || []).some(tag => itemTags.includes(tag));
  });
}

/*
 * Randomly pick up to `howMany` items. Items may have a "weight" (default 1); heavier items are more
 * likely. With `withoutReplacement` true (the default for steps) an item can't be picked twice.
 * Passing Infinity returns every item in a random order, which is how shuffling works.
 */
function drawItems(items, howMany, withoutReplacement = true) {
  const picked = [];
  const remaining = items.slice();
  while (picked.length < howMany && remaining.length) {
    const totalWeight = remaining.reduce((sum, item) => sum + (item.weight ?? 1), 0);
    // Spin a "roulette wheel": subtract each item's weight until we pass zero.
    let spin = randomBelow(totalWeight);
    let index = 0;
    for (; index < remaining.length - 1; index++) {
      spin -= (remaining[index].weight ?? 1);
      if (spin < 0) break;
    }
    picked.push(remaining[index]);
    if (withoutReplacement) remaining.splice(index, 1);
  }
  return picked;
}

/* =====================================================================
 * Running steps and rolling a whole setup
 * ===================================================================== */

/*
 * Run one step and return its stepResult. Step kinds:
 *   pick (default)  pick "count" items, honouring "include" (forced items) and "exclude"
 *   perPlayer       one item for each player
 *   shuffle         every eligible item, in random order
 *   number          a random number between "min" and "max"
 *   text            just a message, nothing is drawn
 */
function rollStep(step, setup) {
  const result = { skipped: false, itemIds: [], items: [] };

  // A false "when" means the step doesn't apply to this setup at all.
  if (!evaluateCondition(step.when, setup)) { result.skipped = true; return result; }

  const kind = step.kind || 'pick';
  if (kind === 'text') return result;
  if (kind === 'number') {
    result.numberValue = randomIntInclusive(
      evaluateNumber(step.min, setup),
      evaluateNumber(step.max, setup));
    return result;
  }

  const eligibleItems = getEligibleItems(step, setup);

  if (kind === 'shuffle') {
    result.items = drawItems(eligibleItems, eligibleItems.length);

  } else if (kind === 'perPlayer') {
    result.items = drawItems(eligibleItems, setup.playerCount, step.unique !== false);
    if (result.items.length < setup.playerCount) {
      result.warning = `Only ${result.items.length} of ${setup.playerCount} available`;
    }

  } else { // ordinary "pick"
    const wantedCount = evaluateNumber(step.count, setup, 1);

    // "include" rules force specific items in whenever their condition holds.
    const forcedIds = new Set((step.include || [])
      .filter(rule => evaluateCondition(rule.when, setup))
      .flatMap(rule => rule.ids));
    const forcedItems = eligibleItems.filter(item => forcedIds.has(item.id));
    const otherItems = eligibleItems.filter(item => !forcedIds.has(item.id));

    // Fill the rest of the count at random, then shuffle so forced items aren't always listed first.
    const randomItems = drawItems(otherItems, Math.max(0, wantedCount - forcedItems.length), step.unique !== false);
    result.items = drawItems(forcedItems.concat(randomItems), Infinity);

    if (forcedItems.length < forcedIds.size) result.warning = 'A required item is not available';
    else if (result.items.length < wantedCount) result.warning = `Only ${result.items.length} of ${wantedCount} available`;
  }

  // Optional display sorting: step.sort (or game.sort) is true / "name" for alphabetical, or "id".
  // Shuffle steps are never sorted because their random order is the result.
  const sortSetting = step.sort ?? currentGame.sort;
  if (sortSetting && kind !== 'shuffle') {
    const sortKey = sortSetting === 'id' ? 'id' : 'name';
    result.items.sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey]), undefined, { numeric: true, sensitivity: 'base' }));
  }

  result.itemIds = result.items.map(item => item.id);
  return result;
}

/*
 * Find every step that depends on the given step, directly or through other steps. A step "depends"
 * on another if its JSON (or its pool's JSON) refers to "step:<id>", or lists it in "excludeFrom".
 * Re-rolling one step must also re-roll these, otherwise the setup could contradict itself.
 */
function findStepAndDependents(stepId) {
  const affectedIds = new Set([stepId]);
  let foundNewOne = true;
  while (foundNewOne) {
    foundNewOne = false;
    for (const step of currentGame.setup) {
      if (affectedIds.has(step.id)) continue;
      const stepJson = JSON.stringify(step) + JSON.stringify((currentGame.pools || {})[step.pool] || '');
      const dependsOnAffected = [...affectedIds].some(id =>
        stepJson.includes('"step:' + id + '"') || (step.excludeFrom || []).includes(id));
      if (dependsOnAffected) { affectedIds.add(step.id); foundNewOne = true; }
    }
  }
  return affectedIds;
}

/*
 * Roll a complete setup and show it.
 * `stepIdsToReroll` is a Set of step ids to re-roll while keeping every other step's previous result,
 * or null to roll everything. The whole thing is retried (up to 300 times) until the game's
 * "constraints" are all satisfied; if that never happens the last attempt is shown with a warning.
 */
function rollSetup(stepIdsToReroll) {
  const previousResults = currentSetup && currentSetup.stepResults;
  let setup;
  for (let attempt = 1; attempt <= 300; attempt++) {
    setup = {
      playerCount: currentChoices.playerCount,
      optionValues: currentChoices.optionValues,
      stepResults: {},
      allConstraintsMet: false
    };
    for (const step of currentGame.setup) {
      const keepPreviousResult = stepIdsToReroll && previousResults
        && !stepIdsToReroll.has(step.id) && previousResults[step.id];
      setup.stepResults[step.id] = keepPreviousResult || rollStep(step, setup);
    }
    const constraintsPassed = (currentGame.constraints || [])
      .every(constraint => evaluateCondition(constraint.cond, setup));
    if (constraintsPassed) { setup.allConstraintsMet = true; break; }
  }
  currentSetup = setup;
  renderResults();
}

/* =====================================================================
 * Theming: a game's optional "theme" object sets CSS variables
 * ===================================================================== */

// Game JSON key -> CSS variable it controls (the heading font is handled separately below).
const THEME_VARIABLES = {
  background: '--bg', glow: '--glow', panel: '--panel', border: '--border', accent: '--accent',
  accentText: '--on-accent', text: '--text', muted: '--muted', warn: '--warn'
};
const DEFAULT_THEME_COLOUR = '#173229'; // matches --bg in index.html; used for the browser toolbar colour

// Apply a theme, or reset to the defaults when called with nothing (home screen).
function applyTheme(theme = {}) {
  const rootStyle = document.documentElement.style;
  // Clear anything the previous game set, so themes never leak between games.
  for (const variableName of [...Object.values(THEME_VARIABLES), '--head']) rootStyle.removeProperty(variableName);
  for (const [jsonKey, variableName] of Object.entries(THEME_VARIABLES)) {
    // CSS.supports ignores values that aren't valid colours.
    if (theme[jsonKey] && CSS.supports('color', theme[jsonKey])) rootStyle.setProperty(variableName, theme[jsonKey]);
  }
  if (theme.font) rootStyle.setProperty('--head', theme.font);
  queryOne('meta[name=theme-color]').content =
    theme.background && CSS.supports('color', theme.background) ? theme.background : DEFAULT_THEME_COLOUR;
}

/* =====================================================================
 * Screens: HTML builders
 * ===================================================================== */

// Cover picture for a game: its image, else its emoji icon, else nothing (just the name is shown).
const coverHtml = game =>
  game.image ? `<img src="games/${escapeHtml(game.image)}" alt="">`
  : game.icon ? `<div class="ph">${escapeHtml(game.icon)}</div>`
  : '';

// Picture for an item: its image, else its emoji icon, else nothing (text only).
const itemPictureHtml = item =>
  item.image ? `<img src="games/${escapeHtml(item.image)}" alt="">`
  : item.icon ? `<span class="ic">${escapeHtml(item.icon)}</span>`
  : '';

// A full-size item row: picture, bold name, and the item's note underneath.
const itemRowHtml = item =>
  `<div class="item">${itemPictureHtml(item)}<div><b>${escapeHtml(item.name)}</b>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</div></div>`;

// The inside of a compact "chip": picture and name only (the note is shown as hover text by the caller).
const chipContentHtml = item => `${itemPictureHtml(item)}<b>${escapeHtml(item.name)}</b>`;

// <option> tags for every whole number from `low` to `high`, with `selected` pre-selected.
const numberOptionsHtml = (low, high, selected) =>
  Array.from({ length: high - low + 1 }, (_, offset) => low + offset)
    .map(number => `<option ${number === selected ? 'selected' : ''}>${number}</option>`).join('');

/* =====================================================================
 * Screens: home and game
 * ===================================================================== */

// The list of available games.
function showHomeScreen() {
  currentGame = null;
  currentSetup = null;
  applyTheme();
  document.title = 'Setup Shuffler';
  const gamesSortedByName = Object.values(gamesById).sort((a, b) => a.name.localeCompare(b.name));
  queryOne('#app').innerHTML = `<h1>Setup Shuffler</h1><p class="sub">Choose a game to randomise its setup.</p>
  <div class="grid">${gamesSortedByName.map(game =>
    `<a class="tile" href="#/${escapeHtml(game.id)}">${coverHtml(game)}<span>${escapeHtml(game.name)}</span></a>`).join('')}</div>`;
}

// One game: theme, controls for players/options, the Randomise button, and the (initially rolled) results.
function showGameScreen(gameId) {
  currentGame = gamesById[gameId];
  currentSetup = null;
  applyTheme(currentGame.theme);
  document.title = currentGame.name + ' setup';

  // Starting choices: the default player count and each option's default value.
  const playerRange = currentGame.players || { min: 1, max: 1, default: 1 };
  currentChoices = { playerCount: playerRange.default ?? playerRange.min, optionValues: {} };

  // Build the control widgets. Each carries data-key (what it changes) and, for number options, data-numeric.
  const controlsHtml = [];
  if (playerRange.max > playerRange.min) { // no player picker if the count is fixed
    controlsHtml.push(`<label>Players<select data-key="players">${numberOptionsHtml(playerRange.min, playerRange.max, currentChoices.playerCount)}</select></label>`);
  }
  for (const option of currentGame.options || []) {
    const optionType = option.type || 'choice';
    if (optionType === 'toggle') {
      currentChoices.optionValues[option.id] = !!option.default;
      controlsHtml.push(`<label class="tg"><input type="checkbox" data-key="${escapeHtml(option.id)}" ${option.default ? 'checked' : ''}>${escapeHtml(option.label)}</label>`);
    } else if (optionType === 'number') {
      currentChoices.optionValues[option.id] = option.default ?? option.min;
      controlsHtml.push(`<label>${escapeHtml(option.label)}<select data-key="${escapeHtml(option.id)}" data-numeric="1">${numberOptionsHtml(option.min, option.max, currentChoices.optionValues[option.id])}</select></label>`);
    } else { // "choice": a drop-down of named choices
      currentChoices.optionValues[option.id] = option.default ?? option.choices[0].id;
      controlsHtml.push(`<label>${escapeHtml(option.label)}<select data-key="${escapeHtml(option.id)}">${option.choices.map(choice =>
        `<option value="${escapeHtml(choice.id)}" ${choice.id === currentChoices.optionValues[option.id] ? 'selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}</select></label>`);
    }
  }

  queryOne('#app').innerHTML = `<a href="#/">‹ All games</a>
  <div class="hero">${coverHtml(currentGame)}<div><h1>${escapeHtml(currentGame.name)}</h1>${currentGame.description ? `<p>${escapeHtml(currentGame.description)}</p>` : ''}</div></div>
  ${controlsHtml.length ? `<div class="ctl" id="ctl">${controlsHtml.join('')}</div>` : ''}
  <button class="go" id="go">Randomise setup</button><div id="out"></div>`;

  // "Randomise setup" re-rolls everything.
  queryOne('#go').onclick = () => rollSetup(null);

  // Changing any control updates the stored choices and re-rolls everything.
  const controlsElement = queryOne('#ctl');
  if (controlsElement) {
    controlsElement.onchange = event => {
      const control = event.target;
      const key = control.dataset.key;
      let newValue;
      if (control.type === 'checkbox') newValue = control.checked;
      else if (control.dataset.numeric || key === 'players') newValue = Number(control.value);
      else newValue = control.value;
      if (key === 'players') currentChoices.playerCount = newValue;
      else currentChoices.optionValues[key] = newValue;
      rollSetup(null);
    };
  }

  // A step's ↻ button re-rolls that step plus anything that depends on it.
  queryOne('#out').onclick = event => {
    const rerollButton = event.target.closest('.rr');
    if (rerollButton) rollSetup(findStepAndDependents(rerollButton.dataset.id));
  };

  rollSetup(null); // show a first random setup straight away
}

/* =====================================================================
 * Rendering the rolled setup
 * ===================================================================== */

// Draw currentSetup into the #out element, one block per step that applies.
function renderResults() {
  const setup = currentSetup;
  const blocks = [];

  if (!setup.allConstraintsMet) {
    blocks.push('<p class="warn">No setup met every rule after 300 tries, so this is the last attempt. Check the game\'s constraints.</p>');
  }

  for (const step of currentGame.setup) {
    const result = setup.stepResults[step.id];
    if (result.skipped) continue; // step doesn't apply to this setup

    const label = step.label || step.id;
    const noteHtml = step.note ? `<p class="note">${escapeHtml(fillTemplate(step.note, setup))}</p>` : '';
    const warningHtml = result.warning ? `<p class="warn">${escapeHtml(result.warning)}</p>` : '';
    const rerollButtonHtml = `<button class="rr" data-id="${escapeHtml(step.id)}" aria-label="Re-roll ${escapeHtml(label)}">↻</button>`;

    // Text steps are simple call-out messages with no label or re-roll button.
    if (step.kind === 'text') {
      blocks.push(`<div class="callout">${escapeHtml(fillTemplate(step.text, setup))}</div>`);
      continue;
    }

    // Compact layout: label on the left, results as chips in the middle, re-roll button on the right.
    // Chosen per step with "inline", falling back to the game-wide "compact" setting.
    if (step.inline ?? currentGame.compact) {
      const chipHtml = (item, prefix) =>
        `<span class="chip" ${item.note ? `title="${escapeHtml(item.note)}"` : ''}>${prefix ? `<em>${prefix}</em>` : ''}${chipContentHtml(item)}</span>`;
      let chipsContent;
      if (step.kind === 'number') chipsContent = `<span class="big sm">${result.numberValue}</span>`;
      else if (step.kind === 'perPlayer') chipsContent = result.items.map((item, index) => chipHtml(item, 'P' + (index + 1))).join('');
      else if (step.kind === 'shuffle') chipsContent = result.items.map((item, index) => chipHtml(item, (index + 1) + '.')).join('');
      else chipsContent = result.items.length ? result.items.map(item => chipHtml(item)).join('') : '<span class="txt">None</span>';
      blocks.push(`<section class="step row"><div><h2>${escapeHtml(label)}</h2>${noteHtml}${warningHtml}</div><div class="chips">${chipsContent}</div>${rerollButtonHtml}</section>`);
      continue;
    }

    // Full layout: heading and re-roll button on top, results listed below.
    let bodyHtml;
    if (step.kind === 'number') bodyHtml = `<div class="big">${result.numberValue}</div>`;
    else if (step.kind === 'perPlayer') bodyHtml = result.items.map((item, index) => `<div class="pp"><em>Player ${index + 1}</em>${itemRowHtml(item)}</div>`).join('');
    else if (step.kind === 'shuffle') bodyHtml = `<ol>${result.items.map(item => `<li>${itemRowHtml(item)}</li>`).join('')}</ol>`;
    else bodyHtml = result.items.length ? result.items.map(itemRowHtml).join('') : '<p class="txt">None</p>';
    blocks.push(`<section class="step"><div class="sh"><h2>${escapeHtml(label)}</h2>${rerollButtonHtml}</div>${noteHtml}${warningHtml}${bodyHtml}</section>`);
  }

  queryOne('#out').innerHTML = blocks.join('');
}

/* =====================================================================
 * Start-up and navigation
 * ===================================================================== */

// The URL hash picks the screen: "#/<gameId>" opens that game, anything else shows the home screen.
function showScreenForCurrentHash() {
  const gameId = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (gamesById[gameId]) showGameScreen(gameId);
  else showHomeScreen();
}
addEventListener('hashchange', showScreenForCurrentHash);

// Load games/index.json (a list of file names), then each game file. "no-cache" makes the browser
// check with the server so edited game files show up straight away.
async function loadGames() {
  try {
    const fileNames = await (await fetch('games/index.json', { cache: 'no-cache' })).json();
    for (const fileName of fileNames) {
      try {
        const game = await (await fetch('games/' + fileName, { cache: 'no-cache' })).json();
        game.id = game.id || fileName.replace(/\.json$/, ''); // default id is the file name
        gamesById[game.id] = game;
      } catch (error) {
        console.error('Bad game file', fileName, error); // one broken file doesn't stop the others
      }
    }
  } catch (error) {
    queryOne('#app').textContent = 'Could not load games/index.json';
    return;
  }
  showScreenForCurrentHash();
}
loadGames();

// Register the service worker (sw.js) so the app can work offline and be installed.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
