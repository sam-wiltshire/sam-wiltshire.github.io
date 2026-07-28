// Star Wars: Legion — Terrain & Mission data
//
// Sourced from the current official Atomic Mass Games documents (July 2026):
//   - Core Rulebook, effective 4.21.2026 (terrain rules, setup procedure, Battle Card anatomy)
//   - Recon Rulebook, effective 4.30.2025 (3'x3' battlefield, Recon Battle Cards)
//   - 2024 Battle Card Updates (Standard mission Objective/Map/Secondary/Advantage cards)
//
// The rulebooks fix Territory shape and POI (point-of-interest) placement per mission via
// printed Map Cards, but leave *generic terrain* placement entirely up to the players
// ("Declare and Place Terrain" is agreed cooperatively, before a mission is even built).
// So: Territory/POI layouts below follow the printed Map Cards — the cards dimension every
// Territory with the range tool, so those distances are read straight off the card and held
// in inches (see TERRITORIES) — while generic terrain (Large/Medium/Small/Scatter/Barricade)
// is generated fresh each time from your inventory, which is the part the rules actually
// leave open, and the part this tool is for.
//
// Plain classic scripts (no ES modules) on purpose — this needs to work when someone just
// double-clicks index.html (file://), and `type="module"` scripts are blocked by CORS there.
var LM = window.LM || (window.LM = {});

// ---------------------------------------------------------------------------
// Terrain size categories
//
// The rulebook only classifies terrain by function (Scatter / Area / Obstacle) and by
// Height + Cover — it has no "Large/Medium/Small" rule. Those size labels are the
// tournament-scene convention for talking about how much of a table a piece eats up.
// Footprint dimensions (width x depth x height, inches) are the user's actual terrain set.
LM.TERRAIN_CATEGORIES = {
  large: {
    key: "large",
    label: "Large",
    width: 9,
    depth: 11,
    height: 5,
    cover: "heavy",
    officialType: "Obstacle",
    blocksLOS: true,
    building: true,
    note: "Buildings, big rock formations, ruins. Should fully block LOS and movement.",
  },
  medium: {
    key: "medium",
    label: "Medium",
    width: 5,
    depth: 6,
    height: 5,
    cover: "heavy",
    officialType: "Obstacle / Area",
    blocksLOS: true,
    building: true,
    note: "Mid-size structures, wrecked vehicles, rock clusters.",
  },
  small: {
    key: "small",
    label: "Small",
    width: 2,
    depth: 4,
    height: 3.5,
    cover: "light-heavy",
    officialType: "Area",
    blocksLOS: false,
    note: "Low walls, single rocks, small crates — partial cover, rarely a full LOS blocker.",
  },
  scatter: {
    key: "scatter",
    label: "Scatter",
    width: 1,
    depth: 2,
    height: 1.5,
    cover: "light",
    officialType: "Scatter",
    blocksLOS: false,
    note: "Crates, planters, lamp posts — light cover, dresses the table.",
  },
  barricade: {
    key: "barricade",
    label: "Barricade",
    width: 3,
    depth: 1,
    height: 1,
    cover: "heavy (Trooper units only, not Creature/Heavy Trooper)",
    officialType: "Scatter (Barricade)",
    blocksLOS: false,
    note: "Open terrain — units move through it freely but a Trooper can never end a move overlapping one. Matches the Core Rulebook's exact Barricade spec.",
  },
};

LM.TERRAIN_ORDER = ["large", "medium", "small", "scatter", "barricade"];

