// ============ 画布坐标系（世界 m → 屏幕 px） ============
class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.scale = 3;      // px / m
    this.cx = 0;         // 屏幕中心对应的世界坐标
    this.cy = 0;
  }
  fit(worldBox, pad = 60) {
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    const sx = (w - pad * 2) / (worldBox.xmax - worldBox.xmin);
    const sy = (h - pad * 2) / (worldBox.ymax - worldBox.ymin);
    this.scale = Math.min(sx, sy);
    this.cx = (worldBox.xmin + worldBox.xmax) / 2;
    this.cy = (worldBox.ymin + worldBox.ymax) / 2;
  }
  toScreen(p) {
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    return { x: w / 2 + (p.x - this.cx) * this.scale,
             y: h / 2 - (p.y - this.cy) * this.scale };
  }
  toWorld(s) {
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    return { x: (s.x - w / 2) / this.scale + this.cx,
             y: -(s.y - h / 2) / this.scale + this.cy };
  }
  zoomAt(screen, factor) {
    const before = this.toWorld(screen);
    this.scale = U.clamp(this.scale * factor, 0.5, 40);
    const after = this.toWorld(screen);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }
}

// ============ 俯视泊位绘制（可复用于编辑画布和对比画布） ============
function drawScene(o) {
  // o: {ctx, vp, scenario, plan, step, selectedLineId, dimmed, showForce}
  const { ctx, vp, scenario, plan, step } = o;
  const ship = scenario.ship;
  const st = step ? step.state : { x: ship.x, y: ship.y, psi: ship.psi0 || 0 };
  const W = ctx.canvas.clientWidth || ctx.canvas.width;
  const H = ctx.canvas.clientHeight || ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);

  // 海水背景网格
  ctx.fillStyle = "#0c2233";
  ctx.fillRect(0, 0, W, H);
  drawGrid(ctx, vp, W, H);

  // 陆地（贴泊线岸侧）
  const berth = vp.toScreen({ x: -9999, y: ship.berthY });
  ctx.fillStyle = "#3a2e20";
  ctx.fillRect(0, 0, W, berth.y);
  // 护舷/贴泊线
  ctx.strokeStyle = "#8d6e3f";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, berth.y); ctx.lineTo(W, berth.y);
  ctx.stroke();
  ctx.strokeStyle = "rgba(200,170,110,.4)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(0, berth.y - 6); ctx.lineTo(W, berth.y - 6); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#c9b184";
  ctx.font = "11px sans-serif";
  ctx.fillText("岸侧 / 护舷线", 10, berth.y - 8);
  ctx.fillText("海侧", 10, berth.y + 18);

  // 环境箭头（风/流），放在右上空白区
  if (step && !o.dimmed) drawEnvArrows(ctx, vp, step, W, H);

  // 缆绳（先画线再画船和桩，使端点在上层）
  for (const line of plan.lines) {
    drawLine(ctx, vp, scenario, line, st, step, o);
  }

  // 船体
  drawShip(ctx, vp, ship, st, step, o);

  // 缆桩
  for (const b of scenario.bollards) drawBollard(ctx, vp, b);

  // 标签：张力值（播放时）
  if (step && !o.dimmed) {
    ctx.font = "10px sans-serif";
    for (const line of plan.lines) {
      if (line.active === false) continue;
      const T = step.tensions[line.id];
      if (T == null || T < 0.5) continue;
      const { p, b } = G.lineEndpoints(line, st);
      const mid = { x: (p.x + b.x) / 2, y: (p.y + b.y) / 2 };
      const s2 = vp.toScreen(mid);
      const u = step.util[line.id] || 0;
      drawTag(ctx, s2.x, s2.y, `${Math.round(T)}kN`, U.utilColor(u));
    }
  }
}

