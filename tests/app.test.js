// Checks the app's solving, painting and saving logic, using the real code
// inside index.html. Run from the repo root with:  node --test
// Needs only Node.js 21+, with nothing to install. These cover the logic, not
// the screens, so anything visual still needs checking in a browser.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SEQUENCE = "R U2 F' D L2 B R' U F2 D' L B2 U' R2 F D2 L' U B' R F'";
let app;

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const cubeLib = scripts.find(s => s.includes('Cube.initSolver'));
  const appCode = scripts.find(s => s.includes('Cube Face Solver app.'));
  assert.ok(cubeLib && appCode, 'Could not find the solver and app scripts in index.html');

  const storage = new Map();
  const context = {
    console, setTimeout, clearTimeout,
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
      clear: () => storage.clear(),
    },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {} }), body: {} },
    navigator: {},
    confirm: () => true,
    alert() {},
    prompt: () => null,
  };
  context.window = context;
  context.window.addEventListener = () => {};
  context.self = context;
  vm.createContext(context);
  vm.runInContext(cubeLib, context);
  vm.runInContext(`${appCode}
    // The logic under test calls these to refresh the screen; there is no screen here.
    render = () => {};
    renderPlanResult = () => {};
    showStorageWarning = () => {};
    clearStorageWarning = () => {};
    globalThis.t = new Proxy({}, { get: (_, name) => eval(name), set: (_, name, value) => { eval(name + ' = value'); return true; } });
  `, context);
  context.Cube.initSolver();
  return context;
}

// A completed plan built the same way the Submit button builds one.
function buildPlan(patterns, startRows, width = 3) {
  const { t } = app;
  t.appState.patternStartRows = startRows;
  t.appState.patternMosaicWidth = width;
  t.appState.solveLog = [];
  const plan = t.initPlanRun(patterns.join('\n'));
  while (plan.status === 'running') t.runPlanChunk(plan, 10);
  t.appState.patternPlanState = plan;
  t.appState.patternTargetInput = plan.targetsInput;
  t.logNewPlacements(plan, 0);
  return plan;
}
const paintRow = () => [{ id: 1, type: 'paint', exportName: null, pasteText: '' }];
const solvedRow = () => [{ id: 1, type: 'solved', exportName: null, pasteText: '' }];
const scrambled = (moves = SEQUENCE) => new app.Cube().move(moves).asString();

// True when the placement's turns really do produce its pattern at its stated face and rotation.
function reachesTarget(p) {
  const { t, Cube } = app;
  const end = p.moveCount ? Cube.fromString(p.startStr).move(p.moves).asString() : p.startStr;
  const wanted = [...p.mosaicPattern].map(c => t.MOSAIC_CODE_TO_CUBE_LETTER[c]).join('');
  const seen = t.allFaceOrientations(end).find(o => o.face === p.face && o.rotation === p.rotation / 90);
  return !!seen && seen.pattern === wanted && end === p.finalStr;
}

before(() => { app = loadApp(); });
beforeEach(() => { app.localStorage.clear(); app.t.appState.solveLog = []; });

test('reaches random targets directly from random scrambled cubes', () => {
  const { t, Cube } = app;
  const codes = 'WYROBG';
  for (let i = 0; i < 10; i++) {
    const start = new Cube().randomize().asString();
    const letters = Array.from({ length: 9 }, () => t.MOSAIC_CODE_TO_CUBE_LETTER[codes[Math.floor(Math.random() * 6)]]);
    const grid = [letters.slice(0, 3), letters.slice(3, 6), letters.slice(6, 9)];
    const { result, rotation } = t.bestSolveForTarget(start, grid[1][1], grid, [0, 1, 2, 3]);
    assert.equal(result.success, true);
    assert.ok(result.moveCount <= 22);
    const end = result.moveCount ? Cube.fromString(start).move(result.moves).asString() : start;
    const seen = t.allFaceOrientations(end).find(o => o.face === grid[1][1] && o.rotation === rotation);
    assert.equal(seen.pattern, letters.join(''));
  }
});