// ---------------------------------------------------------------------------
// Planet themes — purely visual. Recolors every category and, for Large/Medium
// "buildings", tweaks the two-tier silhouette; scatter terrain gets a dedicated
// procedural shape per environment (see render.js drawScatterCluster) instead of a
// plain box, since a crate doesn't read as "Hoth" or "Tatooine" on its own.
LM.THEMES = {
  hoth: {
    key: "hoth",
    label: "Hoth",
    blurb: "Ice fields, snow-scoured rock, and wrecked durasteel.",
    floor: "#dfe9f0",
    grid: "rgba(90,120,150,0.22)",
    colors: { large: "#c3d3dd", medium: "#a9c0cd", small: "#e6eef2", barricade: "#b7cbd6" },
    scatter: { base: "#eef4f7", accent: "#9fb9c8", variant: "ice" },
    ground: "ice",
    building: { insetFrac: 0.82, topFrac: 0.4 },
  },
  endor: {
    key: "endor",
    label: "Endor",
    blurb: "Redwood forest floor, mossy bunkers, fallen logs.",
    floor: "#33452f",
    grid: "rgba(20,30,15,0.28)",
    colors: { large: "#6c5a42", medium: "#5c6e49", small: "#7a6547", barricade: "#4d3f2c" },
    scatter: { base: "#5b4630", accent: "#5c7a45", variant: "forest" },
    ground: "forestFloor",
    building: { insetFrac: 0.62, topFrac: 0.55 },
  },
  naboo: {
    key: "naboo",
    label: "Naboo",
    blurb: "Theed: marble domes, plaza stonework, reflecting pools.",
    floor: "#cdc5a1",
    grid: "rgba(110,95,55,0.25)",
    colors: { large: "#e7ddc4", medium: "#dccfa9", small: "#cabf95", barricade: "#d1c8a6" },
    scatter: { base: "#cdc2a0", accent: "#5f8a4f", variant: "ruins" },
    ground: "paving",
    building: { insetFrac: 0.55, topFrac: 0.62 },
  },
  tatooine: {
    key: "tatooine",
    label: "Tatooine",
    blurb: "Twin-sun dunes, sandstone outcrops, moisture farms.",
    floor: "#dcb877",
    grid: "rgba(120,85,35,0.22)",
    colors: { large: "#c99a5b", medium: "#b78a4f", small: "#a97d45", barricade: "#9c8054" },
    scatter: { base: "#8a6a3f", accent: "#c2985e", variant: "desert" },
    ground: "sand",
    building: { insetFrac: 0.68, topFrac: 0.5 },
  },
};

LM.DEFAULT_THEME = "tatooine";

// ---------------------------------------------------------------------------
// Tables & suggested terrain quantities
//
// Community table-building guides cite 25%-35% as a tournament-max ceiling, but that's
// noticeably denser than a normal recommended table — the counts below (piece counts
// pulled from an actual reference layout) land more like 19-23% coverage in practice,
// which is what the app's own coverage target reflects (see main.js).
// A suggested count is either a fixed number or a {min,max} range (resolved to a random
// concrete number once per generated layout — see generator.js's resolveSuggestedCounts).
LM.TABLES = {
  standard: {
    key: "standard",
    label: "Standard",
    dimsLabel: "3' × 6' (36\" × 72\")",
    length: 72, // along each player's deployment edge (the "long" edges)
    depth: 36, // between the two deployment edges
    suggested: { large: { min: 2, max: 3 }, medium: 6, small: 8, scatter: { min: 16, max: 24 }, barricade: 8 },
  },
  recon: {
    key: "recon",
    label: "Recon",
    dimsLabel: "3' × 3' (36\" × 36\")",
    length: 36,
    depth: 36,
    suggested: { large: 1, medium: 3, small: 4, scatter: { min: 8, max: 12 }, barricade: 4 },
  },
};

LM.coverageArea = function (counts) {
  let area = 0;
  for (const key of LM.TERRAIN_ORDER) {
    const n = counts[key] || 0;
    const cat = LM.TERRAIN_CATEGORIES[key];
    area += n * cat.width * cat.depth;
  }
  return area;
};

// ---------------------------------------------------------------------------
// Deployment zones (player Territory), in INCHES on the standard 6'x3' table.
//
// The Map Cards dimension every Territory with the range tool rather than as a share of the
// table, so these are absolute distances: 1/2 = 3", 1 = 6", 2 = 12", 3 = 18", 4 = 24".
// Read off the cards, they come out in whole 3" steps — every card annotates its zone depth
// as 1 + 1/2 (9"), which leaves range 3 (18") of no-man's-land down the middle of the board.
//
// A Territory is a LIST of rectangles, because plenty of them aren't a plain band: they can
// be L-shaped (a band along your own edge plus a salient running down a short edge into the
// enemy half) or split into two separate blocks at opposite ends of your edge.
//
// Only BLUE is entered by hand. Every Map Card setup is rotationally symmetric, so Red's
// Territory is Blue's turned 180 degrees about the table centre (see LM.getTerritories) —
// which also guarantees the two sides can never drift apart.
//
// x runs along the table length, y across the depth from Blue's own edge (y=0).
var CARD_LENGTH = 72; // the length the Map Card measurements are given for