function drawGrid(ctx, vp, W, H) {
  ctx.strokeStyle = "rgba(120,170,210,.08)";
  ctx.lineWidth = 1;
  const stepM = 20;
  const tl = vp.toWorld({ x: 0, y: 0 });
  const br = vp.toWorld({ x: W, y: H });
  for (let x = Math.floor(tl.x / stepM) * stepM; x < br.x; x += stepM) {
    const a = vp.toScreen({ x, y: 0 });
    ctx.beginPath(); ctx.moveTo(a.x, 0); ctx.lineTo(a.x, H); ctx.stroke();
  }
  for (let y = Math.floor(br.y / stepM) * stepM; y < tl.y; y += stepM) {
    const a = vp.toScreen({ x: 0, y });
    ctx.beginPath(); ctx.moveTo(0, a.y); ctx.lineTo(W, a.y); ctx.stroke();
  }
}

function drawShip(ctx, vp, ship, st, step, o) {
  const L = ship.L, B = ship.B;
  const corners = [
    { x: L / 2, y: -B / 2 }, { x: L / 2, y: B / 2 },
    { x: -L / 2, y: B / 2 }, { x: -L / 2, y: -B / 2 },
  ].map(l => G.fairleadWorld([l.x, l.y], st));
  const scr = corners.map(c => vp.toScreen(c));
  // 阴影
  ctx.fillStyle = "rgba(0,0,0,.35)";
  pathPoly(ctx, scr.map(p => ({ x: p.x + 2, y: p.y + 2 })));
  ctx.fill();
  ctx.fillStyle = "#1f3a5f";
  ctx.strokeStyle = "#7fb3e8";
  ctx.lineWidth = 2;
  pathPoly(ctx, scr);
  ctx.fill(); ctx.stroke();
  // 船首标记
  const bow = G.fairleadWorld([L / 2, 0], st);
  const stern = G.fairleadWorld([-L / 2, 0], st);
  const bs = vp.toScreen(bow), ss = vp.toScreen(stern);
  ctx.strokeStyle = "#7fb3e8";
  ctx.beginPath(); ctx.moveTo(ss.x, ss.y); ctx.lineTo(bs.x, bs.y); ctx.stroke();
  ctx.fillStyle = "#aed4f5";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText("▲ 船首", bs.x - 8, bs.y - 8);
  ctx.fillText("船尾", ss.x - 10, ss.y + 18);

  // 原始位置虚影（编辑/播放时显示偏移）
  if (step) {
    const st0 = { x: ship.x, y: ship.y, psi: ship.psi0 || 0 };
    const c0 = [
      { x: L / 2, y: -B / 2 }, { x: L / 2, y: B / 2 },
      { x: -L / 2, y: B / 2 }, { x: -L / 2, y: -B / 2 },
    ].map(l => G.fairleadWorld([l.x, l.y], st0)).map(c => vp.toScreen(c));
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.setLineDash([4, 4]);
    pathPoly(ctx, c0); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 导缆孔（可拖拽）
  if (!o.dimmed) {
    for (const f of ship.fairleads) {
      const p = vp.toScreen(G.fairleadWorld([f.x, f.y], st));
      ctx.fillStyle = "#f9e79f";
      ctx.strokeStyle = "#b7950b";
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill(); ctx.stroke();
    }
  }
}

function pathPoly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function drawBollard(ctx, vp, b) {
  const p = vp.toScreen(b);
  ctx.fillStyle = "#5d6d7e";
  ctx.strokeStyle = "#aebfcf";
  ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#d6e4f0";
  ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, 7); ctx.fill();
  ctx.fillStyle = "#cfe0f0";
  ctx.font = "10px sans-serif";
  ctx.fillText(b.name || b.id, p.x + 8, p.y + 3);
}

function drawLine(ctx, vp, scenario, line, st, step, o) {
  const { p, b } = G.lineEndpoints(line, st);
  const a = vp.toScreen(p), c = vp.toScreen(b);
  const inactive = line.active === false;
  const failed = step && step.failed && step.failed[line.id];
  const T = step ? step.tensions[line.id] : null;
  const u = step ? (step.util[line.id] || 0) : 0;

  let color = U.lineTypeColor(line.type);
  if (step) color = failed ? "#7b241c" : U.utilColor(u);
  if (inactive) color = "#566573";

  ctx.strokeStyle = color;
  ctx.lineWidth = failed ? 1.5 : (o.selectedLineId === line.id ? 3.5 : 2.2);
  if (inactive || failed) ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
  ctx.setLineDash([]);

  // 端点：导缆孔端小圆（拖此点可改接线），桩端方块
  if (!o.dimmed) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(a.x, a.y, 5, 0, 7); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillRect(c.x - 3.5, c.y - 3.5, 7, 7);
  }

  // 名称标签
  if (!o.dimmed) {
    const mid = vp.toScreen({ x: (p.x + b.x) / 2, y: (p.y + b.y) / 2 });
    ctx.fillStyle = inactive ? "#7f8c99" : "#e8f0fa";
    ctx.font = "10px sans-serif";
    ctx.fillText(line.name, mid.x - 14, mid.y - 6);
  }
}

