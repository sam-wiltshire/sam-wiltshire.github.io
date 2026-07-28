(function () {
  const { TERRAIN_CATEGORIES, TERRAIN_ORDER, TABLES, MISSIONS, THEMES } = LM;
  const { generateLayout } = LM;
  const { renderLayout } = LM;

  const STORAGE_KEY = "legionMapper.state.v1";

  const tableSelect = document.getElementById("tableSelect");
  const missionSelect = document.getElementById("missionSelect");
  const themeSelect = document.getElementById("themeSelect");
  const themeBlurb = document.getElementById("themeBlurb");
  const terrainSourceSelect = document.getElementById("terrainSourceSelect");
  const terrainSourceHint = document.getElementById("terrainSourceHint");
  const terrainSourceRow = document.getElementById("terrainSourceRow");
  const terrainPanel = document.getElementById("terrainPanel");
  const modeSelect = document.getElementById("modeSelect");
  const generateControls = document.getElementById("generateControls");
  const buildPanel = document.getElementById("buildPanel");
  const palette = document.getElementById("palette");
  const selectionHint = document.getElementById("selectionHint");
  const clearBoardBtn = document.getElementById("clearBoardBtn");
  const loadCodeInput = document.getElementById("loadCodeInput");
  const loadCodeBtn = document.getElementById("loadCodeBtn");
  const loadCodeHint = document.getElementById("loadCodeHint");
  const inventoryForm = document.getElementById("inventoryForm");
  const generateBtn = document.getElementById("generateBtn");
  const recommendedBtn = document.getElementById("recommendedBtn");
  const regenerateBtn = document.getElementById("regenerateBtn");
  const viewToggleBtn = document.getElementById("viewToggleBtn");
  const canvas = document.getElementById("stageCanvas");
  const hoverTooltip = document.getElementById("hoverTooltip");
  const tableDimsLabel = document.getElementById("tableDimsLabel");
  const modeHint = document.getElementById("modeHint");
  const coveragePanel = document.getElementById("coveragePanel");
  const missionInfoPanel = document.getElementById("missionInfoPanel");
  const placementList = document.getElementById("placementList");
  const toggleListBtn = document.getElementById("toggleListBtn");
  const shareBtn = document.getElementById("shareBtn");
  const exportBtn = document.getElementById("exportBtn");
  const shareUrlInput = document.getElementById("shareUrl");
  const shareHint = document.getElementById("shareHint");
  const analysisPanel = document.getElementById("analysisPanel");
  const measureBtn = document.getElementById("measureBtn");
  const sightBtn = document.getElementById("sightBtn");
  const stageHint = document.getElementById("stageHint");

  let lastLayout = null;
  let lastHandle = null; // build mode: screen position of the selected piece's rotate handle
  let lastHitRegions = [];
  let unproject = null;
  let lastProject = null;
  let currentSource = "own"; // 'own' | 'recommended'
  let viewMode = "iso"; // 'iso' | 'top'
  let mode = "generate"; // 'generate' | 'build'
  let selectedId = null; // build mode: the piece being edited
  let buildSeq = 0;

  const lockedIds = new Set();
  let showSight = false;
  let measureMode = false;
  let measure = null; // { a, b } in table inches
  let exposure = null;
  let drag = null; // { piece, offsetX, offsetY, moved }

  function dimsLabel(cat) {
    return `${cat.width}" × ${cat.depth}" × ${cat.height}"`;
  }

  // --- Persistence: remember terrain counts + selections across visits -------------------
  function loadSavedState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          inventory: readInventory(),
          tableKey: tableSelect.value,
          missionKey: missionSelect.value,
          themeKey: themeSelect.value,
          terrainSource: terrainSourceSelect.value,
          mode,
        })
      );
    } catch (e) {
      // Storage can be unavailable (private browsing, quota) — saving is a nice-to-have.
    }
  }

  function populateTableSelect() {
    tableSelect.innerHTML = "";
    for (const key of Object.keys(TABLES)) {
      const t = TABLES[key];
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${t.label} — ${t.dimsLabel}`;
      tableSelect.appendChild(opt);
    }
  }

  function populateMissionSelect() {
    missionSelect.innerHTML = "";
    for (const m of MISSIONS[tableSelect.value]) {
      const opt = document.createElement("option");
      opt.value = m.key;
      opt.textContent = m.name;
      missionSelect.appendChild(opt);
    }
  }

  function populateThemeSelect() {
    themeSelect.innerHTML = "";
    for (const key of Object.keys(THEMES)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = THEMES[key].label;
      themeSelect.appendChild(opt);
    }
  }

  function updateThemeBlurb() {
    const theme = THEMES[themeSelect.value];
    themeBlurb.textContent = theme ? theme.blurb : "";
  }

  function buildInventoryForm() {
    inventoryForm.innerHTML = "";
    for (const key of TERRAIN_ORDER) {
      const cat = TERRAIN_CATEGORIES[key];
      const row = document.createElement("div");
      row.className = "inv-row";
      row.innerHTML = `
        <span class="inv-label">${cat.label}<small>${dimsLabel(cat)}</small></span>
        <input type="number" min="0" step="1" id="inv-${key}" placeholder="0" />
      `;
      inventoryForm.appendChild(row);
      row.querySelector("input").addEventListener("input", saveState);
    }
  }

  // --- Build mode: hand-place terrain for a post-mortem ----------------------------------
  // No generation at all here — the board starts bare and everything on it was put there by
  // the user, so the sight-line and coverage read-outs describe the table they actually
  // played on rather than a suggested one.
  function buildPalette() {
    palette.innerHTML = "";
    for (const key of TERRAIN_ORDER) {
      const cat = TERRAIN_CATEGORIES[key];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = `+ ${cat.label}<small>${cat.width}" × ${cat.depth}"</small>`;
      btn.addEventListener("click", () => addPiece(key));
      palette.appendChild(btn);
    }
  }

  function emptyLayout() {
    return LM.layoutFromPieces(tableSelect.value, missionSelect.value, []);
  }

  // Drops a new piece near the middle, nudged off-centre so repeated adds don't stack into
  // one pile, then selects it so it can be dragged and turned straight away.
  function addPiece(category) {
    if (!lastLayout) lastLayout = emptyLayout();
    const table = lastLayout.table;
    const jitter = (n) => (Math.random() - 0.5) * n;
    const piece = {
      id: `b${++buildSeq}`,
      category,
      x: Math.max(3, Math.min(table.length - 3, table.length / 2 + jitter(table.length * 0.35))),
      y: Math.max(3, Math.min(table.depth - 3, table.depth / 2 + jitter(table.depth * 0.5))),
      rotation: 0,
    };
    lastLayout.terrain.push(piece);
    selectedId = piece.id;
    afterBuildEdit();
  }

  function selectedPiece() {
    if (!selectedId || !lastLayout) return null;
    return lastLayout.terrain.find((p) => p.id === selectedId) || null;
  }

  function rotateSelected(deg) {
    const piece = selectedPiece();
    if (!piece) return;
    piece.rotation = (((piece.rotation + deg) % 360) + 360) % 360;
    afterBuildEdit();
  }

  function deleteSelected() {
    const piece = selectedPiece();
    if (!piece) return;
    lastLayout.terrain = lastLayout.terrain.filter((p) => p !== piece);
    selectedId = null;
    afterBuildEdit();
  }

  // Recount everything after an edit: coverage, the printable list, and — if it's switched
  // on — the sight-line pass, which is the whole point of building the table by hand.
  function afterBuildEdit() {
    // Dropping from Standard to Recon shrinks the board under the terrain, so keep every
    // piece on the table rather than leaving some floating off the edge.
    const t = TABLES[tableSelect.value];
    for (const p of lastLayout.terrain) {
      p.x = Math.max(0, Math.min(t.length, p.x));
      p.y = Math.max(0, Math.min(t.depth, p.y));
    }
    lastLayout = LM.layoutFromPieces(tableSelect.value, missionSelect.value, lastLayout.terrain);
    if (showSight) refreshExposure();
    redraw();
    renderPlacementList(lastLayout);
    updateSelectionHint();
    updateStageHint();
  }

  function updateSelectionHint() {
    const piece = selectedPiece();
    if (!piece) {
      const n = lastLayout ? lastLayout.terrain.length : 0;
      selectionHint.textContent = n
        ? `${n} piece${n === 1 ? "" : "s"} on the board · click one to select it.`
        : "Board is empty — add a piece above, or load a saved layout code.";
      return;
    }
    const cat = TERRAIN_CATEGORIES[piece.category];
    selectionHint.textContent =
      `Selected: ${cat.label} at ${piece.x.toFixed(1)}", ${piece.y.toFixed(1)}" · ${Math.round(piece.rotation)}°`;
  }

  function applyMode() {
    const build = mode === "build";
    generateControls.hidden = build;
    terrainSourceRow.hidden = build;
    buildPanel.hidden = !build;
    // Build mode replaces the collection form with the palette — nothing is generated from
    // your counts here — and the suggested-vs-available comparison stops meaning anything
    // when every piece on the table was placed by hand.
    terrainPanel.hidden = build;
    coveragePanel.hidden = build;
    // Nothing to reroll when every piece was placed by hand — the panel's Clear Board covers it.
    regenerateBtn.hidden = build;
    if (!build) selectedId = null;
    updateStageHint();
  }

  function enterBuildMode() {
    lastLayout = emptyLayout();
    selectedId = null;
    measure = null;
    lockedIds.clear();
    exposure = null;
    afterLayoutChange({});
    updateSelectionHint();
  }

  // Accepts either a bare code (v1.s.0.3...) or a whole share URL pasted in.
  function loadFromCode(raw) {
    const text = (raw || "").trim();
    if (!text) return { ok: false, msg: "Paste a layout code or share link first." };
    const code = text.includes("#") ? text.slice(text.indexOf("#") + 1) : text;
    const decoded = LM.decodeLayout(code);
    if (!decoded) return { ok: false, msg: "That doesn't look like a layout code — nothing loaded." };
    tableSelect.value = decoded.tableKey;
    populateMissionSelect();
    missionSelect.value = decoded.missionKey;
    if (THEMES[decoded.themeKey]) themeSelect.value = decoded.themeKey;
    updateThemeBlurb();
    lastLayout = LM.layoutFromPieces(decoded.tableKey, decoded.missionKey, decoded.terrain);
    buildSeq = 0;
    for (const p of lastLayout.terrain) p.id = `b${++buildSeq}`;
    selectedId = null;
    measure = null;
    lockedIds.clear();
    afterLayoutChange({});
    updateSelectionHint();
    return { ok: true, msg: `Loaded ${lastLayout.terrain.length} pieces — drag, rotate or delete any of them.` };
  }

  function readInventory() {
    const inv = {};
    for (const key of TERRAIN_ORDER) {
      const el = document.getElementById(`inv-${key}`);
      inv[key] = parseInt(el.value, 10) || 0;
    }
    return inv;
  }

  function applyInventory(inventory) {
    if (!inventory) return;
    for (const key of TERRAIN_ORDER) {
      const el = document.getElementById(`inv-${key}`);
      if (el && inventory[key]) el.value = inventory[key];
    }
  }

  function renderCoveragePanel(layout) {
    const { plan, coveragePct, usedCounts, unplaced } = layout;
    let html = "<h2>Suggested vs. Available</h2>";
    for (const key of TERRAIN_ORDER) {
      const p = plan[key];
      const placed = usedCounts[key];
      const cat = TERRAIN_CATEGORIES[key];
      let pill = `<span class="status-pill ok">placed ${placed}</span>`;
      if (p.shortfall > 0) pill = `<span class="status-pill short">short ${p.shortfall}</span>`;
      else if (p.surplus > 0) pill = `<span class="status-pill surplus">+${p.surplus} spare</span>`;
      let extra = "";
      if (unplaced[key] > 0) {
        extra = ` <span class="status-pill short">${unplaced[key]} didn't fit</span>`;
      }
      html += `<div class="coverage-row"><span>${cat.label} <span class="n">(${p.available} owned / ${p.suggested} suggested)</span></span>${pill}${extra}</div>`;
    }
    // Target reflects what the (now lower) suggested counts actually produce — roughly
    // 19-23% at full suggested amounts — not the old, higher tournament-max guideline.
    const pct = Math.round(coveragePct);
    const barPct = Math.min(100, (pct / 30) * 100);
    const barColor = pct < 12 ? "var(--bad)" : pct > 30 ? "var(--warn)" : "var(--good)";
    html += `
      <div class="coverage-row" style="margin-top:0.5rem"><span><b>Board coverage</b></span><span>${pct}% <span class="n">(target 15–25%)</span></span></div>
      <div class="coverage-bar-track"><div class="coverage-bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
    `;
    coveragePanel.innerHTML = html;
  }

  function renderMissionInfoPanel(layout) {
    const m = layout.mission;
    let html = `<h2>Mission</h2><p class="mission-name">${m.name}</p>`;
    html += `<div class="mission-block"><b>Setup</b>${m.setup}</div>`;
    html += `<div class="mission-block"><b>Scoring</b>${m.scoring || "Not recorded here — see the printed Objective card."}</div>`;
    if (m.special) html += `<div class="mission-block"><b>Special Rules</b>${m.special}</div>`;
    missionInfoPanel.innerHTML = html;
  }

  function renderPlacementList(layout) {
    const { pois, terrain } = layout;
    const rows = [];
    pois.forEach((p) => {
      rows.push({ label: p.label, color: "#c8281e", fromLeft: p.x.toFixed(1), fromBlue: p.y.toFixed(1) });
    });
    const catCounters = {};
    terrain.forEach((t) => {
      const cat = TERRAIN_CATEGORIES[t.category];
      catCounters[t.category] = (catCounters[t.category] || 0) + 1;
      rows.push({
        label: `${cat.label} #${catCounters[t.category]}`,
        color: { large: "#9aa4b8", medium: "#8098c2", small: "#8fae8f", scatter: "#c2a25a", barricade: "#b06a4f" }[t.category],
        fromLeft: t.x.toFixed(1),
        fromBlue: t.y.toFixed(1),
      });
    });
    let html = `<table><thead><tr><th>Piece</th><th>From left edge</th><th>From Blue edge</th></tr></thead><tbody>`;
    for (const r of rows) {
      html += `<tr><td><span class="swatch" style="background:${r.color}"></span>${r.label}</td><td>${r.fromLeft}"</td><td>${r.fromBlue}"</td></tr>`;
    }
    html += `</tbody></table>`;
    placementList.innerHTML = html;
  }

  function updateModeHint() {
    if (mode === "build") return; // build mode has its own hints in the build panel
    // An empty collection generates an empty board. That reads as a broken app in card mode,
    // where the drawn marks are the only thing left on the table — so say what's happening.
    if (currentSource === "own" && lastLayout && !lastLayout.terrain.length) {
      modeHint.textContent = lastLayout.layoutCards
        ? "No terrain entered yet, so the board is showing only the drawn card marks. Fill in what you own above, or press Show Recommended Standard Setup."
        : "No terrain entered yet. Fill in what you own above, or press Show Recommended Standard Setup.";
      return;
    }
    const base =
      currentSource === "recommended"
        ? "Showing the recommended standard setup for this mission (ignores the form above)."
        : "Showing a layout built from your terrain collection above.";
    const cards = lastLayout && lastLayout.layoutCards;
    modeHint.textContent = cards ? `${base} ${describeDrawnCards(cards)}` : base;
  }

  function describeDrawnCards(layoutCards) {
    const names = layoutCards.cards.map((c) => `Layout ${c.id}${c.rotated ? " (rotated)" : ""}`);
    const off = lastLayout.terrain.filter(
      (t) => LM.LAYOUT_CARD_RULES.markedCategories.includes(t.category) && !t.mark
    ).length;
    const tail = off
      ? ` ${off} piece${off === 1 ? "" : "s"} wouldn't fit a free mark, so ${off === 1 ? "it was" : "they were"} placed as close as possible instead.`
      : "";
    return `Drawn: ${names.join(" + ")}. The small green pips are the cards' marks, not terrain.${tail}`;
  }

  function updateTerrainSourceHint() {
    terrainSourceHint.textContent =
      terrainSourceSelect.value === "cards"
        ? "AMG's Terrain Layout Cards: two cards drawn at random (either may be rotated), then every Large/Medium/Small piece is placed overlapping one of the marks, at least 1/2 and ideally 1 from the others. Fill-in terrain goes anywhere."
        : "This app's own zoning: terrain spread evenly across the board with movement lanes between clusters.";
  }

  // Exposure is only recomputed when the layout actually changes, not on every repaint —
  // it's the one genuinely expensive calculation here.
  function refreshExposure() {
    exposure = showSight && lastLayout ? LM.computeExposure(lastLayout, { cellSize: 2 }) : null;
    renderAnalysisPanel();
  }

  function renderAnalysisPanel() {
    if (!showSight || !exposure) {
      analysisPanel.innerHTML = "";
      analysisPanel.style.display = "none";
      return;
    }
    analysisPanel.style.display = "";
    const s = exposure.stats;
    const lanePct = Math.round(s.clearLaneFrac * 100);
    // Judge openness by how much of the firing web is unobstructed, not by raw distance:
    // a corner-to-corner diagonal is long on any board, screened or not.
    const tooOpen = s.clearLaneFrac > 0.55;
    const tooDense = s.clearLaneFrac < 0.12;
    const laneColor = tooOpen ? "var(--bad)" : tooDense ? "var(--warn)" : "var(--good)";
    let verdict = "Balanced — cover to advance through, but firing lanes still matter.";
    if (tooOpen) verdict = "Very open — most of the board is under fire from deployment. Consider another tall LOS blocker near the centre.";
    else if (tooDense) verdict = "Very closed — almost nothing has line of sight across the board, which can stall shooting armies.";
    analysisPanel.innerHTML = `
      <h2>Sight Lines</h2>
      <div class="stat-row"><span>Clear firing lanes</span><span class="v" style="color:${laneColor}">${lanePct}%</span></div>
      <div class="stat-row"><span>Average exposure</span><span class="v">${Math.round(s.avgExposure * 100)}%</span></div>
      <div class="stat-row"><span>Ground with good cover</span><span class="v">${Math.round(s.coveredFrac * 100)}%</span></div>
      <div class="stat-row"><span>Longest clear shot</span><span class="v">${Math.round(s.longestLane)}"</span></div>
      <div class="legend"><span>covered</span><span class="legend-bar"></span><span>exposed</span></div>
      <p class="stat-note">${verdict}</p>
    `;
  }

  function redraw() {
    const res = renderLayout(canvas, lastLayout, viewMode, themeSelect.value, {
      exposure,
      lockedIds,
      measure,
      selectedId: mode === "build" ? selectedId : null,
    });
    lastHitRegions = res.regions;
    unproject = res.unproject;
    lastProject = res.project;
    lastHandle = res.handle || null;
  }

  function afterLayoutChange(opts) {
    opts = opts || {};
    tableDimsLabel.textContent = `${lastLayout.mission.name} — ${lastLayout.table.dimsLabel}`;
    updateModeHint();
    refreshExposure();
    redraw();
    if (mode !== "build") renderCoveragePanel(lastLayout);
    renderMissionInfoPanel(lastLayout);
    renderPlacementList(lastLayout);
    saveState();
  }

  function runGenerate(opts) {
    opts = opts || {};
    if (opts.source) currentSource = opts.source;
    const tableKey = tableSelect.value;
    const missionKey = missionSelect.value;
    const useRecommended = currentSource === "recommended";

    // Pinned pieces survive a reroll; anything else is regenerated around them.
    const keep = lastLayout && !opts.clearLocks
      ? lastLayout.terrain.filter((p) => lockedIds.has(p.id))
      : [];
    if (opts.clearLocks) lockedIds.clear();

    lastLayout = generateLayout({
      tableKey,
      missionKey,
      inventory: readInventory(),
      useRecommended,
      locked: keep,
      terrainSource: terrainSourceSelect.value,
    });
    measure = null;
    afterLayoutChange(opts);
  }

  function hitRegionAt(mx, my) {
    for (const region of lastHitRegions) {
      if (region.type === "poi") {
        if (Math.hypot(mx - region.x, my - region.y) <= region.r) return region;
      } else if (LM.pointInPoly(mx, my, region.pts)) {
        return region;
      }
    }
    return null;
  }

  function tooltipContent(region) {
    if (region.type === "poi") {
      return `<b>${region.data.label}</b><br>Point of Interest — Mission objective`;
    }
    const cat = TERRAIN_CATEGORIES[region.data.category];
    const rot = Math.round(((region.data.rotation % 360) + 360) % 360);
    return `<b>${cat.label} terrain</b><br>${cat.width}" × ${cat.depth}" × ${cat.height}" &middot; ${cat.cover} cover<br>rotated ${rot}°`;
  }

  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
  }

  // Legion's range ruler is five 6" segments; anything past 30" is "beyond Range 5".
  function rangeBand(inches) {
    if (inches <= 3) return "within Half Range";
    const band = Math.ceil(inches / 6);
    return band <= 5 ? `Range ${band}` : "beyond Range 5";
  }

  function showMeasureReadout() {
    if (!measure || !measure.a || !measure.b) return;
    const dist = Math.hypot(measure.b.x - measure.a.x, measure.b.y - measure.a.y);
    hoverTooltip.innerHTML = `<b>${dist.toFixed(1)}"</b><br>${rangeBand(dist)}`;
    const p = renderLayoutProjectPoint(measure.b);
    hoverTooltip.style.left = `${p.x}px`;
    hoverTooltip.style.top = `${p.y}px`;
    hoverTooltip.classList.remove("hidden");
  }

  // The renderer hands back its projector, so the measurement label can sit on the
  // measured point itself rather than tracking the cursor.
  function renderLayoutProjectPoint(pt) {
    return lastProject ? lastProject(pt.x, pt.y, 0.06) : { x: 0, y: 0 };
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!lastLayout || !unproject) return;
    const { mx, my } = canvasPos(e);

    if (measureMode) {
      const w = unproject(mx, my);
      if (!measure || (measure.a && measure.b)) measure = { a: w, b: null };
      else measure.b = w;
      redraw();
      showMeasureReadout();
      return;
    }

    // Build mode: grabbing the handle beside the selected piece turns it instead of moving it.
    if (mode === "build" && lastHandle) {
      if (Math.hypot(mx - lastHandle.sx, my - lastHandle.sy) <= lastHandle.r + 4) {
        const piece = selectedPiece();
        if (piece) {
          drag = { piece, rotating: true, moved: false };
          canvas.style.cursor = "grabbing";
          e.preventDefault();
          return;
        }
      }
    }

    const hit = hitRegionAt(mx, my);
    if (hit && hit.type === "terrain") {
      const w = unproject(mx, my);
      // Track the grab offset rather than snapping the piece to the cursor: the hit region
      // is the piece's TOP face, so unprojecting at ground level lands off-centre.
      drag = { piece: hit.data, offsetX: hit.data.x - w.x, offsetY: hit.data.y - w.y, moved: false };
      if (mode === "build") {
        selectedId = hit.data.id;
        updateSelectionHint();
        redraw();
      }
      canvas.style.cursor = "grabbing";
      e.preventDefault();
    } else if (mode === "build") {
      selectedId = null;
      updateSelectionHint();
      redraw();
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const { mx, my } = canvasPos(e);
    const w = unproject(mx, my);
    const table = lastLayout.table;
    if (drag.rotating) {
      // Point the piece's "up" axis at the cursor, measured on the ground plane so the angle
      // still tracks the pointer in the isometric view.
      const deg = (Math.atan2(w.y - drag.piece.y, w.x - drag.piece.x) * 180) / Math.PI;
      drag.piece.rotation = (((deg - 90) % 360) + 360) % 360;
    } else {
      drag.piece.x = Math.max(0, Math.min(table.length, w.x + drag.offsetX));
      drag.piece.y = Math.max(0, Math.min(table.depth, w.y + drag.offsetY));
    }
    drag.moved = true;
    hoverTooltip.classList.add("hidden");
    if (mode === "build") updateSelectionHint();
    redraw();
  });

  window.addEventListener("mouseup", () => {
    if (!drag) return;
    const piece = drag.piece;
    // Build mode has no reroll to protect a piece from, so a click selects rather than pins
    // and any edit just refreshes the read-outs.
    if (mode === "build") {
      selectedId = piece.id;
      drag = null;
      canvas.style.cursor = "default";
      afterBuildEdit();
      return;
    }
    if (!drag.moved) {
      // A click without movement toggles the pin.
      if (lockedIds.has(piece.id)) lockedIds.delete(piece.id);
      else lockedIds.add(piece.id);
    } else {
      // A hand-placed piece is implicitly pinned — a reroll shouldn't undo the move.
      lockedIds.add(piece.id);
      if (showSight) refreshExposure();
      renderPlacementList(lastLayout);
    }
    drag = null;
    canvas.style.cursor = "default";
    updateStageHint();
    redraw();
  });

  canvas.addEventListener("mousemove", (e) => {
    if (drag || measureMode) return;
    const { mx, my } = canvasPos(e);
    const hit = hitRegionAt(mx, my);
    if (hit) {
      let html = tooltipContent(hit);
      if (hit.type === "terrain") {
        html += lockedIds.has(hit.data.id) ? "<br><i>pinned — click to unpin</i>" : "<br><i>click to pin · drag to move</i>";
      }
      hoverTooltip.innerHTML = html;
      hoverTooltip.style.left = `${mx}px`;
      hoverTooltip.style.top = `${my}px`;
      hoverTooltip.classList.remove("hidden");
      canvas.style.cursor = hit.type === "terrain" ? "grab" : "pointer";
    } else {
      hoverTooltip.classList.add("hidden");
      canvas.style.cursor = "default";
    }
  });
  canvas.addEventListener("mouseleave", () => {
    if (!drag && !measureMode) hoverTooltip.classList.add("hidden");
  });

  // Wheel over a piece rotates it — 5 degrees a notch, 1 with Shift held for fine tuning.
  // Only ever consumes the scroll when it's actually over a piece, so the page still scrolls.
  canvas.addEventListener("wheel", (e) => {
    if (mode !== "build" || measureMode || !lastLayout) return;
    const { mx, my } = canvasPos(e);
    const hit = hitRegionAt(mx, my);
    const piece = hit && hit.type === "terrain" ? hit.data : null;
    if (!piece) return;
    e.preventDefault();
    selectedId = piece.id;
    const step = e.shiftKey ? 1 : 5;
    piece.rotation = (((piece.rotation + (e.deltaY > 0 ? step : -step)) % 360) + 360) % 360;
    afterBuildEdit();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (mode !== "build") return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
    const step = e.shiftKey ? 1 : 5;
    if (e.key === "[") rotateSelected(-step);
    else if (e.key === "]") rotateSelected(step);
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (!selectedPiece()) return;
      e.preventDefault();
      deleteSelected();
    } else return;
  });

  function updateStageHint() {
    if (measureMode) {
      stageHint.textContent = "Click two points to measure range";
    } else if (mode === "build") {
      stageHint.textContent = selectedPiece()
        ? "Drag to move · drag the handle, scroll or [ ] to rotate · Del to remove"
        : "Add a piece from the palette, or click one to select it";
    } else if (lockedIds.size) {
      stageHint.textContent = `${lockedIds.size} piece${lockedIds.size === 1 ? "" : "s"} pinned · reroll keeps them in place`;
    } else {
      stageHint.textContent = "Click a piece to pin it · drag to reposition";
    }
  }

  modeSelect.addEventListener("change", () => {
    mode = modeSelect.value;
    applyMode();
    saveState();
    if (mode === "build") enterBuildMode();
    else runGenerate({ clearLocks: true });
  });

  buildPalette();
  clearBoardBtn.addEventListener("click", () => {
    loadCodeHint.textContent = "";
    enterBuildMode();
  });
  loadCodeBtn.addEventListener("click", () => {
    const res = loadFromCode(loadCodeInput.value);
    loadCodeHint.textContent = res.msg;
  });

  tableSelect.addEventListener("change", () => {
    populateMissionSelect();
    saveState();
    // In build mode there's no Generate button to press, so the board follows the selection
    // immediately — keeping the terrain, since it's the user's own hand-placed table.
    if (mode === "build") {
      if (!lastLayout) enterBuildMode();
      else afterBuildEdit();
    }
  });
  missionSelect.addEventListener("change", () => {
    saveState();
    if (mode === "build" && lastLayout) afterBuildEdit();
  });
  // Switching terrain source changes placement outright, so rebuild rather than just redraw.
  terrainSourceSelect.addEventListener("change", () => {
    updateTerrainSourceHint();
    saveState();
    runGenerate({ clearLocks: true });
  });
  themeSelect.addEventListener("change", () => {
    updateThemeBlurb();
    saveState();
    if (lastLayout) redraw();
  });
  generateBtn.addEventListener("click", () => runGenerate({ source: "own", clearLocks: true }));
  recommendedBtn.addEventListener("click", () => runGenerate({ source: "recommended", clearLocks: true }));
  // Reroll would throw away a hand-built table, so in build mode it clears instead.
  regenerateBtn.addEventListener("click", () => {
    if (mode === "build") enterBuildMode();
    else runGenerate({});
  });
  viewToggleBtn.addEventListener("click", () => {
    viewMode = viewMode === "iso" ? "top" : "iso";
    viewToggleBtn.textContent = viewMode === "iso" ? "Bird's-Eye View" : "Isometric View";
    redraw();
  });

  sightBtn.addEventListener("click", () => {
    showSight = !showSight;
    sightBtn.classList.toggle("active", showSight);
    refreshExposure();
    redraw();
  });

  measureBtn.addEventListener("click", () => {
    measureMode = !measureMode;
    measureBtn.classList.toggle("active", measureMode);
    if (!measureMode) {
      measure = null;
      hoverTooltip.classList.add("hidden");
      redraw();
    }
    updateStageHint();
  });

  shareBtn.addEventListener("click", () => {
    if (!lastLayout) return;
    const hash = "#" + LM.encodeLayout(lastLayout, themeSelect.value);
    const url = location.href.split("#")[0] + hash;
    history.replaceState(null, "", hash);
    shareUrlInput.value = url;
    shareUrlInput.classList.remove("hidden");
    shareUrlInput.select();
    // Clipboard API is unavailable on file:// in some browsers, so the input above is the
    // guaranteed fallback rather than an afterthought.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        () => { shareHint.textContent = "Link copied to clipboard."; },
        () => { shareHint.textContent = "Copy the link above (clipboard blocked)."; }
      );
    } else {
      shareHint.textContent = "Copy the link above.";
    }
  });

  exportBtn.addEventListener("click", () => {
    if (!lastLayout) return;
    shareHint.textContent = "Rendering image…";
    // Let the label paint before the synchronous high-res render blocks the thread.
    setTimeout(() => {
      LM.exportPNG(lastLayout, viewMode, themeSelect.value, { exposure });
      shareHint.textContent = "PNG downloaded.";
    }, 30);
  });

  toggleListBtn.addEventListener("click", () => {
    const hidden = placementList.classList.toggle("hidden");
    toggleListBtn.textContent = hidden ? "Show printable placement list ▾" : "Hide printable placement list ▴";
  });
  window.addEventListener("resize", () => {
    if (lastLayout) redraw();
  });

  // --- Boot ------------------------------------------------------------------------------
  const saved = loadSavedState();
  const shared = LM.decodeLayout(location.hash);

  populateTableSelect();
  if (shared) tableSelect.value = shared.tableKey;
  else if (saved && TABLES[saved.tableKey]) tableSelect.value = saved.tableKey;

  populateMissionSelect();
  if (shared) missionSelect.value = shared.missionKey;
  else if (saved && saved.missionKey && MISSIONS[tableSelect.value].some((m) => m.key === saved.missionKey)) {
    missionSelect.value = saved.missionKey;
  }

  populateThemeSelect();
  themeSelect.value = shared ? shared.themeKey : (saved && THEMES[saved.themeKey]) ? saved.themeKey : LM.DEFAULT_THEME;
  updateThemeBlurb();

  if (saved && saved.terrainSource) terrainSourceSelect.value = saved.terrainSource;
  updateTerrainSourceHint();

  // A shared link always lands in generate mode — it describes a finished table.
  if (!shared && saved && saved.mode === "build") mode = "build";
  modeSelect.value = mode;
  applyMode();

  buildInventoryForm();
  if (saved) applyInventory(saved.inventory);

  if (shared) {
    // A shared link is an exact table, so rebuild it verbatim instead of generating.
    lastLayout = LM.layoutFromPieces(shared.tableKey, shared.missionKey, shared.terrain);
    shareHint.textContent = "Loaded a shared layout.";
    afterLayoutChange();
  } else {
    runGenerate({ source: "own" });
  }
  updateStageHint();
})();