// Builds a Territory from card measurements. Depths (y) stay absolute — they're range-tool
// distances from a board edge, which don't change with the table. Lengthwise (x) values
// scale with a shorter table, since there's no Recon Map Card to read exact numbers off.
function cardZone(rects) {
  return function (length, depth) {
    const sx = length / CARD_LENGTH;
    return rects.map(function (r) {
      return {
        x0: r.x0 * sx,
        x1: r.x1 * sx,
        y0: Math.min(r.y0, depth),
        y1: Math.min(r.y1, depth),
      };
    });
  };
}

var TERRITORIES = {
  // A band down your own long edge, 9" deep (range 1 1/2 — the depth every card gives),
  // starting `inset` in from one short edge and running `width` along the edge. Written the
  // way the card dimensions it, so each mission entry below carries its own card numbers.
  //
  // Because Red is Blue rotated 180 degrees, the inset decides how the pair sits: a band
  // that leaves its gap at ONE end alternates ends between the players (inset + width < 72),
  // while one inset equally at both ends lines up with the enemy band (inset * 2 + width
  // = 72). On screen Blue always holds the near edge, so an alternating pair can appear
  // rotated 180 degrees from the card artwork — same board, read from the other end.
  edgeBand: function (inset, width) {
    return cardZone([{ x0: inset, x1: inset + width, y0: 0, y1: 9 }]);
  },

  // Close the Pocket: your Territory is SPLIT into two 21" (3 + 1/2) blocks at opposite ends
  // of your own edge with a 30" gap between them, so each half sits range 3 (18") from enemy
  // territory but range 5 (30") from your own other half.
  splitEnds: cardZone([
    { x0: 0, x1: 21, y0: 0, y1: 9 },
    { x0: 51, x1: 72, y0: 0, y1: 9 },
  ]),

  // Breakthrough: the long-edge band is range 9 (54") wide, so it stops 18" (range 3) short
  // of one end, and a 9"-wide salient runs down the near short edge to 21" — past the middle
  // of the board, into the enemy half.
  breakthrough: cardZone([
    { x0: 0, x1: 54, y0: 0, y1: 9 },
    { x0: 0, x1: 9, y0: 9, y1: 21 },
  ]),

  // Outflank: TWO separate zones per player. A range 6 (36") band centred on your own long
  // edge, 9" deep, plus a range 1 (6") wide strip running range 4 (24") down the short edge
  // out of your left corner — well past the middle of the board. Red's pair mirrors Blue's.
  outflank: cardZone([
    { x0: 18, x1: 54, y0: 0, y1: 9 },
    { x0: 0, x1: 6, y0: 0, y1: 24 },
  ]),

  // Contact, Contact!: range 6 (36") of your own edge starting at your left, 9" deep — except
  // that after the first range 1 (6") a range 2 (12") section runs range 4 (24") deep, well
  // past the middle of the board. Red mirrors it, so the two Territories reach past each
  // other rather than meeting in the middle.
  contact: cardZone([
    { x0: 0, x1: 36, y0: 0, y1: 9 },
    { x0: 6, x1: 18, y0: 9, y1: 24 },
  ]),
};

// Resolves a mission's Territory into table inches for both players.
LM.getTerritories = function (tableKey, missionKey) {
  const table = LM.TABLES[tableKey];
  const mission = LM.MISSIONS[tableKey].find(function (m) { return m.key === missionKey; });
  const build = (mission && mission.territory) || TERRITORIES.edgeBand(0, 72);
  const blue = build(table.length, table.depth);
  const red = blue.map(function (r) {
    return {
      x0: table.length - r.x1,
      x1: table.length - r.x0,
      y0: table.depth - r.y1,
      y1: table.depth - r.y0,
    };
  });
  return { blue: blue, red: red };
};

