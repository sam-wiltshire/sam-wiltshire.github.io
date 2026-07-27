var LM = window.LM || (window.LM = {});

(function () {
  // Per-render context. Rendering is fully synchronous, so a module-level object is safe
  // here and saves threading these through every draw call. Set at the top of renderLayout.
  //   mode      — 'iso' | 'top'
  //   pxPerInch — on-screen scale, used for level-of-detail decisions
  const RC = { mode: "iso", pxPerInch: 8 };

  // Detail thresholds: below these on-screen sizes, fine detail is visual noise (and wasted
  // draw calls), so it's skipped entirely rather than rendered as unreadable specks.
  const LOD_FACE_DETAIL = 3.2; // px per inch needed before windows/seams are drawn
  const LOD_FINE_DETAIL = 5.5; // px per inch needed for the smallest touches

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

  // Screen -> world on the ground plane (z = 0). Needed for dragging pieces and for the
  // range-measuring tool. Inverting the iso transform:
  //   sx = ox + (x - y) * halfW      =>  (x - y) = (sx - ox) / halfW
  //   sy = oy + (x + y) * halfH      =>  (x + y) = (sy - oy) / halfH
  function makeUnprojector(mode, scale, originX, originY) {
    if (mode === "top") {
      return (sx, sy) => ({ x: (sx - originX) / scale, y: (sy - originY) / scale });
    }
    const halfW = scale;
    const halfH = scale * 0.5;
    return (sx, sy) => {
      const a = (sx - originX) / halfW;
      const b = (sy - originY) / halfH;
      return { x: (a + b) / 2, y: (b - a) / 2 };
    };
  }

  // Expects a "#rrggbb" hex color. Shading an already-shaded rgb(...) string (instead of
  // the original hex) silently produces near-black — parseInt fails, NaN coerces to 0 in
  // the bit shifts, and every channel collapses toward `amt`. Guard against that instead of
  // reproducing the bug a third time: fall back to the input unchanged if it's not hex.
  function shade(hex, amt) {
    if (typeof hex !== "string" || hex[0] !== "#") return hex;
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return `rgb(${r},${g},${b})`;
  }

  // Deterministic pseudo-random sequence (seeded from world position) so a piece's
  // procedural detail stays stable across re-renders/resizes and only changes when the
  // layout is actually regenerated.
  function makeRng(seed) {
    let s = seed;
    return function () {
      s = Math.sin(s * 12.9898) * 43758.5453;
      s -= Math.floor(s);
      return s;
    };
  }

  function poly(ctx, pts, fill, strokeAlpha) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (strokeAlpha !== 0) {
      ctx.strokeStyle = `rgba(0,0,0,${strokeAlpha == null ? 0.25 : strokeAlpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function fillOnly(ctx, pts, fill) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function rotatePts(localPts, cx, cy, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return localPts.map(([dx, dy]) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }));
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

  function centroidOf(pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  }

  // Shrinks a convex polygon toward its centroid — used for roof parapets/rims.
  function insetPoly(pts, frac) {
    const c = centroidOf(pts);
    return pts.map((p) => ({ x: c.x + (p.x - c.x) * frac, y: c.y + (p.y - c.y) * frac }));
  }

  // --- Face-local coordinates ------------------------------------------------------------
  // A face quad is [topA, topB, botB, botA]. Isometric projection is affine (parallel, no
  // perspective foreshortening), so bilinear interpolation across the quad is EXACT, not an
  // approximation — that's what lets windows/doors sit correctly on angled walls.
  function faceAt(face, u, v) {
    const [tA, tB, bB, bA] = face.quad;
    const topX = tA.x + (tB.x - tA.x) * u, topY = tA.y + (tB.y - tA.y) * u;
    const botX = bA.x + (bB.x - bA.x) * u, botY = bA.y + (bB.y - bA.y) * u;
    return { x: topX + (botX - topX) * v, y: topY + (botY - topY) * v };
  }

  function faceRect(face, u0, v0, u1, v1) {
    return [faceAt(face, u0, v0), faceAt(face, u1, v0), faceAt(face, u1, v1), faceAt(face, u0, v1)];
  }

  // Arched opening: straight jambs up to a springline, then a semicircular head.
  function faceArch(face, u0, u1, vTop, vBottom, segments) {
    const uMid = (u0 + u1) / 2;
    const uRad = (u1 - u0) / 2;
    const vSpring = vTop + (u1 - u0) * 0.5 * face.aspect; // keep the arch roughly circular
    const pts = [faceAt(face, u0, vBottom), faceAt(face, u0, Math.min(vSpring, vBottom))];
    const n = segments || 8;
    for (let i = 0; i <= n; i++) {
      const ang = Math.PI - (Math.PI * i) / n;
      const u = uMid + Math.cos(ang) * uRad;
      const v = Math.min(vSpring, vBottom) - Math.abs(Math.sin(ang)) * (Math.min(vSpring, vBottom) - vTop);
      pts.push(faceAt(face, u, v));
    }
    pts.push(faceAt(face, u1, vBottom));
    return pts;
  }

  function faceOnScreenWidth(face) {
    const [tA, tB] = face.quad;
    return Math.hypot(tB.x - tA.x, tB.y - tA.y);
  }

  // --- Extrusion -------------------------------------------------------------------------
  // Extrudes an arbitrary convex polygon (given as local, unrotated [x,y] pairs) from z0
  // to z1. Which side faces are camera-facing depends on rotation, so they're picked by
  // outward-normal sign each call rather than assumed — a fixed pair looks hollow/open
  // once shapes can sit at arbitrary angles. Generalized (not just rectangles) so the same
  // code draws boxes, ice shards, rock lumps, and plant blades alike.
  //
  // Returns { topPts, faces } where each face carries enough info (world width/height,
  // its own shade offset) for the detail pass to draw on it.
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
    const faces = [];
    const worldH = z1 - z0;
    chosen.forEach((e, idx) => {
      const quad = [topPts[e.i], topPts[e.j], botPts[e.j], botPts[e.i]];
      const shadeAmt = -45 - idx * 18;
      poly(ctx, quad, shade(baseColor, shadeAmt));
      const worldW = Math.hypot(corners[e.j].x - corners[e.i].x, corners[e.j].y - corners[e.i].y);
      faces.push({
        quad,
        worldW,
        worldH,
        aspect: worldH > 0 ? worldW / worldH : 1,
        shadeAmt,
        baseColor,
        primary: idx === 0,
      });
    });
    poly(ctx, topPts, shade(baseColor, 25));
    return { topPts, faces, botPts };
  }

  // --- Surface detail ---------------------------------------------------------------------

  // Darker plinth along the bottom of a wall — cheap, and does a lot to make a block read
  // as a built structure rather than a solid lump.
  function drawBase(ctx, face, heightFrac) {
    const h = heightFrac == null ? 0.14 : heightFrac;
    fillOnly(ctx, faceRect(face, 0, 1 - h, 1, 1), shade(face.baseColor, face.shadeAmt - 22));
  }

  // Horizontal band (string course / roofline trim).
  function drawBand(ctx, face, vCenter, thicknessFrac, delta) {
    const half = (thicknessFrac || 0.06) / 2;
    fillOnly(ctx, faceRect(face, 0, vCenter - half, 1, vCenter + half), shade(face.baseColor, face.shadeAmt + (delta == null ? 16 : delta)));
  }

  // Grid of windows sized in world inches, so a bigger wall simply gets more of them
  // rather than the same count stretched larger.
  function drawWindowGrid(ctx, face, rng, opts) {
    opts = opts || {};
    const winW = opts.winW || 0.75;
    const winH = opts.winH || 0.85;
    const gapX = opts.gapX || 0.9;
    const gapY = opts.gapY || 1.0;
    const cols = Math.floor((face.worldW + gapX) / (winW + gapX));
    const rows = Math.floor((face.worldH * (opts.vExtent || 0.72) + gapY) / (winH + gapY));
    if (cols < 1 || rows < 1) return;

    const usedW = cols * winW + (cols - 1) * gapX;
    const startX = (face.worldW - usedW) / 2;
    const usedH = rows * winH + (rows - 1) * gapY;
    const topInset = face.worldH * (opts.vTop == null ? 0.13 : opts.vTop);
    const dark = shade(face.baseColor, face.shadeAmt - 55);
    const lit = opts.litColor || "#f0c073";
    const litChance = opts.litChance == null ? 0 : opts.litChance;

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const x0 = startX + c * (winW + gapX);
        const y0 = topInset + r * (winH + gapY);
        if (y0 + winH > face.worldH) continue;
        const u0 = x0 / face.worldW, u1 = (x0 + winW) / face.worldW;
        const v0 = y0 / face.worldH, v1 = (y0 + winH) / face.worldH;
        const color = rng() < litChance ? lit : dark;
        if (opts.arched) fillOnly(ctx, faceArch(face, u0, u1, v0, v1, 6), color);
        else fillOnly(ctx, faceRect(face, u0, v0, u1, v1), color);
      }
    }
  }

  // Single wide, short opening — bunker firing slit / hangar vent.
  function drawSlit(ctx, face, vCenter, opts) {
    opts = opts || {};
    const halfH = (opts.heightFrac || 0.1) / 2;
    const inset = opts.inset == null ? 0.18 : opts.inset;
    fillOnly(ctx, faceRect(face, inset, vCenter - halfH, 1 - inset, vCenter + halfH), shade(face.baseColor, face.shadeAmt - 60));
  }

  function drawDoor(ctx, face, rng, opts) {
    opts = opts || {};
    const doorW = Math.min(opts.width || 1.6, face.worldW * 0.5);
    const doorH = Math.min(opts.height || 2.4, face.worldH * 0.62);
    if (face.worldW < doorW * 1.4) return;
    const uHalf = doorW / face.worldW / 2;
    const uMid = 0.5 + (rng() - 0.5) * 0.18;
    const v1 = 1 - (opts.sillFrac == null ? 0.02 : opts.sillFrac);
    const v0 = v1 - doorH / face.worldH;
    const color = shade(face.baseColor, face.shadeAmt - 70);
    if (opts.arched) fillOnly(ctx, faceArch(face, uMid - uHalf, uMid + uHalf, v0, v1, 8), color);
    else fillOnly(ctx, faceRect(face, uMid - uHalf, v0, uMid + uHalf, v1), color);
  }

  // Vertical panel seams / pilasters / fluting, spaced in world inches.
  function drawVerticalSeams(ctx, face, spacingIn, alpha) {
    const count = Math.floor(face.worldW / (spacingIn || 1.6));
    if (count < 1) return;
    ctx.save();
    ctx.strokeStyle = `rgba(0,0,0,${alpha == null ? 0.16 : alpha})`;
    ctx.lineWidth = 1;
    for (let i = 1; i <= count; i++) {
      const u = i / (count + 1);
      const a = faceAt(face, u, 0.06), b = faceAt(face, u, 0.96);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  // Wavering horizontal lines — rock strata / sedimentary layers on natural terrain.
  function drawStrata(ctx, face, rng, count) {
    const n = count || 3;
    ctx.save();
    ctx.strokeStyle = `rgba(0,0,0,0.14)`;
    ctx.lineWidth = 1;
    for (let i = 1; i <= n; i++) {
      const v = i / (n + 1) + (rng() - 0.5) * 0.08;
      const segs = 4;
      ctx.beginPath();
      for (let s = 0; s <= segs; s++) {
        const p = faceAt(face, s / segs, Math.min(0.95, Math.max(0.05, v + (rng() - 0.5) * 0.05)));
        if (s === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Bright angular highlight — catches the eye on ice/crystal facets.
  function drawFacet(ctx, face, rng) {
    const u0 = 0.1 + rng() * 0.2;
    const pts = [faceAt(face, u0, 0.08), faceAt(face, u0 + 0.28, 0.02), faceAt(face, u0 + 0.16, 0.92), faceAt(face, u0 - 0.02, 0.8)];
    fillOnly(ctx, pts, `rgba(255,255,255,0.22)`);
  }

  // Irregular darker blotches — moss on bunkers, leaf clumps on canopies.
  function drawBlotches(ctx, pts, rng, count, color) {
    const c = centroidOf(pts);
    for (let i = 0; i < count; i++) {
      const t = rng();
      const idx = Math.floor(rng() * pts.length);
      const target = pts[idx];
      const bx = c.x + (target.x - c.x) * (0.25 + t * 0.6);
      const by = c.y + (target.y - c.y) * (0.25 + t * 0.6);
      const r = 1.5 + rng() * 2.5;
      ctx.beginPath();
      ctx.ellipse(bx, by, r, r * 0.55, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  // Roof dressing: a parapet rim plus optional hatch/vents. Drawn in BOTH view modes —
  // it's the main thing carrying detail in bird's-eye, where side faces collapse away.
  function drawRoofDetail(ctx, topPts, baseColor, rng, opts) {
    opts = opts || {};
    if (RC.pxPerInch < LOD_FACE_DETAIL) return;
    const rim = insetPoly(topPts, opts.rimFrac || 0.8);
    fillOnly(ctx, rim, shade(baseColor, 12));
    if (opts.innerRim) fillOnly(ctx, insetPoly(topPts, (opts.rimFrac || 0.8) * 0.62), shade(baseColor, 4));

    if (RC.pxPerInch < LOD_FINE_DETAIL) return;
    const c = centroidOf(rim);
    if (opts.hatch) {
      const h = insetPoly(rim, 0.32);
      const off = { x: (rim[0].x - c.x) * 0.3, y: (rim[0].y - c.y) * 0.3 };
      fillOnly(ctx, h.map((p) => ({ x: p.x + off.x, y: p.y + off.y })), shade(baseColor, -48));
    }
    if (opts.vents) {
      for (let i = 0; i < opts.vents; i++) {
        const target = rim[Math.floor(rng() * rim.length)];
        const vx = c.x + (target.x - c.x) * 0.55, vy = c.y + (target.y - c.y) * 0.55;
        const s = 1.6 + rng() * 1.4;
        fillOnly(ctx, [
          { x: vx - s, y: vy }, { x: vx, y: vy - s * 0.5 }, { x: vx + s, y: vy }, { x: vx, y: vy + s * 0.5 },
        ], shade(baseColor, -34));
      }
    }
  }

  // --- Shape primitives -------------------------------------------------------------------

  function drawBlock(ctx, project, cx, cy, w, d, angleDeg, z0, z1, baseColor) {
    const hx = w / 2, hy = d / 2;
    return drawExtruded(ctx, project, [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]], cx, cy, angleDeg, z0, z1, baseColor);
  }

  // A rough gem/shard silhouette — pointed at one end, irregular at the other — for ice
  // chunks and rocks. Every point stays inside the declared w x d footprint; an earlier
  // version let the nose run to -d (1.55x the depth overall), so pieces drew far larger
  // than the rectangle the collision pass had reserved for them.
  function drawShard(ctx, project, cx, cy, w, d, angleDeg, z0, z1, baseColor) {
    const hw = w / 2, hd = d / 2;
    const pts = [[0, -hd], [hw, -hd * 0.3], [hw * 0.64, hd], [-hw * 0.64, hd], [-hw, -hd * 0.3]];
    return drawExtruded(ctx, project, pts, cx, cy, angleDeg, z0, z1, baseColor);
  }

  // A thin tapered blade — grass/fern/frond.
  function drawBlade(ctx, project, cx, cy, len, w, angleDeg, z0, z1, baseColor) {
    const pts = [[0, -len * 0.5], [w * 0.5, 0], [w * 0.22, len * 0.5], [-w * 0.22, len * 0.5], [-w * 0.5, 0]];
    return drawExtruded(ctx, project, pts, cx, cy, angleDeg, z0, z1, baseColor);
  }

  // Stacked, tapering octagon tiers from z0 upward — a beehive/stepped-dome/tower silhouette.
  function drawTaper(ctx, project, cx, cy, w, d, angleDeg, z0, totalH, tiers, taper, color) {
    let curW = w, curD = d, z = z0;
    const tierH = totalH / tiers;
    const built = [];
    for (let t = 0; t < tiers; t++) {
      built.push(drawExtruded(ctx, project, octagonPts(curW / 2, curD / 2), cx, cy, angleDeg, z, z + tierH, color));
      z += tierH;
      curW *= taper;
      curD *= taper;
    }
    return { topZ: z, topW: curW, topD: curD, tiers: built, first: built[0], last: built[built.length - 1] };
  }

  function drawTreeShape(ctx, project, cx, cy, w, d, h, angleDeg, trunkColor, canopyColor, rng) {
    // Trees run taller than the category's boxed height and narrower than its footprint.
    // Height is purely cosmetic (collision is the 2D footprint only), and a canopy scaled
    // to a 9x11x5 box would be far wider than tall — a green plateau, not a tree.
    const H = h * 1.7;
    const trunkH = H * 0.5;
    const trunk = drawTaper(ctx, project, cx, cy, w * 0.26, d * 0.26, angleDeg, 0, trunkH, 1, 1, trunkColor);
    const canopy = drawTaper(ctx, project, cx, cy, w * 0.82, d * 0.82, angleDeg + 18, trunkH, H - trunkH, 3, 0.66, canopyColor);
    if (RC.mode === "iso" && RC.pxPerInch >= LOD_FACE_DETAIL) {
      for (const f of trunk.first.faces) drawVerticalSeams(ctx, f, 0.8, 0.2); // bark
    }
    if (RC.pxPerInch >= LOD_FACE_DETAIL) {
      // Leaf clumps read on the canopy's top surface in both views.
      drawBlotches(ctx, canopy.last.topPts, rng, 5, shade(canopyColor, -26));
      drawBlotches(ctx, canopy.last.topPts, rng, 3, shade(canopyColor, 22));
    }
    return canopy;
  }

  // Fluted pillar with a wider capital — a standing/broken column from a colonnade.
  // Runs taller than the boxed height for the same reason trees do (height is cosmetic).
  function drawColumnShape(ctx, project, cx, cy, w, d, h, angleDeg, color, rng) {
    const H = h * 1.5;
    drawTaper(ctx, project, cx, cy, w * 0.46, d * 0.46, angleDeg, 0, H * 0.08, 1, 1, shade(color, -14)); // plinth
    const shaft = drawTaper(ctx, project, cx, cy, w * 0.3, d * 0.3, angleDeg, H * 0.08, H * 0.78, 1, 0.94, color);
    const cap = drawTaper(ctx, project, cx, cy, w * 0.42, d * 0.42, angleDeg, H * 0.86, H * 0.14, 1, 0.88, shade(color, 14));
    if (RC.mode === "iso" && RC.pxPerInch >= LOD_FINE_DETAIL) {
      for (const f of shaft.first.faces) drawVerticalSeams(ctx, f, 0.45, 0.22); // fluting
    }
    return cap;
  }

  // --- Themed building kits ----------------------------------------------------------------
  // Deterministically picks a themed building "kit" per piece (seeded by position, same
  // trick as scatter) so a table shows a believable mix rather than one repeated shape.
  const BUILDING_VARIANTS = {
    tatooine: ["hut", "tower", "mesa"],
    endor: ["tree", "bunker"],
    // Natural ice formations mixed with prefab base structures — Hoth tables are usually
    // both, not one or the other.
    hoth: ["iceberg", "icespire", "outpost"],
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
    const detail = RC.pxPerInch >= LOD_FACE_DETAIL;
    const sideDetail = detail && RC.mode === "iso";

    switch (variant) {
      case "hut": {
        const hut = drawTaper(ctx, project, cx, cy, w, d, angle, 0, h, 3, 0.72, color);
        if (sideDetail) {
          hut.first.faces.forEach((f, i) => {
            drawBase(ctx, f, 0.12);
            if (i === 0) drawDoor(ctx, f, rng, { arched: true, width: 1.5, height: 2.2 });
            else drawWindowGrid(ctx, f, rng, { winW: 0.6, winH: 0.6, gapX: 1.1, gapY: 1.1, vExtent: 0.5, litChance: 0.25 });
          });
          hut.tiers.slice(1).forEach((t) => t.faces.forEach((f) => drawBand(ctx, f, 0.14, 0.09, 14)));
        }
        drawRoofDetail(ctx, hut.last.topPts, color, rng, { rimFrac: 0.72, innerRim: true });
        break;
      }
      case "tower": {
        const trunk = drawTaper(ctx, project, cx, cy, w * 0.4, d * 0.4, angle, 0, h * 0.75, 1, 1, color);
        const capTier = drawTaper(ctx, project, cx, cy, trunk.topW * 1.7, trunk.topD * 1.7, angle, trunk.topZ, h * 0.25, 1, 1, accent);
        if (sideDetail) {
          trunk.first.faces.forEach((f) => {
            drawBase(ctx, f, 0.1);
            drawVerticalSeams(ctx, f, 1.1, 0.18);
            drawBand(ctx, f, 0.34, 0.05, -14);
            drawWindowGrid(ctx, f, rng, { winW: 0.5, winH: 0.7, gapX: 1.2, gapY: 1.4, vExtent: 0.55, vTop: 0.42, litChance: 0.3 });
          });
          capTier.first.faces.forEach((f) => drawSlit(ctx, f, 0.5, { heightFrac: 0.34, inset: 0.1 }));
        }
        drawRoofDetail(ctx, capTier.last.topPts, accent, rng, { rimFrac: 0.68, vents: 2 });
        break;
      }
      case "mesa": {
        // A butte: broad base stepping inward to a flat top, banded with rock strata —
        // reads as a weathered outcrop rather than a slab dropped on the sand.
        const mesa = drawTaper(ctx, project, cx, cy, w, d, angle, 0, h, 2, 0.82, color);
        if (sideDetail) mesa.tiers.forEach((t) => t.faces.forEach((f) => drawStrata(ctx, f, rng, 3)));
        if (detail) {
          drawBlotches(ctx, mesa.last.topPts, rng, 3, shade(color, -18));
          // A couple of fallen boulders at the foot of the outcrop.
          for (let i = 0; i < 2; i++) {
            const a = rng() * Math.PI * 2;
            const bx = cx + Math.cos(a) * w * 0.5, by = cy + Math.sin(a) * d * 0.5;
            drawShard(ctx, project, bx, by, w * 0.22, d * 0.18, rng() * 360, 0, h * 0.16, shade(color, -8));
          }
        }
        break;
      }
      case "tree":
        drawTreeShape(ctx, project, cx, cy, w, d, h, angle, color, accent, rng);
        break;
      case "bunker": {
        const baseTop = h * 0.62;
        const body = drawBlock(ctx, project, cx, cy, w * 1.1, d * 1.1, angle, 0, baseTop, color);
        const cap = drawBlock(ctx, project, cx, cy, w * 0.8, d * 0.8, angle, baseTop, h, color);
        if (sideDetail) {
          body.faces.forEach((f, i) => {
            drawBase(ctx, f, 0.18);
            drawSlit(ctx, f, 0.42, { heightFrac: 0.13, inset: 0.16 });
            if (i === 0) drawDoor(ctx, f, rng, { width: 1.5, height: 1.8 });
          });
          cap.faces.forEach((f) => drawSlit(ctx, f, 0.45, { heightFrac: 0.16, inset: 0.22 }));
        }
        drawRoofDetail(ctx, cap.topPts, color, rng, { rimFrac: 0.82, hatch: true, vents: 1 });
        if (detail) drawBlotches(ctx, body.topPts, rng, 3, shade(accent, -10)); // moss
        break;
      }
      case "icespire": {
        // Tall and narrow — a spire should tower, and extra height costs nothing since
        // collision only ever uses the 2D footprint.
        const spire = drawShard(ctx, project, cx, cy, w * 0.72, d * 0.72, angle, 0, h * 2.1, color);
        if (sideDetail) spire.faces.forEach((f, i) => { if (i === 0) drawFacet(ctx, f, rng); drawVerticalSeams(ctx, f, 1.8, 0.1); });
        // Smaller shards clustered at its foot.
        if (detail) {
          for (let i = 0; i < 2; i++) {
            const a = rng() * Math.PI * 2;
            drawShard(ctx, project, cx + Math.cos(a) * w * 0.42, cy + Math.sin(a) * d * 0.42, w * 0.3, d * 0.24, rng() * 360, 0, h * 0.5, shade(color, 8));
          }
        }
        break;
      }
      case "iceberg": {
        // A chunky, low, faceted mass of pack ice.
        const berg = drawTaper(ctx, project, cx, cy, w, d, angle, 0, h * 0.9, 2, 0.74, color);
        if (sideDetail) {
          berg.tiers.forEach((t) => t.faces.forEach((f, i) => { if (i === 0) drawFacet(ctx, f, rng); }));
        }
        if (detail) drawBlotches(ctx, berg.last.topPts, rng, 4, "rgba(255,255,255,0.35)");
        break;
      }
      case "outpost": {
        // Prefab base structure — snow-capped roof, lit viewports, blast door.
        const baseTop = h * 0.6;
        const body = drawBlock(ctx, project, cx, cy, w, d, angle, 0, baseTop, shade(color, -18));
        const cap = drawBlock(ctx, project, cx, cy, w * 0.78, d * 0.78, angle, baseTop, h, color);
        if (sideDetail) {
          body.faces.forEach((f, i) => {
            drawBase(ctx, f, 0.16);
            if (i === 0) drawDoor(ctx, f, rng, { width: 2.0, height: 2.2 });
            drawWindowGrid(ctx, f, rng, { winW: 0.7, winH: 0.5, gapX: 1.0, gapY: 1.2, vExtent: 0.45, litChance: 0.4 });
          });
          cap.faces.forEach((f) => drawSlit(ctx, f, 0.45, { heightFrac: 0.2, inset: 0.18 }));
        }
        drawRoofDetail(ctx, cap.topPts, "#ffffff", rng, { rimFrac: 0.86, hatch: true, vents: 2 });
        break;
      }
      case "dome": {
        const dome = drawTaper(ctx, project, cx, cy, w, d, angle, 0, h * 0.85, 3, 0.7, color);
        // Verdigris copper cupola on top of the marble — Theed's signature green domes.
        const finial = drawTaper(ctx, project, cx, cy, dome.topW * 0.78, dome.topD * 0.78, angle, dome.topZ, h * 0.42, 2, 0.6, accent);
        if (sideDetail) {
          dome.first.faces.forEach((f, i) => {
            drawBase(ctx, f, 0.12);
            drawVerticalSeams(ctx, f, 1.3, 0.14); // ribs
            if (i === 0) drawDoor(ctx, f, rng, { arched: true, width: 1.7, height: 2.4 });
            else drawWindowGrid(ctx, f, rng, { winW: 0.6, winH: 1.0, gapX: 1.0, gapY: 1.0, vExtent: 0.55, arched: true, litChance: 0.35 });
          });
          dome.tiers.slice(1).forEach((t) => t.faces.forEach((f) => drawBand(ctx, f, 0.12, 0.08, 18)));
        }
        drawRoofDetail(ctx, finial.last.topPts, accent, rng, { rimFrac: 0.7 });
        break;
      }
      case "column":
        drawColumnShape(ctx, project, cx, cy, w, d, h, angle, color, rng);
        break;
      default: {
        const b = theme.building || { insetFrac: 0.62, topFrac: 0.55 };
        const baseTop = h * b.topFrac;
        const body = drawBlock(ctx, project, cx, cy, w, d, angle, 0, baseTop, color);
        const cap = drawBlock(ctx, project, cx, cy, w * b.insetFrac, d * b.insetFrac, angle, baseTop, h, color);
        if (sideDetail) body.faces.forEach((f) => { drawBase(ctx, f, 0.14); drawWindowGrid(ctx, f, rng, { litChance: 0.2 }); });
        drawRoofDetail(ctx, cap.topPts, color, rng, { rimFrac: 0.8, vents: 1 });
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
    const fine = RC.pxPerInch >= LOD_FINE_DETAIL && RC.mode === "iso";

    // Scatter is the smallest category (real footprint ~1"x2") — the cluster as a whole
    // should read as clearly smaller than Small (2"x4"), not rival or exceed it.
    drawShadow(ctx, project, cx, cy, envW * 1.1, envD * 1.1);

    switch (scatterTheme.variant) {
      case "ice": {
        const n = 2 + Math.floor(rng() * 2);
        for (let i = 0; i < n; i++) {
          const ang = rng() * 360;
          const off = (rng() - 0.5) * envD * 0.8;
          const ox = Math.cos((ang * Math.PI) / 180) * off, oy = Math.sin((ang * Math.PI) / 180) * off;
          const w = envW * (0.55 + rng() * 0.55), d = envD * (0.4 + rng() * 0.4);
          const s = drawShard(ctx, project, cx + ox, cy + oy, w, d, ang, 0, cat.height * (0.7 + rng() * 0.9), i === 0 ? base : accent);
          if (fine && i === 0) drawFacet(ctx, s.faces[0], rng);
        }
        break;
      }
      case "forest": {
        const logAngle = rng() * 360;
        const log = drawBlock(ctx, project, cx, cy, envW * 2.3, envD * 0.55, logAngle, 0, cat.height * 0.45, base);
        if (fine) log.faces.forEach((f) => drawVerticalSeams(ctx, f, 0.35, 0.18)); // bark
        if (rng() > 0.35) {
          const perp = (logAngle + 90) * (Math.PI / 180);
          const sx = cx + Math.cos(perp) * envD * 0.9, sy = cy + Math.sin(perp) * envD * 0.9;
          const stump = drawBlock(ctx, project, sx, sy, envW * 0.7, envD * 0.7, rng() * 360, 0, cat.height * (0.9 + rng() * 0.6), accent);
          if (fine) fillOnly(ctx, insetPoly(stump.topPts, 0.55), shade(accent, -30)); // rings
        }
        break;
      }
      case "plant": {
        const n = 3 + Math.floor(rng() * 2);
        for (let i = 0; i < n; i++) {
          const ang = (360 / n) * i + rng() * 24;
          const rad = (ang * Math.PI) / 180;
          const bladeLen = envD * (1.1 + rng() * 0.6);
          const bx = cx + Math.cos(rad) * bladeLen * 0.22, by = cy + Math.sin(rad) * bladeLen * 0.22;
          drawBlade(ctx, project, bx, by, bladeLen, envW * 0.7, ang, 0, cat.height * (0.8 + rng() * 0.9), i % 2 === 0 ? accent : base);
        }
        break;
      }
      case "ruins": {
        // City-plaza debris: a chunk of broken marble, plus (usually) a planter box with
        // an ornamental tuft — Theed's courtyards, not wild plains.
        const rubbleAngle = rng() * 360;
        const rubble = drawShard(ctx, project, cx, cy, envW * 0.65, envD * 0.55, rubbleAngle, 0, cat.height * (0.45 + rng() * 0.4), base);
        if (fine) rubble.faces.forEach((f) => drawStrata(ctx, f, rng, 1));
        if (rng() > 0.3) {
          const rad = rubbleAngle * (Math.PI / 180) + 1.3;
          const px = cx + Math.cos(rad) * envD * 0.85, py = cy + Math.sin(rad) * envD * 0.85;
          const potAngle = rng() * 360;
          drawBlock(ctx, project, px, py, envW * 0.45, envD * 0.45, potAngle, 0, cat.height * 0.55, base);
          drawBlade(ctx, project, px, py, envD * 0.75, envW * 0.35, potAngle, cat.height * 0.55, cat.height * 1.0, accent);
        }
        break;
      }
      default: {
        // desert — a couple of rock lumps, occasionally a thin vaporator-like pole
        const n = 2 + Math.floor(rng() * 2);
        for (let i = 0; i < n; i++) {
          const ang = rng() * 360;
          const off = (rng() - 0.5) * envD * 0.8;
          const ox = Math.cos((ang * Math.PI) / 180) * off, oy = Math.sin((ang * Math.PI) / 180) * off;
          const w = envW * (0.6 + rng() * 0.55), d = envD * (0.45 + rng() * 0.35);
          const rock = drawShard(ctx, project, cx + ox, cy + oy, w, d, ang, 0, cat.height * (0.5 + rng() * 0.6), i === 0 ? base : accent);
          if (fine && i === 0) drawStrata(ctx, rock.faces[0], rng, 1);
        }
        if (rng() > 0.72) {
          const pole = drawBlock(ctx, project, cx, cy, envW * 0.3, envD * 0.3, rng() * 360, 0, cat.height * 2.4, accent);
          if (fine) fillOnly(ctx, insetPoly(pole.topPts, 1.5), shade(accent, -20)); // vaporator head
        }
      }
    }

    return boundingQuad(cx, cy, envW * 1.3, envD * 1.3, piece.rotation, project);
  }

  function drawTerrainPiece(ctx, project, piece, theme) {
    if (piece.category === "scatter") return drawScatterCluster(ctx, project, piece, theme);

    const cat = LM.TERRAIN_CATEGORIES[piece.category];
    drawShadow(ctx, project, piece.x, piece.y, cat.width, cat.depth);

    if (piece.category === "barricade") {
      const color = (theme.colors && theme.colors.barricade) || "#8a8a8a";
      const bar = drawBlock(ctx, project, piece.x, piece.y, cat.width, cat.depth, piece.rotation, 0, cat.height, color);
      if (RC.mode === "iso" && RC.pxPerInch >= LOD_FINE_DETAIL) {
        // Segment lines make a barricade read as panelled plating rather than a plain bar.
        bar.faces.forEach((f) => drawVerticalSeams(ctx, f, 0.9, 0.22));
      }
      return bar.topPts;
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

  // --- Ground surface -----------------------------------------------------------------------
  // Sampled in WORLD space then projected, so textures sit correctly on the mat in either
  // view mode without separate iso/top code paths.
  function worldRing(project, cx, cy, rx, ry, segments) {
    const pts = [];
    const n = segments || 18;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n;
      pts.push(project(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 0.01));
    }
    return pts;
  }

  function drawGroundTexture(ctx, project, table, theme) {
    if (RC.pxPerInch < 2.5) return;
    // Fixed seed: the mat's own texture must not reshuffle on resize or a terrain reroll.
    const rng = makeRng(97.31);
    const L = table.length, D = table.depth;

    ctx.save();
    const fp = [project(0, 0, 0), project(L, 0, 0), project(L, D, 0), project(0, D, 0)];
    ctx.beginPath();
    ctx.moveTo(fp[0].x, fp[0].y);
    fp.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.clip();

    switch (theme.ground) {
      case "sand": {
        // Long wind-blown ripple lines running roughly along the table.
        ctx.strokeStyle = "rgba(120,85,35,0.16)";
        ctx.lineWidth = 1;
        for (let y = 2; y < D; y += 2.6) {
          const phase = rng() * Math.PI * 2;
          const amp = 0.5 + rng() * 0.9;
          ctx.beginPath();
          for (let x = 0; x <= L; x += 3) {
            const yy = y + Math.sin(x * 0.12 + phase) * amp;
            const p = project(x, yy, 0.01);
            if (x === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
        for (let i = 0; i < 26; i++) {
          fillOnly(ctx, worldRing(project, rng() * L, rng() * D, 0.4 + rng() * 0.9, 0.3 + rng() * 0.6, 7), "rgba(110,80,40,0.16)");
        }
        break;
      }
      case "ice": {
        // Branching cracks plus pale wind-packed drifts.
        for (let i = 0; i < 22; i++) {
          let x = rng() * L, y = rng() * D;
          let ang = rng() * Math.PI * 2;
          ctx.strokeStyle = "rgba(90,130,165,0.3)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          let p = project(x, y, 0.01);
          ctx.moveTo(p.x, p.y);
          const segs = 2 + Math.floor(rng() * 4);
          for (let s = 0; s < segs; s++) {
            ang += (rng() - 0.5) * 1.2;
            x += Math.cos(ang) * (1.5 + rng() * 3);
            y += Math.sin(ang) * (1.5 + rng() * 3);
            p = project(x, y, 0.01);
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
        for (let i = 0; i < 16; i++) {
          fillOnly(ctx, worldRing(project, rng() * L, rng() * D, 1.5 + rng() * 3.5, 1 + rng() * 2, 14), "rgba(255,255,255,0.3)");
        }
        break;
      }
      case "forestFloor": {
        for (let i = 0; i < 12; i++) {
          fillOnly(ctx, worldRing(project, rng() * L, rng() * D, 2 + rng() * 4, 1.5 + rng() * 3, 12), "rgba(70,55,30,0.24)");
        }
        for (let i = 0; i < 150; i++) {
          const s = 0.25 + rng() * 0.5;
          fillOnly(ctx, worldRing(project, rng() * L, rng() * D, s, s * 0.7, 5), rng() > 0.45 ? "rgba(40,70,30,0.4)" : "rgba(80,60,35,0.35)");
        }
        break;
      }
      case "paving": {
        // Theed plaza flagstones — 3" so they subdivide the 6" reference grid cleanly.
        ctx.strokeStyle = "rgba(110,95,55,0.22)";
        ctx.lineWidth = 1;
        for (let x = 0; x <= L + 0.01; x += 3) {
          const a = project(x, 0, 0.01), b = project(x, D, 0.01);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        for (let y = 0; y <= D + 0.01; y += 3) {
          const a = project(0, y, 0.01), b = project(L, y, 0.01);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        // Decorative inlay roundel at the plaza centre.
        const r = Math.min(L, D) * 0.17;
        fillOnly(ctx, worldRing(project, L / 2, D / 2, r, r, 30), "rgba(150,130,80,0.16)");
        fillOnly(ctx, worldRing(project, L / 2, D / 2, r * 0.62, r * 0.62, 26), "rgba(120,100,60,0.14)");
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  // Exposure heatmap: green where a position is screened from most enemy firing angles,
  // red where it's open to nearly all of them. Drawn on the ground plane under the terrain
  // so pieces still read normally on top of it.
  function drawExposure(ctx, project, exposure, floorPts) {
    const { cols, rows, cellSize, values } = exposure;
    // Knock the themed ground back first — a green/red ramp painted straight over sand or
    // forest floor muddies into olive and stops reading as data.
    if (floorPts) fillOnly(ctx, floorPts, "rgba(12,14,20,0.6)");
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = values[r * cols + c];
        if (v < 0) continue; // inside terrain
        const x0 = c * cellSize, y0 = r * cellSize;
        const quad = [
          project(x0, y0, 0.02), project(x0 + cellSize, y0, 0.02),
          project(x0 + cellSize, y0 + cellSize, 0.02), project(x0, y0 + cellSize, 0.02),
        ];
        // green -> yellow -> red ramp
        const red = Math.round(255 * Math.min(1, v * 1.6));
        const green = Math.round(210 * Math.min(1, (1 - v) * 1.6));
        fillOnly(ctx, quad, `rgba(${red},${green},45,0.55)`);
      }
    }
  }

  // Ring + connecting line for the range measuring tool, with the Legion range band.
  function drawMeasure(ctx, project, measure) {
    if (!measure || !measure.a || !measure.b) return;
    const a = project(measure.a.x, measure.a.y, 0.06);
    const b = project(measure.b.x, measure.b.y, 0.06);
    ctx.save();
    ctx.strokeStyle = "rgba(255,220,90,0.95)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 5, 2.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,220,90,0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(60,45,0,0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Pinned pieces get a bright outline so it's obvious what a reroll will leave alone.
  function drawLockRing(ctx, pts) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = "rgba(255,190,70,0.95)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // Renders the layout and returns { regions, unproject } — regions is a hit-test list,
  // front-most first, so the caller can resolve hover/click/drag without redoing any
  // projection math, and unproject converts pointer coords back to table inches.
  LM.renderLayout = function (canvas, layout, mode, themeKey, opts) {
    opts = opts || {};
    mode = mode === "top" ? "top" : "iso";
    const theme = LM.THEMES[themeKey] || LM.THEMES[LM.DEFAULT_THEME];
    // Explicit width/height (with dpr 1) lets the PNG exporter render off-screen at high
    // resolution; a detached canvas has no bounding rect to measure.
    const explicit = opts.width && opts.height;
    const dpr = explicit ? (opts.dpr || 1) : (window.devicePixelRatio || 1);
    const rect = explicit ? { width: opts.width, height: opts.height } : canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    // Setting canvas.width above wipes the surface, so any backdrop has to be painted
    // here rather than by the caller before it calls in.
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, rect.width, rect.height);
    }

    const { table, pois, terrain } = layout;
    let scale, originX, originY;
    // Fill factors leave breathing room on screen; an export can afford to crop tighter.
    const fitW = opts.fitW || 0.82;
    const fitH = opts.fitH || 0.62;
    if (mode === "top") {
      const fitTop = opts.fitTop || 0.86;
      scale = Math.min((rect.width * fitTop) / table.length, (rect.height * fitTop) / table.depth);
      originX = rect.width / 2 - (table.length * scale) / 2;
      originY = rect.height / 2 - (table.depth * scale) / 2;
    } else {
      scale = Math.min(
        (rect.width * fitW) / (table.length + table.depth),
        (rect.height * fitH) / ((table.length + table.depth) * 0.5)
      );
      originX = rect.width / 2;
      originY = rect.height * (opts.originYFrac || 0.22);
    }
    RC.mode = mode;
    RC.pxPerInch = scale;
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

    drawGroundTexture(ctx, project, table, theme);

    // Deployment zones (player Territory) come from the mission's Map Card, not a fixed
    // fraction of the board — shapes differ per mission and aren't always plain bands.
    const territories = LM.getTerritories(table.key, layout.mission.key);
    const drawZone = (rects, fill, edge) => {
      for (const r of rects) {
        const pts = [
          project(r.x0, r.y0, 0.01), project(r.x1, r.y0, 0.01),
          project(r.x1, r.y1, 0.01), project(r.x0, r.y1, 0.01),
        ];
        fillOnly(ctx, pts, fill);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    };
    drawZone(territories.blue, "rgba(70,120,210,0.16)", "rgba(70,120,210,0.6)");
    drawZone(territories.red, "rgba(210,60,50,0.14)", "rgba(210,60,50,0.6)");

    ctx.font = "11px 'Segoe UI', sans-serif";
    const zoneLabelAt = (rect, text, color) => {
      if (!rect) return;
      const p = project((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, 0.015);
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = color;
      ctx.fillText(text, p.x, p.y);
      ctx.restore();
    };
    zoneLabelAt(territories.blue[0], "BLUE DEPLOYMENT", "rgba(140,175,240,0.95)");
    zoneLabelAt(territories.red[0], "RED DEPLOYMENT", "rgba(240,140,130,0.95)");
    zoneLabelAt(
      { x0: 0, x1: table.length, y0: table.depth * 0.46, y1: table.depth * 0.54 },
      "CONTESTED",
      "rgba(200,200,210,0.7)"
    );

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

    // Exposure heatmap sits on the ground, beneath the terrain, so pieces stay readable.
    if (opts.exposure) drawExposure(ctx, project, opts.exposure, floorPts);

    // Draw order: back-to-front by (x+y) so nearer pieces occlude further ones correctly.
    const drawables = [
      ...pois.map((p) => ({ type: "poi", depth: p.x + p.y, data: p })),
      ...terrain.map((t) => ({ type: "terrain", depth: t.x + t.y, data: t })),
    ].sort((a, b) => a.depth - b.depth);

    const lockedIds = opts.lockedIds || null;
    const hitRegions = [];
    for (const d of drawables) {
      if (d.type === "poi") {
        const hit = drawPOI(ctx, project, d.data.x, d.data.y, d.data.isCenter);
        hitRegions.push({ type: "poi", data: d.data, x: hit.x, y: hit.y, r: hit.rPx * 1.4 });
      } else {
        const topPts = drawTerrainPiece(ctx, project, d.data, theme);
        if (lockedIds && lockedIds.has(d.data.id)) drawLockRing(ctx, topPts);
        hitRegions.push({ type: "terrain", data: d.data, pts: topPts });
      }
    }

    drawMeasure(ctx, project, opts.measure);

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

    // Front-most first, so hover/click resolves to whatever visually occludes the rest.
    return {
      regions: hitRegions.reverse(),
      unproject: makeUnprojector(mode, scale, originX, originY),
      project,
    };
  };
})();
