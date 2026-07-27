var LM = window.LM || (window.LM = {});

(function () {
  // Two view modes share every draw call below — only the projector differs:
  //  - 'iso': 2:1 isometric skew, height (z) lifts things up the screen.
  //  - 'top': straight overhead — z is ignored entirely, which collapses each box's side
  //    faces to zero area for free (top and bottom project to the same point), leaving a
  //    flat rotated-rectangle "blueprint" outline with no extra branching needed.
  function makeProjector(mode, scale, originX, originY) {
    if (mode === "top") {
      return (x, y) => ({ x: originX + x * scale, y: originY + y * scale });
    }
    const halfW = scale;
    const halfH = scale * 0.5;
    const zScale = scale * 0.75;
    return (x, y, z = 0) => ({
      x: originX + (x - y) * halfW,
      y: originY + (x + y) * halfH - z * zScale,
    });
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return `rgb(${r},${g},${b})`;
  }

  // Deterministic per-piece pseudo-random sequence (seeded from world position) so a
  // piece's procedural scatter shape stays stable across re-renders/resizes and only
  // changes when the layout is actually regenerated.
  function makeRng(seed) {
    let s = seed;
    return function () {
      s = Math.sin(s * 12.9898) * 43758.5453;
      s -= Math.floor(s);
      return s;
    };
  }

  function poly(ctx, pts, fill) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function rotatePts(localPts, cx, cy, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return localPts.map(([dx, dy]) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }));
  }

  // Extrudes an arbitrary convex polygon (given as local, unrotated [x,y] pairs) from z0
  // to z1. Which side faces are camera-facing depends on rotation, so they're picked by
  // outward-normal sign each call rather than assumed — a fixed pair looks hollow/open
  // once shapes can sit at arbitrary angles. Generalized (not just rectangles) so the same
  // code draws boxes, ice shards, rock lumps, and plant blades alike.
  function drawExtruded(ctx, project, localPts, cx, cy, angleDeg, z0, z1, baseColor) {
    const corners = rotatePts(localPts, cx, cy, angleDeg);
    const n = corners.length;
    const topPts = corners.map((c) => project(c.x, c.y, z1));
    const botPts = corners.map((c) => project(c.x, c.y, z0));

    const edges = [];
    for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n]);
    const visible = edges
      .map(([i, j]) => {
        const midx = (corners[i].x + corners[j].x) / 2 - cx;
        const midy = (corners[i].y + corners[j].y) / 2 - cy;
        return { i, j, facing: midx + midy };
      })
      .filter((e) => e.facing > 0)
      .sort((a, b) => b.facing - a.facing);

    const chosen = visible.length ? visible : edges.map(([i, j]) => ({ i, j }));
    chosen.forEach((e, idx) => {
      poly(ctx, [topPts[e.i], topPts[e.j], botPts[e.j], botPts[e.i]], shade(baseColor, -45 - idx * 18));
    });
    poly(ctx, topPts, shade(baseColor, 25));
    return topPts;
  }

  function drawBlock(ctx, project, cx, cy, w, d, angleDeg, z0, z1, baseColor) {
    const hx = w / 2, hy = d / 2;
    return drawExtruded(ctx, project, [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]], cx, cy, angleDeg, z0, z1, baseColor);
  }

  // A rough gem/shard silhouette — pointed top, irregular base — for ice chunks and rocks.
  function drawShard(ctx, project, cx, cy, w, d, angleDeg, z0, z1, baseColor) {
    const pts = [[0, -d], [w * 0.5, -d * 0.1], [w * 0.32, d * 0.55], [-w * 0.32, d * 0.55], [-w * 0.5, -d * 0.1]];
    return drawExtruded(ctx, project, pts, cx, cy, angleDeg, z0, z1, baseColor);
  }

  // A thin tapered blade — grass/fern/frond.
  function drawBlade(ctx, project, cx, cy, len, w, angleDeg, z0, z1, baseColor) {
    const pts = [[0, -len * 0.5], [w * 0.5, 0], [w * 0.22, len * 0.5], [-w * 0.22, len * 0.5], [-w * 0.5, 0]];
    return drawExtruded(ctx, project, pts, cx, cy, angleDeg, z0, z1, baseColor);
  }

  // An 8-point rounded footprint — reads as a hut/dome/tower base instead of a boxy corner.
  function octagonPts(hw, hd) {
    const k = 0.42;
    return [
      [-hw * (1 - k), -hd], [hw * (1 - k), -hd],
      [hw, -hd * (1 - k)], [hw, hd * (1 - k)],
      [hw * (1 - k), hd], [-hw * (1 - k), hd],
      [-hw, hd * (1 - k)], [-hw, -hd * (1 - k)],
    ];
  }

  // Stacked, tapering octagon tiers from z0 upward — a beehive/stepped-dome/tower silhouette.
  // Returns the z-height where the stack topped out, so callers can cap it with a finial etc.
  function drawTaper(ctx, project, cx, cy, w, d, angleDeg, z0, totalH, tiers, taper, color) {
    let curW = w, curD = d, z = z0;
    const tierH = totalH / tiers;
    for (let t = 0; t < tiers; t++) {
      drawExtruded(ctx, project, octagonPts(curW / 2, curD / 2), cx, cy, angleDeg, z, z + tierH, color);
      z += tierH;
      curW *= taper;
      curD *= taper;
    }
    return { topZ: z, topW: curW, topD: curD };
  }

  // Trunk + tapering canopy — reads as a tree once the canopy is wide and green.
  function drawTreeShape(ctx, project, cx, cy, w, d, h, angleDeg, trunkColor, canopyColor) {
    const trunkH = h * 0.5;
    drawTaper(ctx, project, cx, cy, w * 0.32, d * 0.32, angleDeg, 0, trunkH, 1, 1, trunkColor);
    drawTaper(ctx, project, cx, cy, w * 1.05, d * 1.05, angleDeg + 18, trunkH, h - trunkH, 2, 0.7, canopyColor);
  }

  // Thin tapering trunk with a wider "capital" ring near the top — a broken column / tower.
  function drawColumnShape(ctx, project, cx, cy, w, d, h, angleDeg, color, capColor) {
    drawTaper(ctx, project, cx, cy, w * 0.34, d * 0.34, angleDeg, 0, h * 0.82, 1, 1, color);
    drawTaper(ctx, project, cx, cy, w * 0.55, d * 0.55, angleDeg, h * 0.78, h * 0.22, 1, 0.85, capColor || color);
  }

  // Deterministically picks a themed building "kit" per piece (seeded by position, same
  // trick as scatter) so a table shows a believable mix rather than one repeated shape.
  const BUILDING_VARIANTS = {
    tatooine: ["hut", "tower", "mesa"],
    endor: ["tree", "bunker"],
    hoth: ["iceberg", "icespire"],
    naboo: ["dome", "column"],
  };

  function drawBuildingVariant(ctx, project, piece, cat, theme) {
    const variants = BUILDING_VARIANTS[theme.key] || ["iceberg"];
    const rng = makeRng(piece.x * 13.7 + piece.y * 77.31 + cat.width);
    const variant = variants[Math.floor(rng() * variants.length)];
    const { width: w, depth: d, height: h } = cat;
    const angle = piece.rotation;
    const cx = piece.x, cy = piece.y;
    const color = (theme.colors && theme.colors[piece.category]) || "#8a8a8a";
    const accent = (theme.scatter && theme.scatter.accent) || shade(color, -30);

    switch (variant) {
      case "hut":
        drawTaper(ctx, project, cx, cy, w, d, angle, 0, h, 3, 0.72, color);
        break;
      case "tower": {
        const trunk = drawTaper(ctx, project, cx, cy, w * 0.4, d * 0.4, angle, 0, h * 0.75, 1, 1, color);
        drawTaper(ctx, project, cx, cy, trunk.topW * 1.7, trunk.topD * 1.7, angle, trunk.topZ, h * 0.25, 1, 1, accent);
        break;
      }
      case "mesa":
        drawShard(ctx, project, cx, cy, w * 1.1, d * 1.1, angle, 0, h, color);
        break;
      case "tree":
        drawTreeShape(ctx, project, cx, cy, w, d, h, angle, shade(color, -20), accent);
        break;
      case "bunker": {
        const baseTop = h * 0.62;
        drawBlock(ctx, project, cx, cy, w * 1.1, d * 1.1, angle, 0, baseTop, color);
        drawBlock(ctx, project, cx, cy, w * 0.8, d * 0.8, angle, baseTop, h, shade(color, -12));
        break;
      }
      case "icespire":
        drawShard(ctx, project, cx, cy, w * 1.05, d * 1.05, angle, 0, h * 1.15, color);
        break;
      case "dome": {
        const dome = drawTaper(ctx, project, cx, cy, w, d, angle, 0, h * 0.85, 3, 0.7, color);
        drawBlock(ctx, project, cx, cy, dome.topW * 0.5, dome.topD * 0.5, angle, dome.topZ, h, accent);
        break;
      }
      case "column":
        drawColumnShape(ctx, project, cx, cy, w, d, h, angle, color, accent);
        break;
      default: {
        const baseTop = h * (theme.building ? theme.building.topFrac : 0.55);
        const insetFrac = theme.building ? theme.building.insetFrac : 0.62;
        drawBlock(ctx, project, cx, cy, w, d, angle, 0, baseTop, color);
        drawBlock(ctx, project, cx, cy, w * insetFrac, d * insetFrac, angle, baseTop, h, color);
      }
    }
    return boundingQuad(cx, cy, w, d, angle, project);
  }

  function drawShadow(ctx, project, cx, cy, w, d) {
    const p = project(cx, cy, 0.02);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(1, 0.5);
    ctx.beginPath();
    ctx.ellipse(0, 0, (w + d) * 0.4, (w + d) * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fill();
    ctx.restore();
  }

  function boundingQuad(cx, cy, w, d, angleDeg, project) {
    const hx = w / 2, hy = d / 2;
    return rotatePts([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]], cx, cy, angleDeg).map((c) => project(c.x, c.y, 0.4));
  }

  // Themed scatter terrain — a handful of small clustered shapes rather than one plain
  // box, so it actually reads as ice/rock/log/plant debris for the chosen planet.
  function drawScatterCluster(ctx, project, piece, theme) {
    const cat = LM.TERRAIN_CATEGORIES.scatter;
    const rng = makeRng(piece.x * 17.13 + piece.y * 91.71 + 4.7);
    const cx = piece.x, cy = piece.y;
    const envW = cat.width, envD = cat.depth;
    const scatterTheme = theme.scatter || { base: "#c2a25a", accent: "#a98a49", variant: "desert" };
    const base = scatterTheme.base, accent = scatterTheme.accent;

    drawShadow(ctx, project, cx, cy, envW * 2, envD * 2);

    switch (scatterTheme.variant) {
      case "ice": {
        const n = 2 + Math.floor(rng() * 2);
        for (let i = 0; i < n; i++) {
          const ang = rng() * 360;
          const off = (rng() - 0.5) * envD * 1.6;
          const ox = Math.cos((ang * Math.PI) / 180) * off, oy = Math.sin((ang * Math.PI) / 180) * off;
          const w = envW * (1.1 + rng() * 1.1), d = envD * (0.8 + rng() * 0.8);
          drawShard(ctx, project, cx + ox, cy + oy, w, d, ang, 0, cat.height * (0.7 + rng() * 0.9), i === 0 ? base : accent);
        }
        break;
      }
      case "forest": {
        const logAngle = rng() * 360;
        drawBlock(ctx, project, cx, cy, envW * 4.5, envD * 1.1, logAngle, 0, cat.height * 0.45, base);
        if (rng() > 0.35) {
          const perp = (logAngle + 90) * (Math.PI / 180);
          const sx = cx + Math.cos(perp) * envD * 1.8, sy = cy + Math.sin(perp) * envD * 1.8;
          drawBlock(ctx, project, sx, sy, envW * 1.4, envD * 1.4, rng() * 360, 0, cat.height * (0.9 + rng() * 0.6), accent);
        }
        break;
      }
      case "plant": {
        const n = 3 + Math.floor(rng() * 2);
        for (let i = 0; i < n; i++) {
          const ang = (360 / n) * i + rng() * 24;
          const rad = (ang * Math.PI) / 180;
          const bladeLen = envD * (2.2 + rng() * 1.2);
          const bx = cx + Math.cos(rad) * bladeLen * 0.22, by = cy + Math.sin(rad) * bladeLen * 0.22;
          drawBlade(ctx, project, bx, by, bladeLen, envW * 1.4, ang, 0, cat.height * (0.8 + rng() * 0.9), i % 2 === 0 ? accent : base);
        }
        break;
      }
      case "ruins": {
        // City-plaza debris: a chunk of broken marble, plus (usually) a planter box with
        // an ornamental tuft — Theed's courtyards, not wild plains.
        const rubbleAngle = rng() * 360;
        drawShard(ctx, project, cx, cy, envW * 1.3, envD * 1.1, rubbleAngle, 0, cat.height * (0.45 + rng() * 0.4), base);
        if (rng() > 0.3) {
          const rad = rubbleAngle * (Math.PI / 180) + 1.3;
          const px = cx + Math.cos(rad) * envD * 1.7, py = cy + Math.sin(rad) * envD * 1.7;
          const potAngle = rng() * 360;
          drawBlock(ctx, project, px, py, envW * 0.9, envD * 0.9, potAngle, 0, cat.height * 0.55, base);
          drawBlade(ctx, project, px, py, envD * 1.5, envW * 0.7, potAngle, cat.height * 0.55, cat.height * 1.0, accent);
        }
        break;
      }
      default: {
        // desert — a couple of rock lumps, occasionally a thin vaporator-like pole
        const n = 2 + Math.floor(rng() * 2);
        for (let i = 0; i < n; i++) {
          const ang = rng() * 360;
          const off = (rng() - 0.5) * envD * 1.6;
          const ox = Math.cos((ang * Math.PI) / 180) * off, oy = Math.sin((ang * Math.PI) / 180) * off;
          const w = envW * (1.2 + rng() * 1.1), d = envD * (0.9 + rng() * 0.7);
          drawShard(ctx, project, cx + ox, cy + oy, w, d, ang, 0, cat.height * (0.5 + rng() * 0.6), i === 0 ? base : accent);
        }
        if (rng() > 0.72) {
          drawBlock(ctx, project, cx, cy, envW * 0.6, envD * 0.6, rng() * 360, 0, cat.height * 2.4, accent);
        }
      }
    }

    return boundingQuad(cx, cy, envW * 2.4, envD * 2.4, piece.rotation, project);
  }

  function drawTerrainPiece(ctx, project, piece, theme) {
    if (piece.category === "scatter") return drawScatterCluster(ctx, project, piece, theme);

    const cat = LM.TERRAIN_CATEGORIES[piece.category];
    drawShadow(ctx, project, piece.x, piece.y, cat.width, cat.depth);

    if (piece.category === "barricade") {
      const color = (theme.colors && theme.colors.barricade) || "#8a8a8a";
      return drawBlock(ctx, project, piece.x, piece.y, cat.width, cat.depth, piece.rotation, 0, cat.height, color);
    }
    // Large/Medium/Small all draw from the same themed building kit — a real mix of
    // hut/tower/mesa (Tatooine), tree/bunker (Endor), etc. instead of one repeated shape.
    return drawBuildingVariant(ctx, project, piece, cat, theme);
  }

  function drawPOI(ctx, project, x, y, isCenter) {
    const p = project(x, y, 0.05);
    const rPx = isCenter ? 10 : 8;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rPx, rPx * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(200,40,30,0.85)";
    ctx.fill();
    ctx.strokeStyle = "#3a0a05";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rPx * 0.35, rPx * 0.18, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd9a0";
    ctx.fill();
    return { x: p.x, y: p.y, rPx };
  }

  // Ray-casting point-in-polygon test, used for hover hit-testing on-screen.
  function pointInPoly(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  LM.pointInPoly = pointInPoly;

  // Renders the layout and returns a hit-test list (front-most first) so the caller can
  // resolve hover/mouseover without redoing any projection math.
  LM.renderLayout = function (canvas, layout, mode, themeKey) {
    mode = mode === "top" ? "top" : "iso";
    const theme = LM.THEMES[themeKey] || LM.THEMES[LM.DEFAULT_THEME];
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const { table, pois, terrain } = layout;
    let scale, originX, originY;
    if (mode === "top") {
      scale = Math.min((rect.width * 0.86) / table.length, (rect.height * 0.86) / table.depth);
      originX = rect.width / 2 - (table.length * scale) / 2;
      originY = rect.height / 2 - (table.depth * scale) / 2;
    } else {
      scale = Math.min(
        (rect.width * 0.82) / (table.length + table.depth),
        (rect.height * 0.62) / ((table.length + table.depth) * 0.5)
      );
      originX = rect.width / 2;
      originY = rect.height * 0.22;
    }
    const project = makeProjector(mode, scale, originX, originY);

    // Floor
    const floorPts = [
      project(0, 0, 0), project(table.length, 0, 0),
      project(table.length, table.depth, 0), project(0, table.depth, 0),
    ];
    ctx.beginPath();
    ctx.moveTo(floorPts[0].x, floorPts[0].y);
    floorPts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = theme.floor;
    ctx.fill();

    // Territory tints
    const T = table.territoryFrac * table.depth;
    const tint = (y0, y1, color) => {
      const pts = [project(0, y0, 0.01), project(table.length, y0, 0.01), project(table.length, y1, 0.01), project(0, y1, 0.01)];
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    tint(0, T, "rgba(70,120,210,0.16)");
    tint(table.depth - T, table.depth, "rgba(210,60,50,0.14)");

    // Territory (deployment zone) boundary lines — Player Territory is where a mission's
    // rules let you Deploy; Contested Territory is the no-man's-land between them.
    const zoneBoundary = (y, color) => {
      const a = project(0, y, 0.015), b = project(table.length, y, 0.015);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    };
    zoneBoundary(T, "rgba(70,120,210,0.6)");
    zoneBoundary(table.depth - T, "rgba(210,60,50,0.6)");

    ctx.font = "11px 'Segoe UI', sans-serif";
    const zoneLabel = (y, text, color) => {
      const p = project(table.length * 0.22, y, 0.015);
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = color;
      ctx.fillText(text, p.x, p.y);
      ctx.restore();
    };
    zoneLabel(T * 0.5, "BLUE TERRITORY", "rgba(120,160,230,0.85)");
    zoneLabel(table.depth / 2, "CONTESTED", "rgba(200,200,210,0.75)");
    zoneLabel(table.depth - T * 0.5, "RED TERRITORY", "rgba(230,120,110,0.85)");

    // Grid lines every 6"
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= table.length + 0.01; gx += 6) {
      const a = project(gx, 0, 0.01), b = project(gx, table.depth, 0.01);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let gy = 0; gy <= table.depth + 0.01; gy += 6) {
      const a = project(0, gy, 0.01), b = project(table.length, gy, 0.01);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Draw order: back-to-front by (x+y) so nearer pieces occlude further ones correctly.
    const drawables = [
      ...pois.map((p) => ({ type: "poi", depth: p.x + p.y, data: p })),
      ...terrain.map((t) => ({ type: "terrain", depth: t.x + t.y, data: t })),
    ].sort((a, b) => a.depth - b.depth);

    const hitRegions = [];
    for (const d of drawables) {
      if (d.type === "poi") {
        const hit = drawPOI(ctx, project, d.data.x, d.data.y, d.data.isCenter);
        hitRegions.push({ type: "poi", data: d.data, x: hit.x, y: hit.y, r: hit.rPx * 1.4 });
      } else {
        const topPts = drawTerrainPiece(ctx, project, d.data, theme);
        hitRegions.push({ type: "terrain", data: d.data, pts: topPts });
      }
    }

    // Border
    ctx.beginPath();
    ctx.moveTo(floorPts[0].x, floorPts[0].y);
    floorPts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.strokeStyle = "rgba(20,20,25,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Edge labels — y=0 is the Blue player's edge, y=depth is Red's (see data.js pattern comment)
    ctx.font = "12px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(70,120,210,0.9)";
    const blueLbl = project(table.length / 2, -1.5, 0);
    ctx.fillText("BLUE", blueLbl.x, blueLbl.y);
    ctx.fillStyle = "rgba(210,60,50,0.9)";
    const redLbl = project(table.length / 2, table.depth + 3, 0);
    ctx.fillText("RED", redLbl.x, redLbl.y);

    // Front-most first, so hover resolves to whatever visually occludes the rest.
    return hitRegions.reverse();
  };
})();