test('uses few turns, and the true minimum on cubes one or two turns away', () => {
  const { t, Cube } = app;
  const counts = [];
  for (let i = 0; i < 15; i++) {
    const start = new Cube().randomize().asString();
    const pattern = Array.from({ length: 9 }, () => 'RLFDBU'[Math.floor(Math.random() * 6)]);
    const grid = [pattern.slice(0, 3), pattern.slice(3, 6), pattern.slice(6, 9)];
    const r = t.solveFaceOnly(start, grid[1][1], grid);
    assert.equal(r.success, true);
    counts.push(r.moveCount);
  }
  const average = counts.reduce((a, b) => a + b, 0) / counts.length;
  assert.ok(average < 10, `averaged ${average} turns`);

  // Take a target from a cube, turn it away by a known amount, and ask for it back.
  const start = scrambled();
  const grid = t.faceGridFromString(start, 'F');
  assert.equal(t.solveFaceOnly(start, 'F', grid).moveCount, 0);
  const turned = new Cube(Cube.fromString(start)).move('R').asString();
  const back = t.solveFaceOnly(turned, 'F', grid);
  assert.equal(back.moveCount, 1);
  assert.equal(back.moves, "R'");
});

test('keeps the full final state of the cube, with all six sides known', () => {
  const { t, Cube } = app;
  const start = scrambled();
  const grid = [['R', 'L', 'F'], ['B', 'D', 'U'], ['R', 'L', 'F']];
  const r = t.solveFaceOnly(start, 'D', grid);
  assert.equal(r.finalStr, new Cube(Cube.fromString(start)).move(r.moves).asString());
  assert.equal(t.validateCubeState(r.finalStr).ok, true);
  assert.equal(t.faceGridFromString(r.finalStr, 'D').flat().join(''), grid.flat().join(''));
});

test('falls back to the whole-cube solver if a result fails its check', () => {
  const { t } = app;
  const realFaceGrid = t.faceGridFromString;
  const start = scrambled();
  const grid = [['R', 'L', 'F'], ['B', 'D', 'U'], ['R', 'L', 'F']];
  const quick = t.solveFaceOnly(start, 'D', grid);
  let calls = 0;
  // Makes only the first check fail, which is the one inside solveFaceOnly.
  t.faceGridFromString = (s, f) => (calls++ === 0 ? [['x']] : realFaceGrid(s, f));
  const fallback = t.solveFaceOnly(start, 'D', grid);
  t.faceGridFromString = realFaceGrid;
  assert.equal(fallback.success, true);
  assert.ok(fallback.moveCount > quick.moveCount, 'should have used the longer whole-cube route');
});

test('boards are named by row letter and place in that row, in build order', () => {
  const { t } = app;
  // 40 x 50 cubes on boards of 10 x 10: 4 boards across, 5 rows of boards.
  const label = (row, col) => t.blockLabelForGroup(t.blockGroupForPosition(row, col, 10, 10, 10));
  assert.equal(label(1, 1), 'A1');
  assert.equal(label(10, 40), 'A4');
  assert.equal(label(11, 1), 'B1');
  assert.equal(label(11, 31), 'B4');
  assert.equal(label(21, 21), 'C3');
  assert.equal(label(50, 40), 'E4');

  const plan = { blockOrder: true, boardWidth: 10, boardHeight: 10, mosaicWidth: 40 };
  // The first cube of each board, shuffled out of order by listing rows top-down.
  const cubes = [];
  for (let row = 4; row >= 0; row--) for (let col = 3; col >= 0; col--) cubes.push({ targetLineNum: row * 10 * 40 + col * 10 + 1 });
  const order = cubes.sort(t.blockOrderComparator(plan)).map(p => t.blockLabelForGroup(t.blockGroupForPlacement(p, plan)));
  assert.equal(order.join(' '), 'A1 A2 A3 A4 B1 B2 B3 B4 C1 C2 C3 C4 D1 D2 D3 D4 E1 E2 E3 E4');
});

test('Ruwix PDF sections keep the names printed on the PDF', () => {
  const { t } = app;
  assert.equal(t.sectionLabelForPosition(1, 1, 3, 4, 1), 'A1');
  assert.equal(t.sectionLabelForPosition(1, 4, 3, 4, 1), 'B1');
  assert.equal(t.sectionLabelForPosition(2, 1, 3, 4, 1), 'A2');
});

test('rejects physically impossible cubes', () => {
  const { t } = app;
  const change = {
    twist: c => { c.co[0] = (c.co[0] + 1) % 3; },
    flip: c => { c.eo[0] ^= 1; },
    swap: c => { [c.ep[0], c.ep[1]] = [c.ep[1], c.ep[0]]; },
  };
  for (const [code, apply] of Object.entries(change)) {
    const cube = new app.Cube().move(SEQUENCE);
    apply(cube);
    assert.equal(t.validateCubeState(cube.asString()).code, code);
    assert.equal(t.parseStartingStateInput(cube.asString()).str, null);
  }
});

