var LM = window.LM || (window.LM = {});

(function () {
  const EDGE_MARGIN = 1.5; // inches kept clear from the absolute table edge
  const CENTER_POI_CLEARANCE = 5; // extra clearance around a POI at dead-center
  const POI_CLEARANCE = 3; // clearance around any other POI (POI token is 2" + buffer)
  const PIECE_GAP = 0.5; // minimum air gap between two terrain pieces
  const STRUCTURAL_SPACING = 3; // non-filler pieces stay at least 3" apart from each other
  const LARGE_SPACING = 6; // ...6" if either piece involved is Medium or Large
  const FILLER = { scatter: true, barricade: true }; // exempt from the above — dressing, not structure
  const MAX_TRIES_PER_PIECE = 2000;
  const RELAX_STEPS = [1, 0.7, 0.4, 0.15];

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

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
      // Filler (Scatter/Barricade) is exempt — Barricades specifically need to be able to
      // sit flush against a Large/Medium anchor, not stay 6" clear of it.
      if (!FILLER[catKey] && !FILLER[p.category]) {
        const eitherBig = catKey === "large" || catKey === "medium" || p.category === "large" || p.category === "medium";
        gap = Math.max(gap, (eitherBig ? LARGE_SPACING : STRUCTURAL_SPACING) * relax);
      }
      if (!rectsClear(rectA, rectB, gap)) return true;
    }
    return false;
  }

  // Places a piece freely within a given rectangular region (no mirroring, no angle-
  // snapping). Region bounds get clamped inward by the piece's own edge margin.
  function placePiece(catKey, region, placed, pois, table) {
    for (const relax of RELAX_STEPS) {
      for (let i = 0; i < MAX_TRIES_PER_PIECE; i++) {
        const r = footprintRadius(catKey);
        const edge = EDGE_MARGIN * relax;
        const loX = Math.max(edge + r, region.xMin), hiX = Math.min(table.length - edge - r, region.xMax);
        const loY = Math.max(edge + r, region.yMin), hiY = Math.min(table.depth - edge - r, region.yMax);
        if (hiX <= loX || hiY <= loY) continue;
        const x = loX + Math.random() * (hiX - loX);
        const y = loY + Math.random() * (hiY - loY);
        const rotation = Math.random() * 360;
        const candidate = { x, y, rotation };
        if (violates(candidate, catKey, placed, pois, table, relax)) continue;
        return { category: catKey, x, y, rotation };
      }
    }
    return null; // couldn't fit even at minimum spacing — board is full
  }

  // Splits the table into a grid of zones (columns x the two Blue/Red halves) and hands
  // out one shuffled zone per piece. This is what actually creates "lanes" — real tables
  // group LOS-blockers into distinct clusters with gaps between them rather than
  // scattering them uniformly at random, which tends to either wall off the board or
  // leave no coherent open path across it.
  function zoneRegions(count, table) {
    if (count === 0) return [];
    const cols = Math.max(1, Math.min(count, 4));
    const colW = table.length / cols;
    const regions = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const away = Math.floor(i / cols) % 2 === 1;
      regions.push({
        xMin: col * colW,
        xMax: (col + 1) * colW,
        yMin: away ? table.depth / 2 : 0,
        yMax: away ? table.depth : table.depth / 2,
      });
    }
    return shuffle(regions);
  }

  const fullRegion = (table) => ({ xMin: 0, xMax: table.length, yMin: 0, yMax: table.depth });

  // Tries to seat a Barricade flush against one side of an already-placed Large/Medium
  // piece, rotated to run along that edge — "extending the wall" rather than floating in
  // open ground. Falls back to null so the caller can place it independently instead.
  function placeBarricadeAgainstAnchor(placed, pois, table) {
    const bcat = LM.TERRAIN_CATEGORIES.barricade;
    const anchors = shuffle(placed.filter((p) => p.category === "large" || p.category === "medium").slice());
    for (const anchor of anchors) {
      const acat = LM.TERRAIN_CATEGORIES[anchor.category];
      for (const side of shuffle([0, 1, 2, 3])) {
        const alongLocalX = side === 1 || side === 3; // which local axis this edge runs along
        const halfExtent = alongLocalX ? acat.depth / 2 : acat.width / 2;
        const edgeLen = alongLocalX ? acat.width : acat.depth;
        const rotation = anchor.rotation + (alongLocalX ? 0 : 90);
        for (const relax of [1, 0.6]) {
          for (let attempt = 0; attempt < 25; attempt++) {
            const along = (Math.random() - 0.5) * edgeLen * 0.7;
            const outDist = halfExtent + bcat.depth / 2 + PIECE_GAP * relax;
            let lx, ly;
            if (side === 0) { lx = outDist; ly = along; }
            else if (side === 1) { lx = along; ly = outDist; }
            else if (side === 2) { lx = -outDist; ly = along; }
            else { lx = along; ly = -outDist; }
            const rad = (anchor.rotation * Math.PI) / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const x = anchor.x + lx * cos - ly * sin;
            const y = anchor.y + lx * sin + ly * cos;
            const candidate = { x, y, rotation };
            if (violates(candidate, "barricade", placed, pois, table, relax)) continue;
            return { category: "barricade", x, y, rotation };
          }
        }
      }
    }
    return null;
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

      if (catKey === "barricade") {
        for (let i = 0; i < toPlace; i++) {
          const piece = placeBarricadeAgainstAnchor(placed, pois, table) || placePiece(catKey, fullRegion(table), placed, pois, table);
          if (piece) placed.push(piece);
          else unplaced[catKey] += 1;
        }
        continue;
      }

      // Large/Medium/Small are the structural "kit" pieces — zone them so clusters form
      // with real gaps between. Scatter is deliberately left fully free: the community
      // convention is that it dresses whatever lane space is left, not the other way round.
      const regions = catKey === "scatter" ? Array.from({ length: toPlace }, () => fullRegion(table)) : zoneRegions(toPlace, table);
      for (const region of regions) {
        const piece = placePiece(catKey, region, placed, pois, table);
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