// ---------------------------------------------------------------------------
// Mission POI layout patterns (fractional coordinates: fx across the length, fy across
// the depth, fy=0 is the Blue player's edge, fy=1 is the Red player's edge).
// Reused identically between Standard and Recon where AMG reused the same mission name.
// Written as inches-over-table-size where the Map Card gives a measurement for them.
var PATTERNS = {
  shiftingPriorities: [
    { fx: 0.5, fy: 0.5 },
    { fx: 0.28, fy: 0.28 },
    { fx: 0.72, fy: 0.28 },
    { fx: 0.28, fy: 0.72 },
    { fx: 0.72, fy: 0.72 },
  ],
  recoverTheResearch: [
    { fx: 0.33, fy: 0.25 }, { fx: 0.67, fy: 0.25 },
    { fx: 0.33, fy: 0.5 }, { fx: 0.67, fy: 0.5 },
    { fx: 0.33, fy: 0.75 }, { fx: 0.67, fy: 0.75 },
  ],
  interceptSignals: [
    { fx: 0.25, fy: 1 / 3 }, { fx: 0.75, fy: 1 / 3 },
    { fx: 0.25, fy: 2 / 3 }, { fx: 0.75, fy: 2 / 3 },
  ],
  // One Checkpoint sits in each player's band (48"/6" in) and one out in their salient
  // (6" from the short edge, level with the table centre) — matching the L-shaped Territory.
  breakthrough: [
    { fx: 48 / 72, fy: 6 / 36 }, { fx: 6 / 72, fy: 18 / 36 },
    { fx: 24 / 72, fy: 30 / 36 }, { fx: 66 / 72, fy: 18 / 36 },
  ],
  bunkerAssault: [
    { fx: 0.4, fy: 0.15 }, { fx: 0.6, fy: 0.15 },
    { fx: 0.4, fy: 0.85 }, { fx: 0.6, fy: 0.85 },
  ],
  // A straight line of 3 down the middle of the board: each Stockpile range 3 (18") from the
  // long edges, at range 3 intervals from the short edges — not a diagonal.
  closeThePocket: [
    { fx: 18 / 72, fy: 0.5 },
    { fx: 36 / 72, fy: 0.5 },
    { fx: 54 / 72, fy: 0.5 },
  ],
  payload: [
    { fx: 18 / 72, fy: 24 / 36 },
    { fx: 36 / 72, fy: 18 / 36 },
    { fx: 54 / 72, fy: 12 / 36 },
  ],
  // Cauldron: 6 markers ringing the centre — a pair 18" and 54" along the table 9" off each
  // long edge, and two more either side of the centre on the centre line.
  cauldron: [
    { fx: 18 / 72, fy: 9 / 36 }, { fx: 54 / 72, fy: 9 / 36 },
    { fx: 30 / 72, fy: 18 / 36 }, { fx: 42 / 72, fy: 18 / 36 },
    { fx: 18 / 72, fy: 27 / 36 }, { fx: 54 / 72, fy: 27 / 36 },
  ],
  // Outflank: 4 markers — one 12" x 12" into each of two opposite corners, plus two on the
  // centre line 12" and 24" up. The corner pair sits on the diagonal that puts each marker at
  // the far end of the ENEMY's flank strip, which is what those strips are reaching for.
  outflank: [
    { fx: 12 / 72, fy: 24 / 36 },
    { fx: 36 / 72, fy: 24 / 36 },
    { fx: 36 / 72, fy: 12 / 36 },
    { fx: 60 / 72, fy: 12 / 36 },
  ],
  // Contact, Contact!: 5 markers, read off the card in range steps in from the TOP-RIGHT
  // corner — 3 in / 1 down, 6 in / 1 down, 6 in / 3 down (dead centre), 6 in / 5 down,
  // 9 in / 5 down. The set is its own 180-degree rotation, so each player faces the same two
  // markers plus the centre.
  contactContact: [
    { fx: 54 / 72, fy: 6 / 36 },
    { fx: 36 / 72, fy: 6 / 36 },
    { fx: 36 / 72, fy: 18 / 36 },
    { fx: 36 / 72, fy: 30 / 36 },
    { fx: 18 / 72, fy: 30 / 36 },
  ],
};

