// 时间轴：利用率曲线 + 未平衡载荷 + 事件标记 + 播放头
const Timeline = {
  canvas: null, ctx: null,

  init() {
    this.canvas = U.$("#timelineCanvas");
    this.ctx = this.canvas.getContext("2d");
    this.canvas.addEventListener("click", e => this.seek(e));
    this.canvas.addEventListener("mousemove", e => { if (e.buttons) this.seek(e); });
    window.addEventListener("resize", () => this.redraw());
  },

  tToX(t, w, pad) {
    const dur = App.scenario.duration;
    return pad + (t / dur) * (w - pad * 2);
  },

  seek(e) {
    const r = this.canvas.getBoundingClientRect();
    const w = this.canvas.clientWidth, pad = 44;
    const t = U.clamp(((e.clientX - r.left - pad) / (w - pad * 2)) * App.scenario.duration, 0, App.scenario.duration);
    Player.pause();
    Player.setTime(t);
  },

  redraw() {
    if (!this.canvas || !App.sim || !App.scenario) return;
    const canvas = this.canvas;
    resizeCanvasToDisplay(canvas);
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    const pad = 44, right = W - 10;
    const sim = App.sim, steps = sim.steps;
    const dur = App.scenario.duration;
    const x = t => pad + (t / dur) * (right - pad);

    // 分两区：上 利用率 0-1.3，下 残余力
    const split = 62;
    // 背景
    ctx.fillStyle = "#0e1c2f"; ctx.fillRect(pad, 6, right - pad, split - 14);
    ctx.fillStyle = "#10233a"; ctx.fillRect(pad, split + 4, right - pad, H - split - 14);

    // 网格 / 坐标
    ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.fillStyle = "#8599b5";
    ctx.font = "9px sans-serif"; ctx.lineWidth = 1;
    for (let u = 0; u <= 1.0; u += 0.5) {
      const yy = 6 + (split - 20) * (1 - u / 1.3);
      ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.fillText(u.toFixed(1), 8, yy + 3);
    }
    // 100% 红线
    const y100 = 6 + (split - 20) * (1 - 1 / 1.3);
    ctx.strokeStyle = "rgba(231,76,60,.7)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad, y100); ctx.lineTo(right, y100); ctx.stroke();
    ctx.setLineDash([]);

    const nHour = Math.ceil(dur);
    for (let h = 0; h <= nHour; h++) {
      ctx.fillText(h + "h", x(h) - 6, H - 2);
    }

    // 利用率曲线（每根缆）
    for (const line of App.plan.lines) {
      if (line.active === false) continue;
      ctx.strokeStyle = U.lineTypeColor(line.type);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      steps.forEach((st, i) => {
        const u = U.clamp(st.util[line.id] || 0, 0, 1.3);
        const yy = 6 + (split - 20) * (1 - u / 1.3);
        if (i === 0) ctx.moveTo(x(st.t), yy); else ctx.lineTo(x(st.t), yy);
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
        ctx.beginPath(); ctx.arc(x(st.t), 6 + (split - 20) * (1 - u / 1.3), 3.5, 0, 7); ctx.fill();
        ctx.fillStyle = "#f5b7b1"; ctx.font = "9px sans-serif";
        ctx.fillText("✖" + (line ? line.name : fid), x(st.t) + 3, 6 + (split - 20) * (1 - u / 1.3) - 3);
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
    // 失衡区间阴影
    let imbStart = null;
    steps.forEach((st, i) => {
      if (st.imbalanced && imbStart === null) imbStart = st.t;
      if ((!st.imbalanced || i === steps.length - 1) && imbStart !== null) {
        const x0 = x(imbStart), x1 = x(st.t);
        ctx.fillStyle = "rgba(231,76,60,.15)";
        ctx.fillRect(x0, split + 4, x1 - x0, H - split - 14);
        imbStart = null;
      }
    });
    ctx.fillStyle = "#8599b5"; ctx.font = "9px sans-serif";
    ctx.fillText("利用率", pad + 2, 14);
    ctx.fillText("未平衡载荷 kN（峰值 " + maxR.toFixed(0) + "）", pad + 2, split + 14);

    // 潮位副轴（浅色虚线）
    ctx.strokeStyle = "rgba(174,214,241,.5)"; ctx.setLineDash([2, 3]);
    const tides = steps.map(s => s.env.tide);
    const tmin = Math.min(...tides), tmax = Math.max(...tides), tr = (tmax - tmin) || 1;
    ctx.beginPath();
    steps.forEach((st, i) => {
      const yy = split + 8 + (H - split - 22) * (1 - (st.env.tide - tmin) / tr);
      if (i === 0) ctx.moveTo(x(st.t), yy); else ctx.lineTo(x(st.t), yy);
    });
    ctx.stroke(); ctx.setLineDash([]);

    // 播放头
    const t = Player.timeT ?? 0;
    const px = x(t);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 4); ctx.lineTo(px, H - 4); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.moveTo(px - 5, 4); ctx.lineTo(px + 5, 4); ctx.lineTo(px, 10); ctx.fill();
  },
};

// 根据播放时间取最近步
function currentSimStep(sim) {
  const t = Player.timeT ?? 0;
  const dt = App.scenario.dt;
  const i = U.clamp(Math.round(t / dt), 0, sim.steps.length - 1);
  return sim.steps[i];
}

Object.assign(window, { Timeline, currentSimStep });
