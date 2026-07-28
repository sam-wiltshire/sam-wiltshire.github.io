var LM = window.LM || (window.LM = {});

// Line-of-sight analysis. The whole premise of this tool is producing a *fair* table, and
// coverage percentage alone can't tell you that — a board can hit 20% coverage and still
// have a clear firing lane straight down its length, or a corner nobody can ever shoot
// into. This computes what's actually visible from where.
(function () {
  // Only terrain flagged blocksLOS stops sight. Per the Core Rulebook, scatter and
  // barricades are shoot-over cover, not LOS blockers, so they're deliberately excluded.
  function blockerPolys(terrain) {
    const out = [];
    for (const p of terrain) {
      const cat = LM.TERRAIN_CATEGORIES[p.category];
      if (!cat || !cat.blocksLOS) continue;
      const pts = LM.pieceCorners(p);
      // Bounding circle for a cheap reject before the 4 edge tests.
      const r = 0.5 * Math.hypot(cat.width, cat.depth);
      out.push({ pts, cx: p.x, cy: p.y, r });
    }
    return out;
  }

  function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1x = bx - ax, d1y = by - ay;
    const d2x = dx - cx, d2y = dy - cy;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-9) return false; // parallel
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }

  // Perpendicular distance from a blocker's centre to the sight line, used with the
  // bounding radius to skip blockers nowhere near the ray.
  function farFromSegment(ax, ay, bx, by, b) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((b.cx - ax) * dx + (b.cy - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    return Math.hypot(b.cx - px, b.cy - py) > b.r;
  }

  function blocked(ax, ay, bx, by, blockers) {
    for (const b of blockers) {
      if (farFromSegment(ax, ay, bx, by, b)) continue;
      const pts = b.pts;
      for (let i = 0; i < 4; i++) {
        const p = pts[i], q = pts[(i + 1) % 4];
        if (segsCross(ax, ay, bx, by, p.x, p.y, q.x, q.y)) return true;
      }
    }
    return false;
  }

  function pointInside(px, py, blockers) {
    for (const b of blockers) {
      if (Math.hypot(px - b.cx, py - b.cy) > b.r) continue;
      const pts = b.pts;
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  // Observers are spread across the mission's actual deployment zones — "where enemy guns
  // will be on turn one". Using the real Territory shape matters: a mission with an offset
  // or L-shaped zone produces genuinely different sight lines than a plain band would.
  function observerPoints(layout, perSide) {
    const t = LM.getTerritories(layout.table.key, layout.mission.key);
    const pts = [];
    const sample = (rects, side) => {
      const total = rects.reduce((s, r) => s + (r.x1 - r.x0), 0) || 1;
      for (const r of rects) {
        const n = Math.max(1, Math.round(perSide * ((r.x1 - r.x0) / total)));
        // Stand at the zone's forward edge — the side facing the enemy.
        const y = side === "blue" ? r.y1 - 1 : r.y0 + 1;
        for (let i = 0; i < n; i++) {
          pts.push({ x: r.x0 + ((i + 0.5) / n) * (r.x1 - r.x0), y, side });
        }
      }
    };
    sample(t.blue, "blue");
    sample(t.red, "red");
    return pts;
  }

  // Returns a grid of exposure values in [0,1]: the fraction of observer positions that
  // can draw line of sight to each cell. 1 = open ground covered from every angle,
  // 0 = fully screened. Cells inside a blocker are marked -1 (terrain, not walkable).
  LM.computeExposure = function (layout, opts) {
    opts = opts || {};
    const cellSize = opts.cellSize || 2;
    const table = layout.table;
    const blockers = blockerPolys(layout.terrain);
    const observers = observerPoints(layout, opts.observersPerSide || 8);

    const cols = Math.ceil(table.length / cellSize);
    const rows = Math.ceil(table.depth / cellSize);
    const values = new Float32Array(cols * rows);

    let exposedSum = 0, exposedCount = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) * cellSize;
        const y = (r + 0.5) * cellSize;
        if (pointInside(x, y, blockers)) {
          values[r * cols + c] = -1;
          continue;
        }
        let seen = 0;
        for (const o of observers) {
          if (!blocked(o.x, o.y, x, y, blockers)) seen++;
        }
        const v = seen / observers.length;
        values[r * cols + c] = v;
        exposedSum += v;
        exposedCount++;
      }
    }

    // Longest clear shot between opposing deployment zones — the number that tells you
    // whether a sniper can see clean across the board.
    // How much of the deployment-to-deployment firing web is unobstructed. This — not the
    // raw longest distance — is the meaningful "is the board too open" signal: on a 72x36
    // table a corner-to-corner diagonal is naturally ~80", so distance alone always looks
    // alarming even on a well-screened board.
    let longestLane = 0, clearPairs = 0, totalPairs = 0;
    for (const a of observers) {
      if (a.side !== "blue") continue;
      for (const b of observers) {
        if (b.side !== "red") continue;
        totalPairs++;
        if (blocked(a.x, a.y, b.x, b.y, blockers)) continue;
        clearPairs++;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (dist > longestLane) longestLane = dist;
      }
    }

    return {
      cols,
      rows,
      cellSize,
      values,
      stats: {
        avgExposure: exposedCount ? exposedSum / exposedCount : 0,
        // Share of open ground that's screened from most angles — usable cover to advance through.
        coveredFrac: exposedCount ? countBelow(values, 0.35) / exposedCount : 0,
        longestLane,
        clearLaneFrac: totalPairs ? clearPairs / totalPairs : 0,
        blockerCount: blockers.length,
      },
    };
  };

  function countBelow(values, threshold) {
    let n = 0;
    for (let i = 0; i < values.length; i++) if (values[i] >= 0 && values[i] < threshold) n++;
    return n;
  }

  // --- Table symmetry ---------------------------------------------------------------------
  // How closely the table maps onto itself under a 180 degree rotation about its centre.
  // That's the symmetry that matters in Legion: it's what makes both players face the same
  // terrain from their own edge, and it's the same transform the Map Cards use to derive Red's
  // Territory from Blue's. (A mirror across the centre line would swap one player's left and
  // right flanks, which is a different — and less fair — thing.)
  //
  // Pieces are paired off greedily, closest match first, so each piece is counted exactly
  // once. A piece may pair with ITSELF: a piece sitting on the centre of rotation genuinely is
  // symmetric. Each pair scores on how far its partner sits from the ideal rotated position,
  // with a modest penalty for being turned differently, and pairs are weighted by footprint
  // area — a mismatched Large building matters far more than a 1" x 2" crate.
  const SYM_TOLERANCE = 12; // inches of offset at which a pair scores nothing (range 2)
  const SYM_ANGLE_PENALTY = 3; // inches added for a partner turned a full 90 deg out

  function rotatedImage(piece, table) {
    return {
      x: table.length - piece.x,
      y: table.depth - piece.y,
      rotation: piece.rotation + 180,
    };
  }

  // Rectangles look the same at 180 deg, so only the difference modulo 180 counts, folded
  // into 0..90 (a piece 170 deg out of true is really only 10 deg out).
  function angleOffset(a, b) {
    let d = Math.abs((((a - b) % 180) + 180) % 180);
    return d > 90 ? 180 - d : d;
  }

  function pairCost(p, q, table) {
    const img = rotatedImage(p, table);
    const gap = Math.hypot(q.x - img.x, q.y - img.y);
    return gap + (angleOffset(q.rotation, img.rotation) / 90) * SYM_ANGLE_PENALTY;
  }

  LM.computeSymmetry = function (layout) {
    const table = layout.table;
    const pieces = layout.terrain || [];
    const areaOf = (p) => {
      const cat = LM.TERRAIN_CATEGORIES[p.category];
      return cat.width * cat.depth;
    };

    // Every legal pairing, cheapest first. n is at most ~45, so the n^2 pass is trivial.
    const cands = [];
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i; j < pieces.length; j++) {
        if (pieces[i].category !== pieces[j].category) continue;
        cands.push({ i, j, cost: pairCost(pieces[i], pieces[j], table) });
      }
    }
    cands.sort((a, b) => a.cost - b.cost);

    const taken = new Array(pieces.length).fill(false);
    const pairs = [];
    for (const c of cands) {
      if (taken[c.i] || taken[c.j]) continue;
      taken[c.i] = true;
      taken[c.j] = true;
      const score = Math.max(0, 1 - c.cost / SYM_TOLERANCE);
      pairs.push({
        a: pieces[c.i],
        b: pieces[c.j],
        self: c.i === c.j,
        offset: c.cost,
        score,
        weight: areaOf(pieces[c.i]) * (c.i === c.j ? 1 : 2),
      });
    }

    let weighted = 0, totalWeight = 0;
    for (const p of pairs) {
      weighted += p.score * p.weight;
      totalWeight += p.weight;
    }

    // Footprint area either side of the centre line — the blunt "does one player have more
    // terrain than the other" check, which a symmetric table passes by definition.
    let blueArea = 0, redArea = 0;
    for (const p of pieces) {
      if (p.y < table.depth / 2) blueArea += areaOf(p);
      else redArea += areaOf(p);
    }
    const halfTotal = blueArea + redArea;

    const worst = pairs
      .filter((p) => !p.self)
      .sort((a, b) => b.weight * (1 - b.score) - a.weight * (1 - a.score))[0] || null;

    return {
      score: totalWeight ? weighted / totalWeight : 1,
      pairs,
      worst,
      halves: {
        blue: blueArea,
        red: redArea,
        skew: halfTotal ? Math.abs(blueArea - redArea) / halfTotal : 0,
        heavier: blueArea === redArea ? null : blueArea > redArea ? "Blue" : "Red",
      },
    };
  };
})();
