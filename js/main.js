(function () {
  const { TERRAIN_CATEGORIES, TERRAIN_ORDER, TABLES, MISSIONS, THEMES, SECONDARY_OBJECTIVES, ADVANTAGE_CARDS } = LM;
  const { generateLayout } = LM;
  const { renderLayout } = LM;

  const STORAGE_KEY = "legionMapper.state.v1";

  const tableSelect = document.getElementById("tableSelect");
  const missionSelect = document.getElementById("missionSelect");
  const themeSelect = document.getElementById("themeSelect");
  const themeBlurb = document.getElementById("themeBlurb");
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
  const cardsPanel = document.getElementById("cardsPanel");
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
  let lastHitRegions = [];
  let unproject = null;
  let lastProject = null;
  let currentSource = "own"; // 'own' | 'recommended'
  let viewMode = "iso"; // 'iso' | 'top'

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

  function renderCardsPanel() {
    const sec = SECONDARY_OBJECTIVES[Math.floor(Math.random() * SECONDARY_OBJECTIVES.length)];
    const adv = ADVANTAGE_CARDS[Math.floor(Math.random() * ADVANTAGE_CARDS.length)];
    cardsPanel.innerHTML = `
      <h2>Drawn Cards</h2>
      <ul class="card-list">
        <li><b>Secondary — ${sec.name}</b><br /><span>${sec.summary}</span></li>
        <li><b>Advantage — ${adv.name}</b><br /><span>${adv.summary}</span></li>
      </ul>
    `;
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
    modeHint.textContent =
      currentSource === "recommended"
        ? "Showing the recommended standard setup for this mission (ignores the form above)."
        : "Showing a layout built from your terrain collection above.";
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
    });
    lastHitRegions = res.regions;
    unproject = res.unproject;
    lastProject = res.project;
  }

  function afterLayoutChange(opts) {
    opts = opts || {};
    tableDimsLabel.textContent = `${lastLayout.mission.name} — ${lastLayout.table.dimsLabel}`;
    updateModeHint();
    refreshExposure();
    redraw();
    renderCoveragePanel(lastLayout);
    renderMissionInfoPanel(lastLayout);
    if (opts.redrawCardsPanel !== false) renderCardsPanel();
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

    const hit = hitRegionAt(mx, my);
    if (hit && hit.type === "terrain") {
      const w = unproject(mx, my);
      // Track the grab offset rather than snapping the piece to the cursor: the hit region
      // is the piece's TOP face, so unprojecting at ground level lands off-centre.
      drag = { piece: hit.data, offsetX: hit.data.x - w.x, offsetY: hit.data.y - w.y, moved: false };
      canvas.style.cursor = "grabbing";
      e.preventDefault();
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const { mx, my } = canvasPos(e);
    const w = unproject(mx, my);
    const table = lastLayout.table;
    drag.piece.x = Math.max(0, Math.min(table.length, w.x + drag.offsetX));
    drag.piece.y = Math.max(0, Math.min(table.depth, w.y + drag.offsetY));
    drag.moved = true;
    hoverTooltip.classList.add("hidden");
    redraw();
  });

  window.addEventListener("mouseup", () => {
    if (!drag) return;
    const piece = drag.piece;
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

  function updateStageHint() {
    if (measureMode) {
      stageHint.textContent = "Click two points to measure range";
    } else if (lockedIds.size) {
      stageHint.textContent = `${lockedIds.size} piece${lockedIds.size === 1 ? "" : "s"} pinned · reroll keeps them in place`;
    } else {
      stageHint.textContent = "Click a piece to pin it · drag to reposition";
    }
  }

  tableSelect.addEventListener("change", () => {
    populateMissionSelect();
    saveState();
  });
  themeSelect.addEventListener("change", () => {
    updateThemeBlurb();
    saveState();
    if (lastLayout) redraw();
  });
  generateBtn.addEventListener("click", () => runGenerate({ source: "own", clearLocks: true }));
  recommendedBtn.addEventListener("click", () => runGenerate({ source: "recommended", clearLocks: true }));
  regenerateBtn.addEventListener("click", () => runGenerate({ redrawCardsPanel: false }));
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
