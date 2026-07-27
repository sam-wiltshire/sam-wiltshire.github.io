var LM = window.LM || (window.LM = {});

// Layout sharing (URL) and image export.
//
// A layout is encoded as an exact list of piece positions rather than a random seed:
// pieces can be dragged and pinned by hand after generation, so a seed alone could not
// reproduce what's actually on screen.
(function () {
  const VERSION = "1";
  const TABLE_CODE = { standard: "s", recon: "r" };
  const CODE_TABLE = { s: "standard", r: "recon" };

  // Fixed-width base36 fields, no delimiters — quantised to 0.25" of position and 5 deg of
  // rotation, which is far finer than anyone places terrain by hand and keeps a full
  // 45-piece table inside a comfortable URL length.
  const CHARS_XY = 2;
  const CHARS_ROT = 2;

  function pad(n, width) {
    const s = Math.max(0, Math.round(n)).toString(36);
    return s.length >= width ? s.slice(-width) : "0".repeat(width - s.length) + s;
  }

  function encodePieces(terrain) {
    let out = "";
    for (const p of terrain) {
      const catIdx = LM.TERRAIN_ORDER.indexOf(p.category);
      if (catIdx < 0) continue;
      const rot = ((p.rotation % 360) + 360) % 360;
      out += catIdx.toString(36);
      out += pad(p.x * 4, CHARS_XY);
      out += pad(p.y * 4, CHARS_XY);
      out += pad(rot / 5, CHARS_ROT);
    }
    return out;
  }

  function decodePieces(str) {
    const stride = 1 + CHARS_XY * 2 + CHARS_ROT;
    const out = [];
    for (let i = 0; i + stride <= str.length; i += stride) {
      const catIdx = parseInt(str[i], 36);
      const category = LM.TERRAIN_ORDER[catIdx];
      if (!category) continue;
      const x = parseInt(str.substr(i + 1, CHARS_XY), 36) / 4;
      const y = parseInt(str.substr(i + 1 + CHARS_XY, CHARS_XY), 36) / 4;
      const rotation = parseInt(str.substr(i + 1 + CHARS_XY * 2, CHARS_ROT), 36) * 5;
      if (!isFinite(x) || !isFinite(y) || !isFinite(rotation)) continue;
      out.push({ category, x, y, rotation });
    }
    return out;
  }

  LM.encodeLayout = function (layout, themeKey) {
    const tableKey = layout.table.key;
    const missions = LM.MISSIONS[tableKey];
    const missionIdx = missions.findIndex((m) => m.key === layout.mission.key);
    const themeIdx = Object.keys(LM.THEMES).indexOf(themeKey);
    return [
      "v" + VERSION,
      TABLE_CODE[tableKey] || "s",
      Math.max(0, missionIdx).toString(36),
      Math.max(0, themeIdx).toString(36),
      encodePieces(layout.terrain),
    ].join(".");
  };

  // Returns null for anything unparseable — a mangled link should fall back to a normal
  // fresh layout, never throw on load.
  LM.decodeLayout = function (hash) {
    if (!hash) return null;
    const raw = hash.replace(/^#/, "");
    const parts = raw.split(".");
    if (parts.length < 5 || parts[0] !== "v" + VERSION) return null;
    const tableKey = CODE_TABLE[parts[1]];
    if (!tableKey || !LM.TABLES[tableKey]) return null;
    const missions = LM.MISSIONS[tableKey];
    const mission = missions[parseInt(parts[2], 36)] || missions[0];
    const themeKey = Object.keys(LM.THEMES)[parseInt(parts[3], 36)] || LM.DEFAULT_THEME;
    const terrain = decodePieces(parts.slice(4).join("."));
    if (!terrain.length) return null;
    return { tableKey, missionKey: mission.key, themeKey, terrain };
  };

  // Rebuilds a full layout object (POIs, counts, coverage) around a decoded piece list, so
  // a shared link produces exactly the same side panels as a freshly generated table.
  LM.layoutFromPieces = function (tableKey, missionKey, terrain) {
    const table = LM.TABLES[tableKey];
    const mission = LM.MISSIONS[tableKey].find((m) => m.key === missionKey);
    const pois = LM.getPOIs(tableKey, missionKey);
    const counts = {};
    for (const key of LM.TERRAIN_ORDER) counts[key] = 0;
    let seq = 0;
    for (const p of terrain) {
      counts[p.category] = (counts[p.category] || 0) + 1;
      if (!p.id) p.id = `s${++seq}`;
    }
    const plan = LM.planCounts(LM.resolveSuggestedCounts(tableKey), counts);
    const unplaced = {};
    for (const key of LM.TERRAIN_ORDER) unplaced[key] = 0;
    const area = LM.coverageArea(counts);
    return {
      table,
      mission,
      pois,
      terrain,
      plan,
      usedCounts: counts,
      unplaced,
      coveragePct: (area / (table.length * table.depth)) * 100,
    };
  };

  // Renders off-screen at a fixed large size rather than scaling the visible canvas, so the
  // export is sharp regardless of window size or device pixel ratio.
  LM.exportPNG = function (layout, mode, themeKey, opts) {
    opts = opts || {};
    const width = opts.width || 2400;
    const height = opts.height || (mode === "top" ? Math.round(width * 0.54) : Math.round(width * 0.46));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    LM.renderLayout(canvas, layout, mode, themeKey, {
      width,
      height,
      dpr: 1,
      background: opts.background || "#14161c",
      exposure: opts.exposure,
      // Crop tighter than the on-screen view — an exported image shouldn't be mostly margin.
      fitW: 0.94,
      fitH: 0.82,
      fitTop: 0.95,
      originYFrac: 0.16,
    });

    const name = `legion-${layout.mission.key}-${layout.table.key}.png`;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke on the next tick — revoking synchronously can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };
})();