test('accepts every state a real sequence of turns can produce', () => {
  const { t, Cube } = app;
  for (let i = 0; i < 200; i++) assert.equal(t.validateCubeState(new Cube().randomize().asString()).ok, true);
  assert.equal(t.validateCubeState(t.solvedStateString()).ok, true);
});

test('names over-used colors when the counts are wrong', () => {
  const { t } = app;
  const all = t.validateCubeState('R'.repeat(54));
  assert.equal(all.code, 'count');
  assert.match(t.explainCubeProblem(all), /Too many white/);
});

test('paint-as-you-go cubes need a start choice until one is made', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'OOOOOOOOO', 'GGGYYYBBB'], paintRow());
  assert.equal(plan.paintAsYouGo, true);
  assert.equal(t.cubeViewerNavigableIndices(plan).length, 3);
  assert.ok(plan.placements.every(p => t.placementNeedsStartChoice(p, plan)));
  t.applyCubeStartToPlacement(0, scrambled(), 'painted');
  assert.equal(t.placementNeedsStartChoice(plan.placements[0], plan), false);
  t.applyCubeStartToPlacement(1, t.solvedStateString(), 'solved');
  assert.equal(t.placementNeedsStartChoice(plan.placements[1], plan), false);
  assert.equal(t.cubeViewerNavigableIndices(plan).length, 3, 'a no-turn cube must stay in the walkthrough');
});

test('plans without paint-as-you-go never ask', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'OOOOOOOOO'], solvedRow());
  assert.equal(plan.paintAsYouGo, false);
  assert.ok(plan.placements.every(p => !t.placementNeedsStartChoice(p, plan)));
});

test('a painted cube gets correct turns that update the plan, log and storage', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'GGGYYYBBB'], paintRow());
  const logLength = t.appState.solveLog.length;
  assert.equal(t.applyCubeStartToPlacement(0, scrambled(), 'painted').success, true);
  const p = plan.placements[0];
  assert.equal(p.startStr, scrambled());
  assert.equal(p.sourceLabel, 'painted cube');
  assert.ok(reachesTarget(p));
  assert.equal(t.appState.solveLog.length, logLength);
  assert.equal(t.appState.solveLog.find(e => e.targetLineNum === p.targetLineNum).resultStr, p.finalStr);
  assert.equal(t.loadPlanRunProgress().placements[0].finalStr, p.finalStr);
});

test('a cube already showing its target needs no turns', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR'], paintRow(), 1);
  const start = scrambled();
  // Read a face straight off the cube, then ask for exactly that pattern.
  const grid = t.faceGridFromString(start, 'U');
  const pattern = grid.flat().map(l => t.CUBE_LETTER_TO_MOSAIC_CODE[l]).join('');
  plan.placements[0].mosaicPattern = pattern;
  t.applyCubeStartToPlacement(0, start, 'painted');
  const p = plan.placements[0];
  assert.equal(p.moveCount, 0);
  assert.equal(p.type, 'solve', 'stays tied to this specific cube');
  assert.equal(p.finalStr, start);
  assert.ok(reachesTarget(p));
});

test('the fix link replaces a cube instead of adding an extra saved state', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'GGGYYYBBB'], solvedRow());
  const logLength = t.appState.solveLog.length;
  const result = t.correctPlacementTarget(0, 'BYBGRGOWO');
  assert.equal(result.success, true);
  const p = plan.placements[0];
  assert.equal(p.mosaicPattern, 'BYBGRGOWO');
  assert.ok(reachesTarget(p));
  assert.equal(t.appState.solveLog.length, logLength);
  assert.equal(t.appState.solveLog.find(e => e.targetLineNum === p.targetLineNum).resultStr, p.finalStr);
  assert.equal(plan.targetsInput.split('\n')[0], 'BYBGRGOWO');
});

test('the fix link starts from the cube\'s real state', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'GGGYYYBBB'], paintRow());
  t.applyCubeStartToPlacement(0, scrambled(), 'painted');
  // Not yet placed: the cube is still in the state that was painted.
  t.correctPlacementTarget(0, 'BYBGRGOWO');
  assert.equal(plan.placements[0].startStr, scrambled());
  assert.ok(reachesTarget(plan.placements[0]));

  // Already placed: it has since been turned, so that's where it starts now.
  t.markPlaced(plan.placements[0], true);
  const asPlaced = plan.placements[0].finalStr;
  t.correctPlacementTarget(0, 'OGOGOGOGO');
  assert.equal(plan.placements[0].startStr, asPlaced);
  assert.equal(plan.placements[0].placed, false);
  assert.ok(reachesTarget(plan.placements[0]));
});