function drawTag(ctx, x, y, txt, color) {
  ctx.font = "bold 10px sans-serif";
  const w = ctx.measureText(txt).width + 8;
  ctx.fillStyle = "rgba(8,18,30,.85)";
  ctx.strokeStyle = color;
  roundRect(ctx, x - w / 2, y - 18, w, 15, 3);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(txt, x - w / 2 + 4, y - 7);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

// 风/流箭头（取世界尺度，指向力方向）
function drawEnvArrows(ctx, vp, step, W, H) {
  const env = step.env;
  const origin = { x: W - 130, y: 36 };
  const items = [
    { name: `风 ${env.windSpeed.toFixed(0)}m/s`, ang: env.windDir, color: "#aed6f1" },
    { name: `流 ${env.currentSpeed.toFixed(1)}m/s`, ang: env.currentDir || 0, color: "#76d7c4" },
  ];
  items.forEach((it, i) => {
    const ox = origin.x, oy = origin.y + i * 26;
    const len = 22 + Math.min(18, it.name.includes("风") ? env.windSpeed : env.currentSpeed * 8);
    const dx = Math.cos(it.ang) * len;
    const dy = -Math.sin(it.ang) * len;  // 屏幕 y 翻转
    ctx.strokeStyle = it.color; ctx.fillStyle = it.color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ox - dx, oy - dy); ctx.lineTo(ox, oy); ctx.stroke();
    const ang = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox - 7 * Math.cos(ang - 0.4), oy - 7 * Math.sin(ang - 0.4));
    ctx.lineTo(ox - 7 * Math.cos(ang + 0.4), oy - 7 * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
    ctx.font = "10px sans-serif";
    ctx.fillText(it.name, ox - 44, oy - 8);
  });
  // 潮位
  ctx.fillStyle = "#f8f9fa";
  ctx.font = "11px sans-serif";
  ctx.fillText(`潮位 ${env.tide.toFixed(2)} m`, W - 130, H - 12);
}

// ============ 命中测试（返回 {kind,id}） ============
function hitTest(vp, scenario, plan, screenPt, tol = 8) {
  const sh = scenario.ship;
  const st = G.currentState();
  const w = vp.toWorld(screenPt);

  // 导缆孔优先
  for (const f of sh.fairleads) {
    const p = G.fairleadWorld([f.x, f.y], st);
    if (Math.hypot(p.x - w.x, p.y - w.y) * vp.scale < tol + 3)
      return { kind: "fairlead", id: f.id };
  }
  // 缆绳线段（屏幕距离）
  let best = null, bestD = tol;
  for (const line of plan.lines) {
    const { p, b } = G.lineEndpoints(line, st);
    const a = vp.toScreen(p), c = vp.toScreen(b);
    const d = distToSegment(screenPt, a, c);
    // 端点圆：改接线
    if (Math.hypot(screenPt.x - a.x, screenPt.y - a.y) < tol + 2)
      return { kind: "lineEnd", id: line.id };
    if (d < bestD) { bestD = d; best = line; }
  }
  if (best) return { kind: "line", id: best.id };
  // 缆桩
  for (const b of scenario.bollards) {
    const p = vp.toScreen(b);
    if (Math.hypot(screenPt.x - p.x, screenPt.y - p.y) < tol)
      return { kind: "bollard", id: b.id };
  }
  // 船体
  if (Math.abs(w.x - sh.x) <= sh.L / 2 && Math.abs(w.y - sh.y) <= sh.B / 2)
    return { kind: "ship" };
  return null;
}

function distToSegment(p, a, b) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = U.clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

Object.assign(window, { Viewport, drawScene, hitTest, distToSegment });
