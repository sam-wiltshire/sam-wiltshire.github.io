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

  let lastLayout = null;
  let lastHitRegions = [];
  let currentSource = "own"; // 'own' | 'recommended'
  let viewMode = "iso"; // 'iso' | 'top'

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
    html += `<div class="mission-block"><b>Scoring</b>${m.scoring}</div>`;
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

  function redraw() {
    lastHitRegions = renderLayout(canvas, lastLayout, viewMode, themeSelect.value);
  }

  function runGenerate(opts) {
    opts = opts || {};
    if (opts.source) currentSource = opts.source;
    const redrawCardsPanel = opts.redrawCardsPanel !== false;
    const tableKey = tableSelect.value;
    const missionKey = missionSelect.value;
    const useRecommended = currentSource === "recommended";
    const layout = generateLayout({ tableKey, missionKey, inventory: readInventory(), useRecommended });
    lastLayout = layout;

    tableDimsLabel.textContent = `${layout.mission.name} — ${layout.table.dimsLabel}`;
    updateModeHint();
    redraw();
    renderCoveragePanel(layout);
    renderMissionInfoPanel(layout);
    if (redrawCardsPanel) renderCardsPanel();
    renderPlacementList(layout);
    saveState();
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

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitRegionAt(mx, my);
    if (hit) {
      hoverTooltip.innerHTML = tooltipContent(hit);
      hoverTooltip.style.left = `${mx}px`;
      hoverTooltip.style.top = `${my}px`;
      hoverTooltip.classList.remove("hidden");
      canvas.style.cursor = "pointer";
    } else {
      hoverTooltip.classList.add("hidden");
      canvas.style.cursor = "default";
    }
  });
  canvas.addEventListener("mouseleave", () => {
    hoverTooltip.classList.add("hidden");
  });

  tableSelect.addEventListener("change", () => {
    populateMissionSelect();
    saveState();
  });
  themeSelect.addEventListener("change", () => {
    updateThemeBlurb();
    saveState();
    if (lastLayout) redraw();
  });
  generateBtn.addEventListener("click", () => runGenerate({ source: "own" }));
  recommendedBtn.addEventListener("click", () => runGenerate({ source: "recommended" }));
  regenerateBtn.addEventListener("click", () => runGenerate({ redrawCardsPanel: false }));
  viewToggleBtn.addEventListener("click", () => {
    viewMode = viewMode === "iso" ? "top" : "iso";
    viewToggleBtn.textContent = viewMode === "iso" ? "Bird's-Eye View" : "Isometric View";
    redraw();
  });
  toggleListBtn.addEventListener("click", () => {
    const hidden = placementList.classList.toggle("hidden");
    toggleListBtn.textContent = hidden ? "Show printable placement list ▾" : "Hide printable placement list ▴";
  });
  window.addEventListener("resize", () => {
    if (lastLayout) redraw();
  });

  const saved = loadSavedState();

  populateTableSelect();
  if (saved && TABLES[saved.tableKey]) tableSelect.value = saved.tableKey;

  populateMissionSelect();
  if (saved && saved.missionKey && MISSIONS[tableSelect.value].some((m) => m.key === saved.missionKey)) {
    missionSelect.value = saved.missionKey;
  }

  populateThemeSelect();
  themeSelect.value = (saved && THEMES[saved.themeKey]) ? saved.themeKey : LM.DEFAULT_THEME;
  updateThemeBlurb();

  buildInventoryForm();
  if (saved) applyInventory(saved.inventory);

  runGenerate({ source: "own" });
})();