test('the fix link keeps an unpainted cube waiting to be painted', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'GGGYYYBBB'], paintRow());
  t.correctPlacementTarget(1, 'BYBGRGOWO');
  assert.equal(t.placementNeedsStartChoice(plan.placements[1], plan), true);
});

test('the fix link rejects bad patterns without changing anything', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR'], solvedRow(), 1);
  const before = plan.placements[0].moves;
  assert.equal(t.correctPlacementTarget(0, 'WYRO').success, false);
  assert.equal(t.correctPlacementTarget(0, 'XXXXXXXXX').success, false);
  assert.equal(plan.placements[0].moves, before);
});

test('saving a paint-as-you-go mosaic early leaves out cubes not yet placed', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'GGGYYYBBB', 'BYBGRGOWO'], paintRow());
  t.applyCubeStartToPlacement(0, scrambled(), 'painted');
  t.markPlaced(plan.placements[0], true);
  assert.match(t.partialSaveWarning(), /1 of 3/);

  const { finalName } = t.saveCurrentLogAsExport('Partial');
  const entry = t.loadSavedExports().find(e => e.name === finalName);
  assert.equal(entry.lines.length, 1);
  assert.equal(entry.lines[0], plan.placements[0].finalStr);
  assert.equal(entry.positions.length, 1);
  assert.equal(entry.positions[0], plan.placements[0].targetLineNum);
  assert.equal(t.exportSolveLogText().trim(), plan.placements[0].finalStr);
});

test('saving a finished mosaic, or a plan without painting, needs no warning', () => {
  const { t } = app;
  const painted = buildPlan(['WYROBGWYR'], paintRow(), 1);
  t.applyCubeStartToPlacement(0, scrambled(), 'painted');
  t.markPlaced(painted.placements[0], true);
  assert.equal(t.partialSaveWarning(), null);

  buildPlan(['WYROBGWYR', 'GGGYYYBBB'], solvedRow());
  assert.equal(t.partialSaveWarning(), null);
  assert.equal(t.logEntriesForSaving().length, 2);
});

test('a progress backup restores the plan exactly, including painted cubes', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'GGGYYYBBB', 'BYBGRGOWO'], paintRow());
  t.applyCubeStartToPlacement(0, scrambled(), 'painted');
  t.markPlaced(plan.placements[0], true);
  const backup = t.buildPlanBackupJson(plan);
  const snapshot = JSON.stringify(plan.placements);

  app.localStorage.clear();
  t.appState.patternPlanState = null;
  t.appState.solveLog = [];
  assert.equal(t.isPlanBackupJson(backup), true);
  const result = t.restorePlanFromBackupJson(backup);
  assert.equal(result.ok, true);
  assert.equal(result.placed, 1);
  assert.equal(result.total, 3);

  const restored = t.appState.patternPlanState;
  assert.equal(JSON.stringify(restored.placements), snapshot);
  assert.equal(restored.paintAsYouGo, true);
  assert.equal(t.appState.patternTargetInput, plan.targetsInput);
  assert.equal(t.appState.solveLog.length, 3, 'saving later still needs every cube');
  assert.equal(t.loadPlanRunProgress().placements.length, 3, 'kept across a reload');
});

test('a damaged or unrelated file cannot replace the current plan', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR'], solvedRow(), 1);
  const good = JSON.parse(t.buildPlanBackupJson(plan));
  const damaged = structuredClone(good);
  damaged.plan.placements[0].startStr = 'U'.repeat(54);
  const emptied = structuredClone(good);
  emptied.plan.placements = [];
  assert.equal(t.isPlanBackupJson('not json'), false);
  assert.equal(t.isPlanBackupJson(JSON.stringify({ name: 'Saved mosaic', lines: [] })), false);
  assert.equal(t.restorePlanFromBackupJson(JSON.stringify(damaged)).ok, false);
  assert.equal(t.restorePlanFromBackupJson(JSON.stringify(emptied)).ok, false);
  assert.equal(t.restorePlanFromBackupJson('not json').ok, false);
  assert.equal(t.appState.patternPlanState, plan);
});

