// 双方案并排回放与差异判定
const Compare = {
  planA: null, planB: null,
  simA: null, simB: null,
  actionsB: null,      // 方案乙叠加的应急动作（null=普通方案）
  emgNameB: "",
  vpA: null, vpB: null,
  playing: false, raf: null, lastTs: null,

  init() {
    U.$("#btnCompare").onclick = () => this.open();
    U.$("#btnBackEdit").onclick = () => this.close();
    U.$("#btnCompareRun").onclick = () => this.run();
    U.$("#btnComparePlay").onclick = () => this.togglePlay();
    U.$("#comparePlanA").onchange = () => this.loadSelection();
    U.$("#comparePlanB").onchange = () => this.loadSelection();
    U.$("#cmpUseEmergency").onchange = e => this.toggleEmergency(e.target.checked);
    U.$("#cmpEmgSelect").onchange = () => this.pickEmergency();
    U.$("#cmpTimelineA").addEventListener("click", e => this.seek(e));
    U.$("#cmpTimelineB").addEventListener("click", e => this.seek(e));
  },

  markEmergencyDirty() {
    // 应急动作在编辑侧变化后，若对比视图正开着则提示重跑
    const chk = U.$("#cmpUseEmergency");
    if (chk && chk.checked && U.$("#viewCompare").style.display !== "none") {
      U.$("#cmpVerdict").innerHTML = '<p class="muted">应急动作已修改，点“并排回放”重新计算。</p>';
    }
  },

  async toggleEmergency(on) {
    const selB = U.$("#comparePlanB");
    const emgSel = U.$("#cmpEmgSelect");
    selB.style.display = on ? "none" : "";
    emgSel.style.display = on ? "" : "none";
    if (on) {
      const list = await U.api(`/api/scenarios/${App.scenario.id}/emergency-plans`);
      emgSel.innerHTML = "";
      emgSel.appendChild(U.el("option", { value: "" }, "★ 当前编辑中的动作"));
      list.forEach(p => emgSel.appendChild(U.el("option", { value: p.id }, p.name)));
      if (!Emergency.actions.length && list.length) {
        emgSel.value = list[0].id;
      }
    }
  },

  async pickEmergency() {
    // 选择已存应急方案时载入到编辑侧并在对比时使用
    const id = U.$("#cmpEmgSelect").value;
    if (id) {
      const ep = await U.api("/api/emergency-plans/" + id);
      Emergency.actions = (ep.actions || []).map(a => Object.assign({ id: U.uid("act") }, a));
      Emergency.sortActions();
    }
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
    const useEmg = U.$("#cmpUseEmergency").checked;
    const emgId = U.$("#cmpEmgSelect").value;
    let bodyA = { scenario: App.scenario, plan: this.planA };
    let bodyB;
    this.actionsB = null; this.emgNameB = "";
    if (useEmg) {
      if (emgId) {
        const ep = await U.api("/api/emergency-plans/" + emgId);
        Emergency.actions = (ep.actions || []).map(a => Object.assign({ id: U.uid("act") }, a));
        Emergency.sortActions();
        this.emgNameB = ep.name;
      } else {
        this.emgNameB = "当前应急动作";
      }
      if (!Emergency.actions.length) { alert("应急动作表为空，请先在“应急处置”页安排动作。"); return; }
      this.actionsB = Emergency.actions.map(a => JSON.parse(JSON.stringify(a)));
      bodyB = { scenario: App.scenario, plan: this.planB, actions: this.actionsB };
      U.$("#cmpTitleB").textContent = "方案乙：" + this.planB.name + " + " + this.emgNameB;
    } else {
      bodyB = { scenario: App.scenario, plan: this.planB };
      U.$("#cmpTitleB").textContent = "方案乙：" + this.planB.name;
    }
    U.$("#cmpTitleA").textContent = "方案甲：" + this.planA.name;
    [this.simA, this.simB] = await Promise.all([
      U.api("/api/simulate", { method: "POST", body: bodyA }),
      U.api("/api/simulate", { method: "POST", body: bodyB }),
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
    const drawCol = (cvId, vp, plan, sim, actions) => {
      const canvas = U.$("#" + cvId);
      resizeCanvasToDisplay(canvas);
      drawScene({ ctx: canvas.getContext("2d"), vp, scenario: App.scenario,
        plan, step: this.stepAt(sim), dimmed: false });
      this.drawMiniTimeline(cvId === "cmpCanvasA" ? "cmpTimelineA" : "cmpTimelineB",
        plan, sim, actions);
    };
    drawCol("cmpCanvasA", this.vpA, this.planA, this.simA, null);
    drawCol("cmpCanvasB", this.vpB, this.planB, this.simB, this.actionsB);
    U.$("#cmpTime").textContent = Player.timeT.toFixed(2);
    this.drawSummary("cmpSummaryA", this.planA, this.simA);
    this.drawSummary("cmpSummaryB", this.planB, this.simB);
  },

  drawSummary(elId, plan, sim) {
    const st = this.stepAt(sim);
    const el = U.$("#" + elId);
    const activeLines = plan.lines.filter(l => l.active !== false);
    const maxU = Math.max(...activeLines.map(l => st.util[l.id] || 0));
    const rej = sim.summary && sim.summary.nRejected
      ? ` ｜ <span style="color:#f5b041">${sim.summary.nRejected} 条动作拒收</span>` : "";
    el.innerHTML = `
      <b>t=${st.t.toFixed(2)}h</b> ｜ 主导：${st.dominant} ${st.dominantMag.toFixed(0)}kN<br>
      偏移 Δy=${st.displacement.y.toFixed(2)}m Δx=${st.displacement.x.toFixed(2)}m 首摇=${(st.state.psi * 180 / Math.PI).toFixed(2)}°<br>
      未平衡 ${st.residual.force.toFixed(0)} kN ｜ 力矩 ${st.residual.m.toFixed(0)} kN·m ｜ 最高利用率 ${(maxU * 100).toFixed(0)}%
      ${st.newFailures.length ? ` ｜ <span style="color:#e74c3c">断裂：${st.newFailures.map(id => plan.lines.find(l => l.id === id)?.name).join("、")}</span>` : ""}${rej}`;
  },

  drawMiniTimeline(cvId, plan, sim, actions) {
    const canvas = U.$("#" + cvId);
    resizeCanvasToDisplay(canvas);
    const ctx = canvas.getContext("2d");
    const W = canvas.clientWidth, H = canvas.clientHeight, pad = 40;
    ctx.clearRect(0, 0, W, H);
    const dur = App.scenario.duration;
    const x = t => pad + (t / dur) * (W - pad - 12);
    const top = actions && actions.length ? 12 : 4;
    // 应急动作小标记
    if (actions && actions.length) {
      const rej = new Set((sim.actionResults || []).filter(r => r.status === "rejected").map(r => r.actionId));
      for (const a of actions) {
        const col = EMG_MARKER_COLOR[a.type] || "#aaa";
        ctx.fillStyle = rej.has(a.id) ? "#566573" : col;
        if (a.type === "tugForce" && a.duration > 0) {
          ctx.fillStyle = "rgba(245,176,65,.18)";
          ctx.fillRect(x(a.t), 2, x(a.t + a.duration) - x(a.t), 8);
          ctx.fillStyle = rej.has(a.id) ? "#566573" : col;
        }
        ctx.beginPath(); ctx.arc(x(a.t), 6, 3.5, 0, 7); ctx.fill();
      }
    }
    // 利用率曲线
    ctx.fillStyle = "#0e1c2f"; ctx.fillRect(pad, top, W - pad - 12, 44);
    ctx.strokeStyle = "rgba(231,76,60,.7)";
    ctx.beginPath(); ctx.moveTo(pad, top + 44 * (1 - 1 / 1.3));
    ctx.lineTo(W - 12, top + 44 * (1 - 1 / 1.3)); ctx.stroke();
    for (const line of plan.lines) {
      if (line.active === false && !(actions && actions.length)) continue;
      ctx.strokeStyle = U.lineTypeColor(line.type); ctx.lineWidth = 1.2;
      ctx.beginPath();
      let pen = false;
      sim.steps.forEach((s) => {
        const wasActive = s.active[line.id] !== false && !s.failed[line.id];
        if (!wasActive) { pen = false; return; }
        const u = U.clamp(s.util[line.id] || 0, 0, 1.3);
        const yy = top + 44 * (1 - u / 1.3);
        if (pen) ctx.lineTo(x(s.t), yy); else { ctx.moveTo(x(s.t), yy); pen = true; }
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
