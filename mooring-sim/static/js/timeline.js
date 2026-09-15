// 时间轴：利用率曲线 + 未平衡载荷 + 应急动作标记 + 播放头
const Timeline = {
  canvas: null, ctx: null,
  markerRowH: 22,   // 顶部动作标记行高度

  init() {
    this.canvas = U.$("#timelineCanvas");
    this.ctx = this.canvas.getContext("2d");
    this.canvas.addEventListener("mousedown", e => this.onMouseDown(e));
    this.canvas.addEventListener("mousemove", e => this.onMouseMove(e));
    window.addEventListener("mouseup", () => { Emergency.draggingId = null; });
    window.addEventListener("resize", () => this.redraw());
  },

  tToX(t, w, pad) {
    const dur = App.scenario.duration;
    return pad + (t / dur) * (w - pad * 2);
  },

  chartTop() { return this.markerRowH + 4; },

  onMouseDown(e) {
    // 优先命中动作标记行
    const r = this.canvas.getBoundingClientRect();
    if (e.clientY - r.top <= this.markerRowH && window.Emergency) {
      const hit = this.hitMarker(e.clientX - r.left);
      if (hit) {
        Emergency.draggingId = hit.id;
        Player.pause();
        e.preventDefault();
        return;
      }
    }
    this.seek(e);
  },

  onMouseMove(e) {
    const r = this.canvas.getBoundingClientRect();
    if (Emergency.draggingId) {
      const t = this.tFromClient(e.clientX - r.left);
      Emergency.setActionTime(Emergency.draggingId, t);
      Player.setTime(t);
      this.redraw();
      return;
    }
    if (e.buttons) { this.seek(e); return; }
    // hover 光标提示
    if (e.clientY - r.top <= this.markerRowH && window.Emergency) {
      const hit = this.hitMarker(e.clientX - r.left);
      this.canvas.style.cursor = hit ? "ew-resize" : "pointer";
    } else {
      this.canvas.style.cursor = "pointer";
    }
  },

  hitMarker(x) {
    if (!Emergency.actions.length) return null;
    const w = this.canvas.clientWidth, pad = 44;
    let best = null, bd = 9;
    for (const a of Emergency.actions) {
      const ax = pad + (a.t / App.scenario.duration) * (w - pad * 2);
      if (Math.abs(ax - x) < bd) { bd = Math.abs(ax - x); best = a; }
    }
    return best;
  },

  tFromClient(x) {
    const w = this.canvas.clientWidth, pad = 44;
    return U.clamp(((x - pad) / (w - pad * 2)) * App.scenario.duration, 0, App.scenario.duration);
  },

  seek(e) {
    const t = this.tFromClient(e.clientX - this.canvas.getBoundingClientRect().left);
    Player.pause();
    Player.setTime(t);
  },

  redraw() {
    if (!this.canvas || !App.sim || !App.scenario) return;
    const canvas = this.canvas;
    resizeCanvasToDisplay(canvas);
    const ctx = this.ctx;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    const pad = 44, right = W - 10;
    // 应急推演存在时用其结果，否则用普通推演
    const emgSim = window.Emergency ? Emergency.activeSim() : null;
    const sim = emgSim || App.sim;
    const steps = sim.steps;
    const dur = App.scenario.duration;
    const x = t => pad + (t / dur) * (right - pad);
    const top0 = this.chartTop();

    // 动作标记行背景
    if (window.Emergency && Emergency.actions.length) {
      ctx.fillStyle = "#0b1726";
      ctx.fillRect(pad, 2, right - pad, this.markerRowH - 2);
      ctx.fillStyle = "#8599b5"; ctx.font = "9px sans-serif";
      ctx.fillText("应急动作", pad - 40, this.markerRowH - 7);
      this.drawMarkers(ctx, x, sim, emgSim);
    }

    // 分两区：上 利用率 0-1.3，下 残余力
    const split = top0 + 56;
    ctx.fillStyle = "#0e1c2f"; ctx.fillRect(pad, top0, right - pad, split - top0 - 8);
    ctx.fillStyle = "#10233a"; ctx.fillRect(pad, split + 4, right - pad, H - split - 14);

    // 网格 / 坐标
    ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.fillStyle = "#8599b5";
    ctx.font = "9px sans-serif"; ctx.lineWidth = 1;
    for (let u = 0; u <= 1.0; u += 0.5) {
      const yy = top0 + (split - top0 - 14) * (1 - u / 1.3);
      ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.fillText(u.toFixed(1), 8, yy + 3);
    }
    const y100 = top0 + (split - top0 - 14) * (1 - 1 / 1.3);
    ctx.strokeStyle = "rgba(231,76,60,.7)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad, y100); ctx.lineTo(right, y100); ctx.stroke();
    ctx.setLineDash([]);

    const nHour = Math.ceil(dur);
    for (let h = 0; h <= nHour; h++) ctx.fillText(h + "h", x(h) - 6, H - 2);

    // 利用率曲线（每根缆）。应急推演中备用缆启用后才开始有曲线，
    // 用 step.active/failed 控制起绘点，避免把启用前的零张力连成斜线。
    for (const line of App.plan.lines) {
      ctx.strokeStyle = U.lineTypeColor(line.type);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let pen = false;
      steps.forEach((st, i) => {
        const wasActive = st.active[line.id] !== false && !st.failed[line.id];
        if (!wasActive) { pen = false; return; }
        const u = U.clamp(st.util[line.id] || 0, 0, 1.3);
        const yy = top0 + (split - top0 - 14) * (1 - u / 1.3);
        if (pen) ctx.lineTo(x(st.t), yy); else { ctx.moveTo(x(st.t), yy); pen = true; }
      });
      ctx.stroke();
    }
    // 失效点
    ctx.fillStyle = "#e74c3c";
    const seen = new Set();
    steps.forEach(st => {
      for (const fid of st.newFailures) {
        const key = fid + st.t;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = App.plan.lines.find(l => l.id === fid);
        const u = U.clamp((st.util[fid] || 1), 0, 1.3);
        ctx.beginPath(); ctx.arc(x(st.t), top0 + (split - top0 - 14) * (1 - u / 1.3), 3.5, 0, 7); ctx.fill();
        ctx.fillStyle = "#f5b7b1"; ctx.font = "9px sans-serif";
        ctx.fillText("✖" + (line ? line.name : fid), x(st.t) + 3, top0 + (split - top0 - 14) * (1 - u / 1.3) - 3);
        ctx.fillStyle = "#e74c3c";
      }
    });

    // 残余力曲线
    const maxR = Math.max(100, ...steps.map(s => s.residual.force));
    ctx.strokeStyle = "#ec7063"; ctx.lineWidth = 1.8;
    ctx.beginPath();
    steps.forEach((st, i) => {
      const yy = H - 10 - (H - split - 20) * U.clamp(st.residual.force / maxR, 0, 1);
      if (i === 0) ctx.moveTo(x(st.t), yy); else ctx.lineTo(x(st.t), yy);
    });
    ctx.stroke();
    let imbStart = null;
    steps.forEach((st, i) => {
      if (st.imbalanced && imbStart === null) imbStart = st.t;
      if ((!st.imbalanced || i === steps.length - 1) && imbStart !== null) {
        ctx.fillStyle = "rgba(231,76,60,.15)";
        ctx.fillRect(x(imbStart), split + 4, x(st.t) - x(imbStart), H - split - 14);
        imbStart = null;
      }
    });
    ctx.fillStyle = "#8599b5"; ctx.font = "9px sans-serif";
    ctx.fillText("利用率", pad + 2, top0 + 8);
    ctx.fillText("未平衡载荷 kN（峰值 " + maxR.toFixed(0) + "）", pad + 2, split + 14);

    // 潮位副轴
    ctx.strokeStyle = "rgba(174,214,241,.5)"; ctx.setLineDash([2, 3]);
    const tides = steps.map(s => s.env.tide);
    const tmin = Math.min(...tides), tmax = Math.max(...tides), tr = (tmax - tmin) || 1;
    ctx.beginPath();
    steps.forEach((st, i) => {
      const yy = split + 8 + (H - split - 22) * (1 - (st.env.tide - tmin) / tr);
      if (i === 0) ctx.moveTo(x(st.t), yy); else ctx.lineTo(x(st.t), yy);
    });
    ctx.stroke(); ctx.setLineDash([]);

    // 最晚介入搜索结果：绿=最晚可行，红=紧邻失败
    if (window.Emergency && Emergency.latest && Emergency.latest.feasible) {
      const L = Emergency.latest;
      this.drawSpecialMarker(x(L.latestTime), "#2ecc71", "最晚" + L.latestTime.toFixed(2));
      if (L.nearestFailTime != null)
        this.drawSpecialMarker(x(L.nearestFailTime), "#e74c3c", "失败" + L.nearestFailTime.toFixed(2));
    }

    // 播放头
    const t = Player.timeT ?? 0;
    const px = x(t);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 2); ctx.lineTo(px, H - 4); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.moveTo(px - 5, 2); ctx.lineTo(px + 5, 2); ctx.lineTo(px, 8); ctx.fill();
  },

  drawMarkers(ctx, x, sim, emgSim) {
    const rejected = new Set((emgSim?.actionResults || [])
      .filter(r => r.status === "rejected").map(r => r.actionId));
    const yRow = this.markerRowH / 2 + 1;
    for (const a of Emergency.actions) {
      const px = x(a.t), color = EMG_MARKER_COLOR[a.type] || "#aaa";
      // 拖轮施力窗口
      if (a.type === "tugForce" && a.duration > 0) {
        ctx.fillStyle = "rgba(245,176,65,.18)";
        ctx.fillRect(px, 5, x(a.t + a.duration) - px, this.markerRowH - 8);
      }
      const isRej = rejected.has(a.id);
      ctx.fillStyle = isRej ? "#566573" : color;
      ctx.strokeStyle = isRej ? "#e74c3c" : "#0b1726";
      ctx.lineWidth = 1.5;
      // 形状：缆类为菱形，拖轮为圆
      ctx.beginPath();
      if (a.type === "tugForce") { ctx.arc(px, yRow, 5.5, 0, 7); }
      else {
        ctx.moveTo(px, yRow - 6); ctx.lineTo(px + 6, yRow);
        ctx.lineTo(px, yRow + 6); ctx.lineTo(px - 6, yRow); ctx.closePath();
      }
      ctx.fill(); ctx.stroke();
      if (isRej) {
        ctx.strokeStyle = "#e74c3c"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px - 4, yRow - 4); ctx.lineTo(px + 4, yRow + 4);
        ctx.moveTo(px + 4, yRow - 4); ctx.lineTo(px - 4, yRow + 4); ctx.stroke();
      }
    }
    // 标签（只给悬停播放头附近的，避免拥挤）：全部画小刻度文字时太挤，
    // 改为按动作时刻在标记下方循环排布
    ctx.font = "8.5px sans-serif";
    Emergency.actions.forEach((a, i) => {
      const nm = a.type === "tugForce" ? (a.name || "拖轮")
        : (App.plan.lines.find(l => l.id === a.lineId)?.name || "?");
      ctx.fillStyle = rejected.has(a.id) ? "#e74c3c" : "#cfe0f0";
      ctx.fillText(nm, x(a.t) + 7, yRow + 3);
    });
  },

  drawSpecialMarker(px, color, label) {
    const ctx = this.ctx;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(px, 2); ctx.lineTo(px, this.ctx.canvas.clientHeight - 4); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = "bold 9px sans-serif";
    ctx.fillText(label, px + 3, this.chartTop() + 22);
  },
};

// 根据播放时间取最近步（应急推演优先）
function currentSimStep(sim) {
  const src = sim || (window.Emergency && Emergency.activeSim()) || App.sim;
  const t = Player.timeT ?? 0;
  const dt = App.scenario.dt;
  const i = U.clamp(Math.floor(t / dt + 0.5), 0, src.steps.length - 1);
  return src.steps[i];
}

Object.assign(window, { Timeline, currentSimStep });