LM.MISSIONS = {
  standard: [
    {
      key: "shifting-priorities",
      territory: TERRITORIES.edgeBand(18, 54), // 1 1/2 deep x 9 wide, alternating ends
      name: "Shifting Priorities",
      poiLabel: "Priority Target",
      pattern: PATTERNS.shiftingPriorities,
      setup: "Place 5 Priority Targets (POI) across the battlefield.",
      scoring: "Score 1 VP each End Phase (from Round 2) for each Priority Target you secure.",
      special: "At the end of each End Phase, each player relocates every Priority Target their opponent secured to within Range 3 of its current spot (Blue moves first). Each target can be moved this way only once per Round.",
    },
    {
      key: "recover-the-research",
      territory: TERRITORIES.edgeBand(12, 54), // 2 in, 1 1/2 deep x 9 wide, alternating ends
      name: "Recover the Research",
      poiLabel: "Lab",
      pattern: PATTERNS.recoverTheResearch,
      setup: "Place 6 Labs (POI) across the battlefield.",
      scoring: "From Round 2, score 1 VP for contesting 2 Labs, 2 VP for 3 Labs, or 3 VP for 4+ Labs each End Phase.",
      special: null,
    },
    {
      key: "intercept-signals",
      territory: TERRITORIES.edgeBand(12, 48), // 2 in, 1 1/2 deep x 8 wide, same both sides
      name: "Intercept Signals",
      poiLabel: "Comms Tower",
      pattern: PATTERNS.interceptSignals,
      setup: "Place 4 Comms Towers (POI). Each player picks 2 of the enemy units the opponent chose; those units gain an Intel token.",
      scoring: "From Round 2, score 1 VP per End Phase for each Comms Tower beyond friendly territory that is contested or secured by a friendly unit.",
      special: "Units contesting a secured Comms Tower may gain Intel tokens (max 2 per player).",
    },
    {
      key: "breakthrough",
      territory: TERRITORIES.breakthrough,
      name: "Breakthrough",
      poiLabel: "Checkpoint",
      pattern: PATTERNS.breakthrough,
      setup: "Place 4 Checkpoints (POI), 2 within each player's own territory.",
      scoring: "From Round 2, score 1 VP per End Phase for each uncontested Checkpoint in your own territory, and 2 VP for each you secure in enemy territory.",
      special: null,
    },
    {
      key: "bunker-assault",
      territory: TERRITORIES.edgeBand(12, 48), // 2 in, 1 1/2 deep x 8 wide, same both sides
      name: "Bunker Assault",
      poiLabel: "Bunker",
      pattern: PATTERNS.bunkerAssault,
      setup: "Place 4 Bunkers (POI), 2 within each player's own territory. The 2 set up furthest from your territory are your enemy's bunkers.",
      scoring: "From Round 2, score 1 VP per End Phase for each enemy Bunker you secure, plus 3 VP the Round an enemy Bunker is destroyed.",
      special: "Securing an enemy Bunker piles wound tokens on it each End Phase; at 3+ wounds it's destroyed.",
    },
    {
      key: "close-the-pocket",
      territory: TERRITORIES.splitEnds,
      name: "Close the Pocket",
      poiLabel: "Stockpile",
      pattern: PATTERNS.closeThePocket,
      setup: "Place 3 Stockpiles (POI) in a line across the middle of the board, each range 3 from a long edge and at range 3 intervals from the short edges.",
      scoring: "From Round 2, score 2 VP per End Phase for securing the center Stockpile, and 1 VP for each other Stockpile secured.",
      special: null,
    },
    // The four cards below were read from their Map Cards only — the matching Objective card
    // text isn't recorded here, so Setup describes the map and Scoring points at the card.
    {
      key: "payload",
      territory: TERRITORIES.edgeBand(0, 72), // 1 1/2 deep, full edge
      name: "Payload",
      poiLabel: "POI",
      pattern: PATTERNS.payload,
      setup: "Place 3 POIs on a diagonal through the center of the board. Both Territories are plain 9\"-deep bands along the long edges.",
      scoring: null,
      special: null,
    },
    {
      key: "cauldron",
      territory: TERRITORIES.edgeBand(0, 72), // 1 1/2 deep, full edge
      name: "Cauldron",
      poiLabel: "POI",
      pattern: PATTERNS.cauldron,
      setup: "Place 6 POIs scattered across the middle of the board, 3 in each half. Both Territories are plain 9\"-deep bands along the long edges.",
      scoring: null,
      special: null,
    },
    {
      key: "outflank",
      territory: TERRITORIES.outflank,
      name: "Outflank",
      poiLabel: "POI",
      pattern: PATTERNS.outflank,
      setup: "Place 4 POIs across the middle of the board. Each player has two Territories: a 9\"-deep, 36\"-wide band centred on their own long edge, plus a 6\"-wide strip running 24\" down the short edge out of their left corner.",
      scoring: null,
      special: null,
    },
    {
      key: "contact-contact",
      territory: TERRITORIES.contact,
      name: "Contact, Contact!",
      poiLabel: "POI",
      pattern: PATTERNS.contactContact,
      setup: "Place 5 POIs: 1 dead center, plus 2 per half — one on the table's center line 6\" from your own long edge, and one 18\" in from your right short edge, also 6\" from your long edge. Blue's Territory starts at its left and covers 36\" of its own long edge, 9\" deep — except for a 12\"-wide section (starting 6\" along) that runs 24\" deep, well past the middle of the board. Red's is the mirror opposite.",
      scoring: null,
      special: null,
    },
  ],
  recon: [
    {
      key: "intercept-signals",
      territory: TERRITORIES.edgeBand(12, 48), // 2 in, 1 1/2 deep x 8 wide, same both sides
      name: "Intercept Signals",
      poiLabel: "Comms Tower",
      pattern: PATTERNS.interceptSignals,
      setup: "Place 4 Comms Towers (POI). Each player picks 2 of the enemy units the opponent chose; those units gain an Intel token.",
      scoring: "From Round 2, score 1 VP per End Phase for each Comms Tower beyond friendly territory that is contested or secured.",
      special: "Units contesting a secured Comms Tower may gain Intel tokens (max 2 per player).",
    },
    {
      key: "bunker-assault",
      territory: TERRITORIES.edgeBand(12, 48), // 2 in, 1 1/2 deep x 8 wide, same both sides
      name: "Bunker Assault",
      poiLabel: "Bunker",
      pattern: PATTERNS.bunkerAssault,
      setup: "Place 4 Bunkers (POI), 2 within each player's own territory. The 2 set up furthest from your territory are your enemy's bunkers.",
      scoring: "From Round 2, score 1 VP per End Phase for each enemy Bunker you secure, plus 3 VP the Round an enemy Bunker is destroyed.",
      special: "Securing an enemy Bunker piles wound tokens on it each End Phase; at 3+ wounds it's destroyed.",
    },
    {
      key: "close-the-pocket",
      territory: TERRITORIES.splitEnds,
      name: "Close the Pocket",
      poiLabel: "Stockpile",
      pattern: PATTERNS.closeThePocket,
      setup: "Place 3 Stockpiles (POI) in a line across the middle of the board, evenly spaced between the short edges.",
      scoring: "From Round 2, score 2 VP per End Phase for securing the center Stockpile, and 1 VP for each other Stockpile secured.",
      special: null,
    },
  ],
};

