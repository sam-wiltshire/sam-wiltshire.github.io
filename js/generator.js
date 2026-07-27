var LM = window.LM || (window.LM = {});

(function () {
  const EDGE_MARGIN = 1.5; // inches kept clear from the absolute table edge
  const CENTER_POI_CLEARANCE = 5; // extra clearance around a POI at dead-center
  const POI_CLEARANCE = 3; // clearance around any other POI (POI token is 2" + buffer)
  const PIECE_GAP = 0.5; // minimum air gap between two terrain pieces
  const LARGE_SPACING = 6; // "beyond Range 1" (a 6" Range Tool segment), Large/Medium only
  const MAX_TRIES_PER_PIECE = 2000;
  const RELAX_STEPS = [1, 0.7, 0.4, 0.15];

  // Circumscribed-circle radius — only used for the conservative table-edge bound and for
  // POI clearance (POIs are round tokens, so a circle check there is exact enough).
  function footprintRadius(catKey) {
    const cat = LM.TERRAIN_CATEGORIES[catKey];
    return 0.5 * Math.hypot(cat.width, cat.depth);
  }

  function dist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  // --- Oriented-rectangle overlap (Separating Axis Theorem) ------------------------------
  // Terrain sits at a free angle now, so two pieces can legitimately nest close together as
  // long as their actual (rotated) rectangles don't overlap — a padded-circle check was far
  // too conservative once a dozen+ pieces were already on the table.
  function rectCorners(cx, cy, w, d, angleDeg) {
    const hx = w / 2, hy = d / 2;
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return [
      [-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy],
    ].map(([dx, dy]) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }));
  }

  function rectAxes(angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return [{ x: Math.cos(rad), y: Math.sin(rad) }, { x: -Math.sin(rad), y: Math.cos(rad) }];
  }

  function projectOntoAxis(pts, axis) {
    let min = Infinity, max = -Infinity;
    for (const p of pts) {
      const d = p.x * axis.x + p.y * axis.y;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return [min, max];
  }

  // True if the two rectangles are separated by at least `gap` along some axis.
  function rectsClear(rectA, rectB, gap) {
    const cornersA = rectCorners(rectA.x, rectA.y, rectA.w, rectA.d, rectA.angle);
    const cornersB = rectCorners(rectB.x, rectB.y, rectB.w, rectB.d, rectB.angle);
    const axes = [...rectAxes(rectA.angle), ...rectAxes(rectB.angle)];
    for (const axis of axes) {
      const [minA, maxA] = projectOntoAxis(cornersA, axis);
      const [minB, maxB] = projectOntoAxis(cornersB, axis);
      if (minB - maxA >= gap || minA - maxB >= gap) return true;
    }
    return false;
  }

  // Clamp requested inventory against the recommended count for the table: use everything
  // you have up to the recommendation, flag both shortfalls and unused surplus.
  LM.planCounts = function (tableKey, inventory) {
    const suggested = LM.TABLES[tableKey].suggested;
    const plan = {};
    for (const key of LM.TERRAIN_ORDER) {
      const have = Math.max(0, Math.floor(inventory[key] || 0));
      const rec = suggested[key];
      plan[key] = {
        suggested: rec,
        available: have,
        used: Math.min(have, rec),
        shortfall: Math.max(0, rec - have),
        surplus: Math.max(0, have - rec),
      };
    }
    return plan;
  };

  LM.getPOIs = function (tableKey, missionKey) {
    const table = LM.TABLES[tableKey];
    const mission = LM.MISSIONS[tableKey].find((m) => m.key === missionKey);
    return mission.pattern.map((p, i) => ({
      x: p.fx * table.length,
      y: p.fy * table.depth,
      label: `${mission.poiLabel} ${i + 1}`,
      isCenter: Math.abs(p.fx - 0.5) < 0.01 && Math.abs(p.fy - 0.5) < 0.01,
    }));
  };

  function poiClearanceFor(poi) {
    return poi.isCenter ? CENTER_POI_CLEARANCE : POI_CLEARANCE;
  }

  // `relax` shrinks clearances progressively (1 = full community-guideline spacing,
  // smaller = pack tighter) so small boards or big collections still fit everything;
  // we always try the fair/spaced-out arrangement first and only tighten if it won't fit.
  function violates(candidate, catKey, placed, pois, table, relax) {
    const r = footprintRadius(catKey);
    const edge = EDGE_MARGIN * relax;
    if (candidate.x - r < edge || candidate.x + r > table.length - edge) return true;
    if (candidate.y - r < edge || candidate.y + r > table.depth - edge) return true;

    for (const poi of pois) {
      if (dist(candidate.x, candidate.y, poi.x, poi.y) < r + poiClearanceFor(poi) * relax) return true;
    }
    const cat = LM.TERRAIN_CATEGORIES[catKey];
    const rectA = { x: candidate.x, y: candidate.y, w: cat.width, d: cat.depth, angle: candidate.rotation };
    for (const p of placed) {
      const otherCat = LM.TERRAIN_CATEGORIES[p.category];
      const rectB = { x: p.x, y: p.y, w: otherCat.width, d: otherCat.depth, angle: p.rotation };
      let gap = PIECE_GAP * relax;
      const bothBig = (catKey === "large" || catKey === "medium") && (p.category === "large" || p.category === "medium");
      if (bothBig) gap = Math.max(gap, LARGE_SPACING * relax);
      if (!rectsClear(rectA, rectB, gap)) return true;
    }
    return false;
  }

  // Places a piece freely within a given depth band (no mirroring, no angle-snapping) —
  // fairness comes from balancing how many pieces of a category land in each half
  // (see halfSequence below), not from making every piece a literal mirror image.
  function placePiece(catKey, yMin, yMax, placed, pois, table) {
    for (const relax of RELAX_STEPS) {
      for (let i = 0; i < MAX_TRIES_PER_PIECE; i++) {
        const r = footprintRadius(catKey);
        const edge = EDGE_MARGIN * relax;
        const x = edge + r + Math.random() * (table.length - 2 * (edge + r));
        const loY = Math.max(edge + r, yMin);
        const hiY = Math.min(table.depth - edge - r, yMax);
        if (hiY <= loY) continue;
        const y = loY + Math.random() * (hiY - loY);
        const rotation = Math.random() * 360;
        const candidate = { x, y, rotation };
        if (violates(candidate, catKey, placed, pois, table, relax)) continue;
        return { category: catKey, x, y, rotation };
      }
    }
    return null; // couldn't fit even at minimum spacing — board is full
  }

  // Alternates which half of the table (Blue-side vs Red-side) each new piece of a
  // category is assigned to, so the count balances out roughly evenly without forcing
  // mirrored positions.
  function halfSequence(count) {
    const seq = [];
    let flip = Math.random() < 0.5;
    for (let i = 0; i < count; i++) {
      seq.push(flip);
      flip = !flip;
    }
    return seq;
  }

  LM.generateLayout = function ({ tableKey, missionKey, inventory }) {
    const table = LM.TABLES[tableKey];
    const mission = LM.MISSIONS[tableKey].find((m) => m.key === missionKey);
    const pois = LM.getPOIs(tableKey, missionKey);
    const plan = LM.planCounts(tableKey, inventory);

    // Place biggest pieces first so they get the most room to breathe.
    const order = ["large", "medium", "small", "scatter", "barricade"];
    const placed = [];
    const unplaced = {};

    for (const catKey of order) {
      const toPlace = plan[catKey].used;
      unplaced[catKey] = 0;
      const halves = halfSequence(toPlace);
      for (const useAwayHalf of halves) {
        const yMin = useAwayHalf ? table.depth / 2 : 0;
        const yMax = useAwayHalf ? table.depth : table.depth / 2;
        const piece = placePiece(catKey, yMin, yMax, placed, pois, table);
        if (piece) placed.push(piece);
        else unplaced[catKey] += 1;
      }
    }

    const usedCounts = {};
    for (const key of LM.TERRAIN_ORDER) usedCounts[key] = plan[key].used - unplaced[key];

    const area = LM.coverageArea(usedCounts);
    const coveragePct = (area / (table.length * table.depth)) * 100;

    return {
      table,
      mission,
      pois,
      terrain: placed,
      plan,
      usedCounts,
      unplaced,
      coveragePct,
    };
  };
})();