test('the backup reminder appears every 100 placed cubes', () => {
  const { t } = app;
  const plan = { placements: Array.from({ length: 250 }, () => ({ placed: false })) };
  const place = n => plan.placements.slice(0, n).forEach(p => { p.placed = true; });
  place(99);
  assert.equal(t.backupReminderDue(plan), false);
  place(100);
  assert.equal(t.backupReminderDue(plan), true);
  t.buildPlanBackupJson(plan);
  plan.lastBackupPlacedCount = 100;
  assert.equal(t.backupReminderDue(plan), false);
  place(200);
  assert.equal(t.backupReminderDue(plan), true);
});

test('typed entry visits every sticker except the centers, once each', () => {
  const { t } = app;
  const order = t.PAINT_ENTRY_ORDER;
  assert.equal(order.length, 48);
  assert.equal(new Set(order).size, 48);
  assert.ok(order.every(i => i >= 0 && i < 54 && i % 9 !== 4));
  assert.equal(order[0], 0);
});

test('a cube that fits a later spot is found, and set aside without turns', () => {
  const { t } = app;
  const start = scrambled();
  const pattern = t.faceGridFromString(start, 'F').flat().map(l => t.CUBE_LETTER_TO_MOSAIC_CODE[l]).join('');
  const plan = buildPlan(['WYROBGWYR', 'GGGYYYBBB', pattern], paintRow());
  assert.equal(t.findFreeSpotForCube(start, plan, 0), 2);

  t.setCubeAsideForPlacement(2, start, 'painted');
  const spot = plan.placements[2];
  assert.equal(spot.setAside, true);
  assert.equal(spot.moveCount, 0);
  assert.equal(spot.startStr, start);
  assert.equal(t.placementNeedsStartChoice(spot, plan), false);
  assert.ok(reachesTarget(spot));
  assert.equal(t.sourceLabelDisplay(spot), 'the cube you set aside for this spot');
  assert.equal(t.findFreeSpotForCube(start, plan, 0), null, 'that spot is taken now');
});

test('no other spot is offered when the cube fits here, or fits nowhere', () => {
  const { t } = app;
  const start = scrambled();
  const pattern = t.faceGridFromString(start, 'F').flat().map(l => t.CUBE_LETTER_TO_MOSAIC_CODE[l]).join('');
  const plan = buildPlan([pattern, 'GGGYYYBBB', pattern], paintRow());
  assert.equal(t.findFreeSpotForCube(start, plan, 0), null);
  const other = buildPlan(['WYROBGWYR', 'GGGYYYBBB'], paintRow(), 2);
  assert.equal(t.findFreeSpotForCube(start, other, 0), null);
});

test('a solved cube is matched to a solid-color spot', () => {
  const { t } = app;
  const plan = buildPlan(['WYROBGWYR', 'OOOOOOOOO'], paintRow(), 2);
  assert.equal(t.findFreeSpotForCube(t.solvedStateString(), plan, 0), 1);
  t.setCubeAsideForPlacement(1, t.solvedStateString(), 'solved');
  assert.equal(plan.placements[1].moveCount, 0);
  assert.equal(plan.placements[1].setAside, true);
  assert.equal(t.placementNeedsStartChoice(plan.placements[1], plan), false);
});

test('painting a set-aside spot again clears the set-aside note', () => {
  const { t } = app;
  const plan = buildPlan(['OOOOOOOOO'], paintRow(), 1);
  t.setCubeAsideForPlacement(0, t.solvedStateString(), 'solved');
  t.applyCubeStartToPlacement(0, scrambled(), 'painted');
  assert.equal(plan.placements[0].setAside, false);
  assert.ok(reachesTarget(plan.placements[0]));
});

test('a saved mosaic works as the starting pool for a new mosaic', () => {
  const { t } = app;
  const first = buildPlan(['WYROBGWYR', 'GGGYYYBBB', 'BYBGRGOWO'], paintRow());
  first.placements.forEach((p, i) => { t.applyCubeStartToPlacement(i, scrambled(), 'painted'); t.markPlaced(first.placements[i], true); });
  const { finalName, saved } = t.saveCurrentLogAsExport('Reuse test');
  assert.equal(saved, true);
  assert.equal(t.loadSavedExports().find(e => e.name === finalName).lines.length, 3);

  const next = buildPlan(['WRWRWRWRW', 'YOYBYBYOY', 'RWRWRWRWR'], [{ id: 2, type: 'lastExport', exportName: finalName, pasteText: '' }]);
  assert.equal(next.errors.length, 0);
  assert.equal(next.placements.length, 3);
  next.placements.forEach(p => { assert.match(p.sourceLabel, /Reuse test/); assert.ok(reachesTarget(p)); });
});
