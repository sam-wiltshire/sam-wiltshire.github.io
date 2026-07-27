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
// So: POI/Territory layouts below are a best-effort, symmetric approximation of each
// official Map Card (exact card artwork isn't machine-readable), while generic terrain
// (Large/Medium/Small/Scatter/Barricade) is generated fresh each time from your inventory,
// which is the part the rules actually leave open — and the part this tool is for.
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
    building: { insetFrac: 0.68, topFrac: 0.5 },
  },
};

LM.DEFAULT_THEME = "tatooine";

// ---------------------------------------------------------------------------
// Tables & suggested terrain quantities
//
// AMG's tournament guidance (via community table-building guides, not the core rulebook)
// targets 25%-35% board coverage. The suggested counts below are tuned to land in that
// band using the user's actual terrain footprints above.
LM.TABLES = {
  standard: {
    key: "standard",
    label: "Standard",
    dimsLabel: "3' × 6' (36\" × 72\")",
    length: 72, // along each player's deployment edge (the "long" edges)
    depth: 36, // between the two deployment edges
    territoryFrac: 1 / 3,
    suggested: { large: 3, medium: 9, small: 14, scatter: 30, barricade: 10 },
  },
  recon: {
    key: "recon",
    label: "Recon",
    dimsLabel: "3' × 3' (36\" × 36\")",
    length: 36,
    depth: 36,
    territoryFrac: 1 / 3,
    suggested: { large: 1, medium: 5, small: 7, scatter: 15, barricade: 5 },
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
// Mission POI layout patterns (fractional coordinates: fx across the length, fy across
// the depth, fy=0 is the Blue player's edge, fy=1 is the Red player's edge).
// Reused identically between Standard and Recon where AMG reused the same mission name.
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
  breakthrough: [
    { fx: 0.2, fy: 0.15 }, { fx: 0.8, fy: 0.15 },
    { fx: 0.2, fy: 0.85 }, { fx: 0.8, fy: 0.85 },
  ],
  bunkerAssault: [
    { fx: 0.4, fy: 0.15 }, { fx: 0.6, fy: 0.15 },
    { fx: 0.4, fy: 0.85 }, { fx: 0.6, fy: 0.85 },
  ],
  closeThePocket: [
    { fx: 0.5, fy: 0.5 },
    { fx: 0.22, fy: 0.18 },
    { fx: 0.78, fy: 0.82 },
  ],
};

LM.MISSIONS = {
  standard: [
    {
      key: "shifting-priorities",
      name: "Shifting Priorities",
      poiLabel: "Priority Target",
      pattern: PATTERNS.shiftingPriorities,
      setup: "Place 5 Priority Targets (POI) across the battlefield.",
      scoring: "Score 1 VP each End Phase (from Round 2) for each Priority Target you secure.",
      special: "At the end of each End Phase, each player relocates every Priority Target their opponent secured to within Range 3 of its current spot (Blue moves first). Each target can be moved this way only once per Round.",
    },
    {
      key: "recover-the-research",
      name: "Recover the Research",
      poiLabel: "Lab",
      pattern: PATTERNS.recoverTheResearch,
      setup: "Place 6 Labs (POI) across the battlefield.",
      scoring: "From Round 2, score 1 VP for contesting 2 Labs, 2 VP for 3 Labs, or 3 VP for 4+ Labs each End Phase.",
      special: null,
    },
    {
      key: "intercept-signals",
      name: "Intercept Signals",
      poiLabel: "Comms Tower",
      pattern: PATTERNS.interceptSignals,
      setup: "Place 4 Comms Towers (POI). Each player picks 2 of the enemy units the opponent chose; those units gain an Intel token.",
      scoring: "From Round 2, score 1 VP per End Phase for each Comms Tower beyond friendly territory that is contested or secured by a friendly unit.",
      special: "Units contesting a secured Comms Tower may gain Intel tokens (max 2 per player).",
    },
    {
      key: "breakthrough",
      name: "Breakthrough",
      poiLabel: "Checkpoint",
      pattern: PATTERNS.breakthrough,
      setup: "Place 4 Checkpoints (POI), 2 within each player's own territory.",
      scoring: "From Round 2, score 1 VP per End Phase for each uncontested Checkpoint in your own territory, and 2 VP for each you secure in enemy territory.",
      special: null,
    },
    {
      key: "bunker-assault",
      name: "Bunker Assault",
      poiLabel: "Bunker",
      pattern: PATTERNS.bunkerAssault,
      setup: "Place 4 Bunkers (POI), 2 within each player's own territory. The 2 set up furthest from your territory are your enemy's bunkers.",
      scoring: "From Round 2, score 1 VP per End Phase for each enemy Bunker you secure, plus 3 VP the Round an enemy Bunker is destroyed.",
      special: "Securing an enemy Bunker piles wound tokens on it each End Phase; at 3+ wounds it's destroyed.",
    },
    {
      key: "close-the-pocket",
      name: "Close the Pocket",
      poiLabel: "Stockpile",
      pattern: PATTERNS.closeThePocket,
      setup: "Place 3 Stockpiles (POI): 1 at the center, 2 off-center on opposite diagonals.",
      scoring: "From Round 2, score 2 VP per End Phase for securing the center Stockpile, and 1 VP for each other Stockpile secured.",
      special: null,
    },
  ],
  recon: [
    {
      key: "intercept-signals",
      name: "Intercept Signals",
      poiLabel: "Comms Tower",
      pattern: PATTERNS.interceptSignals,
      setup: "Place 4 Comms Towers (POI). Each player picks 2 of the enemy units the opponent chose; those units gain an Intel token.",
      scoring: "From Round 2, score 1 VP per End Phase for each Comms Tower beyond friendly territory that is contested or secured.",
      special: "Units contesting a secured Comms Tower may gain Intel tokens (max 2 per player).",
    },
    {
      key: "bunker-assault",
      name: "Bunker Assault",
      poiLabel: "Bunker",
      pattern: PATTERNS.bunkerAssault,
      setup: "Place 4 Bunkers (POI), 2 within each player's own territory. The 2 set up furthest from your territory are your enemy's bunkers.",
      scoring: "From Round 2, score 1 VP per End Phase for each enemy Bunker you secure, plus 3 VP the Round an enemy Bunker is destroyed.",
      special: "Securing an enemy Bunker piles wound tokens on it each End Phase; at 3+ wounds it's destroyed.",
    },
    {
      key: "close-the-pocket",
      name: "Close the Pocket",
      poiLabel: "Stockpile",
      pattern: PATTERNS.closeThePocket,
      setup: "Place 3 Stockpiles (POI): 1 at the center, 2 off-center on opposite diagonals.",
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
