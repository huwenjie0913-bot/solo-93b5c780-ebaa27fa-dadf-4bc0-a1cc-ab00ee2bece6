// 双方案并排回放与差异判定
const Compare = {
  planA: null, planB: null,
  simA: null, simB: null,
  vpA: null, vpB: null,
  playing: false, raf: null, lastTs: null,

  init() {
    U.$("#btnCompare").onclick = () => this.open();
    U.$("#btnBackEdit").onclick = () => this.close();
    U.$("#btnCompareRun").onclick = () => this.run();
    U.$("#btnComparePlay").onclick = () => this.togglePlay();
    U.$("#comparePlanA").onchange = () => this.loadSelection();
    U.$("#comparePlanB").onchange = () => this.loadSelection();
    U.$("#cmpTimelineA").addEventListener("click", e => this.seek(e));
    U.$("#cmpTimelineB").addEventListener("click", e => this.seek(e));
  },

  async open() {
    await persistCurrent(true);
    U.$("#viewEdit").style.display = "none";
    U.$("#viewCompare").style.display = "flex";
    const plans = await U.api(`/api/scenarios/${App.scenario.id}/plans`);
    App.planList = plans;
    const selA = U.$("#comparePlanA"), selB = U.$("#comparePlanB");
    selA.innerHTML = selB.innerHTML = "";
    plans.forEach(p => {
      selA.appendChild(U.el("option", { value: p.id }, p.name));
      selB.appendChild(U.el("option", { value: p.id }, p.name));
    });
    if (plans[0]) selA.value = plans[0].id;
    if (plans[1]) selB.value = plans[1].id;
    else if (plans[0]) selB.value = plans[0].id;
    this.vpA = new Viewport(U.$("#cmpCanvasA"));
    this.vpB = new Viewport(U.$("#cmpCanvasB"));
    await this.loadSelection();
    this.run();
  },

  close() {
    this.pause();
    U.$("#viewCompare").style.display = "none";
    U.$("#viewEdit").style.display = "flex";
    Editor.redraw();
  },

  async loadSelection() {
    const aId = U.$("#comparePlanA").value;
    const bId = U.$("#comparePlanB").value;
    [this.planA, this.planB] = await Promise.all([
      U.api("/api/plans/" + aId), U.api("/api/plans/" + bId)]);
  },

  async run() {
    await this.loadSelection();
    [this.simA, this.simB] = await Promise.all([
      U.api("/api/simulate", { method: "POST", body: { scenario: App.scenario, plan: this.planA } }),
      U.api("/api/simulate", { method: "POST", body: { scenario: App.scenario, plan: this.planB } }),
    ]);
    App.compare = this;
    const box = Editor.worldBox();
    this.vpA.fit(box, 40); this.vpB.fit(box, 40);
    Player.timeT = 0;
    this.drawVerdict();
    this.refreshFrame();
  },

  togglePlay() {
    if (this.playing) return this.pause();
    if (Player.timeT >= App.scenario.duration - 1e-6) Player.timeT = 0;
    this.playing = true; this.lastTs = null;
    const tick = ts => {
      if (!this.playing) return;
      if (this.lastTs != null) {
        Player.timeT += ((ts - this.lastTs) / 1000) * (App.scenario.duration / 24);
        if (Player.timeT >= App.scenario.duration) { Player.timeT = App.scenario.duration; this.pause(); }
      }
      this.lastTs = ts;
      this.refreshFrame();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  pause() { this.playing = false; if (this.raf) cancelAnimationFrame(this.raf); },
  seek(e) {
    this.pause();
    const r = e.currentTarget.getBoundingClientRect();
    const t = U.clamp(((e.clientX - r.left - 40) / (r.width - 60)) * App.scenario.duration, 0, App.scenario.duration);
    Player.setTime(t);
  },

  stepAt(sim) {
    const i = U.clamp(Math.round(Player.timeT / App.scenario.dt), 0, sim.steps.length - 1);
    return sim.steps[i];
  },

  refreshFrame() {
    if (!this.simA || !this.simB) return;
    const drawCol = (cvId, vp, plan, sim) => {
      const canvas = U.$("#" + cvId);
      resizeCanvasToDisplay(canvas);
      drawScene({ ctx: canvas.getContext("2d"), vp, scenario: App.scenario,
        plan, step: this.stepAt(sim), dimmed: false });
      this.drawMiniTimeline(cvId === "cmpCanvasA" ? "cmpTimelineA" : "cmpTimelineB", plan, sim);
    };
    drawCol("cmpCanvasA", this.vpA, this.planA, this.simA);
    drawCol("cmpCanvasB", this.vpB, this.planB, this.simB);
    U.$("#cmpTime").textContent = Player.timeT.toFixed(2);
    this.drawSummary("cmpSummaryA", this.planA, this.simA);
    this.drawSummary("cmpSummaryB", this.planB, this.simB);
  },

  drawSummary(elId, plan, sim) {
    const st = this.stepAt(sim);
    const el = U.$("#" + elId);
    const activeLines = plan.lines.filter(l => l.active !== false);
    const maxU = Math.max(...activeLines.map(l => st.util[l.id] || 0));
    el.innerHTML = `
      <b>t=${st.t.toFixed(2)}h</b> ｜ 主导：${st.dominant} ${st.dominantMag.toFixed(0)}kN<br>
      偏移 Δy=${st.displacement.y.toFixed(2)}m Δx=${st.displacement.x.toFixed(2)}m 首摇=${(st.state.psi * 180 / Math.PI).toFixed(2)}°<br>
      未平衡 ${st.residual.force.toFixed(0)} kN ｜ 力矩 ${st.residual.m.toFixed(0)} kN·m ｜ 最高利用率 ${(maxU * 100).toFixed(0)}%
      ${st.newFailures.length ? ` ｜ <span style="color:#e74c3c">断裂：${st.newFailures.map(id => plan.lines.find(l => l.id === id)?.name).join("、")}</span>` : ""}`;
  },

  drawMiniTimeline(cvId, plan, sim) {
    const canvas = U.$("#" + cvId);
    resizeCanvasToDisplay(canvas);
    const ctx = canvas.getContext("2d");
    const W = canvas.clientWidth, H = canvas.clientHeight, pad = 40;
    ctx.clearRect(0, 0, W, H);
    const dur = App.scenario.duration;
    const x = t => pad + (t / dur) * (W - pad - 12);
    // 利用率曲线
    ctx.fillStyle = "#0e1c2f"; ctx.fillRect(pad, 4, W - pad - 12, 44);
    ctx.strokeStyle = "rgba(231,76,60,.7)";
    ctx.beginPath(); ctx.moveTo(pad, 4 + 44 * (1 - 1 / 1.3));
    ctx.lineTo(W - 12, 4 + 44 * (1 - 1 / 1.3)); ctx.stroke();
    for (const line of plan.lines) {
      if (line.active === false) continue;
      ctx.strokeStyle = U.lineTypeColor(line.type); ctx.lineWidth = 1.2;
      ctx.beginPath();
      sim.steps.forEach((s, i) => {
        const u = U.clamp(s.util[line.id] || 0, 0, 1.3);
        const yy = 4 + 44 * (1 - u / 1.3);
        if (i === 0) ctx.moveTo(x(s.t), yy); else ctx.lineTo(x(s.t), yy);
      });
      ctx.stroke();
    }
    // 残余力
    const maxR = Math.max(100, ...sim.steps.map(s => s.residual.force));
    ctx.strokeStyle = "#ec7063"; ctx.lineWidth = 1.4;
    ctx.beginPath();
    sim.steps.forEach((s, i) => {
      const yy = H - 6 - 28 * U.clamp(s.residual.force / maxR, 0, 1);
      if (i === 0) ctx.moveTo(x(s.t), yy); else ctx.lineTo(x(s.t), yy);
    });
    ctx.stroke();
    // 播放头
    const px = x(Player.timeT);
    ctx.strokeStyle = "#fff";
    ctx.beginPath(); ctx.moveTo(px, 2); ctx.lineTo(px, H - 2); ctx.stroke();
    ctx.fillStyle = "#8599b5"; ctx.font = "9px sans-serif";
    ctx.fillText("利用率", pad + 2, 12);
    ctx.fillText("残余力 " + maxR.toFixed(0), pad + 2, 54);
  },

  drawVerdict() {
    const box = U.$("#cmpVerdict");
    const a = this.simA.summary, b = this.simB.summary;
    const row = (name, s) => {
      if (s.balanced) return `<b>${name}</b>：<span class="badge ok">全程平衡</span>`;
      return `<b>${name}</b>：<span class="badge bad">失衡</span>
        最早失衡 ${s.firstImbalance == null ? "—" : s.firstImbalance.toFixed(2) + "h"}，
        首断缆 <b>${s.firstFailure ? s.firstFailure.name + "（" + s.firstFailure.time.toFixed(2) + "h）" : "—"}</b>，
        最大残余 ${s.maxResidual.toFixed(0)}kN，最大偏移 ${s.maxDisplacement.toFixed(2)}m`;
    };
    // 推荐结论
    let better = null, reason = "";
    if (a.balanced && !b.balanced) better = "甲";
    else if (b.balanced && !a.balanced) better = "乙";
    else if (!a.balanced && !b.balanced) {
      better = (a.firstImbalance ?? 99) > (b.firstImbalance ?? 99) ? "甲" : "乙";
      reason = "两方案均失衡，较晚进入失衡者相对更优；";
    } else {
      better = Math.max(...Object.values(a.maxUtil)) <= Math.max(...Object.values(b.maxUtil)) ? "甲" : "乙";
      reason = "两方案均平衡，峰值利用率更低者更优；";
    }
    box.innerHTML = `<h3>对比结论</h3>
      <p>${row("方案甲 " + this.planA.name, a)}</p>
      <p>${row("方案乙 " + this.planB.name, b)}</p>
      <p>➡ ${reason}建议优先采用 <b class="badge ok">方案${better}</b>。
      主导载荷类型与峰值见两侧"主导"读数；首断缆即首先越过安全载荷并触发受力重分配的缆绳。</p>`;
  },
};
window.Compare = Compare;