// ---------------------------------------------------------------------------
// Secondary Objectives & Advantage cards — shown for flavor/reference next to a
// generated layout. Paraphrased summaries, not verbatim card text.
LM.SECONDARY_OBJECTIVES = [
  { name: "Recon Mission", summary: "Each player's chosen unit holding a Scanner scores 1 VP/Round for spotting 2+ enemy units." },
  { name: "Destroy Enemy Base", summary: "Each player defends a Base POI off-table-edge; score 4 VP for destroying the enemy's." },
  { name: "Surface Scan", summary: "Score for holding Scanners beyond friendly territory; bonus VP for contesting an unclaimed enemy Scanner." },
  { name: "Marked Targets", summary: "Each player marks 2 enemy units — defeating a Marked unit scores 1 VP." },
  { name: "Bring Them to Heel", summary: "Score for out-suppressing the enemy; fill a Panic/Suppression chart for bonus VPs." },
  { name: "Sweep and Clear", summary: "Score VPs (more in enemy territory) whenever a friendly unit defeats an enemy unit." },
];

LM.ADVANTAGE_CARDS = [
  { name: "Strafing Run", summary: "Once per game, drop an air-support strike — 4 black dice against units near the marker." },
  { name: "Ordnance", summary: "Once per game, place a ground ordnance token — 3 black dice, extra wounds against Armor." },
  { name: "Garrison", summary: "Give one Corps unit Prepared Position for the game." },
  { name: "Advanced Intel", summary: "Start the game with an extra Advantage token in your Pass Pool." },
  { name: "Cunning Deployment", summary: "3 chosen units start the game with a Dodge token." },
  { name: "Fortified Position", summary: "Place up to 3 Barricades in your territory or Contested territory, each beyond Range 1 of the others." },
];
