// ============ 应急处置：动作编排、时序推演、最晚介入、应急方案 ============
// 动作类型：
//   enableLine    启用预先停用的备用缆   {lineId, t}
//   disableLine   停用受损缆           {lineId, t}
//   setPretension 调整指定缆预张力 kN   {lineId, t, pretension}
//   tugForce      限时拖轮力           {t, force, duration, direction}
// 方向与风角同约定：shore=顶推靠泊(−y)、sea=拉离泊位(+y)、bow/stern。
const EMG_TYPES = ["enableLine", "disableLine", "setPretension", "tugForce"];
const EMG_MARKER_COLOR = {
  enableLine: "#2ecc71", disableLine: "#e67e22",
  setPretension: "#5dade2", tugForce: "#f5b041",
};
const EMG_DEFAULT = {
  enableLine: { pretension: 0, force: 0, duration: 0 },
  disableLine: {},
  setPretension: { pretension: 150 },
  tugForce: { force: 600, duration: 1.0, direction: "shore", name: "拖轮" },
};

const Emergency = {
  actions: [],          // 编辑中的动作表
  sim: null,            // 应急推演结果（actions 非空时；否则 null，回退普通推演）
  enabled: true,        // 是否启用应急推演（勾选/有动作时）
  busy: false,
  savedPlans: [],
  currentSavedId: null,
  latest: null,         // 最晚介入搜索结果
  draggingId: null,     // 时间轴上正在拖动的动作标记

  init() {
    U.$("#btnEmgAdd").onclick = () => this.addAction(U.$("#emgType").value);
    U.$("#btnEmgLatest").onclick = () => this.findLatest();
    U.$("#btnEmgApplyLatest").onclick = () => this.applyLatest();
    U.$("#btnEmgSave").onclick = () => this.savePlan();
    U.$("#btnEmgLoad").onclick = () => this.loadSelected();
    U.$("#btnEmgDelete").onclick = () => this.deleteSelected();
    U.$("#emgCompareChk").onchange = () => Compare.markEmergencyDirty();
    this.refreshSavedPlans();
  },

  // ------------------------------------------------ 状态切换
  reset() {
    this.actions = [];
    this.sim = null;
    this.currentSavedId = null;
    this.latest = null;
    U.$("#emgCompareChk").checked = false;
    this.renderActionList();
    this.renderEvents();
    this.renderLatest();
  },

  activeSim() {
    // 主界面当前应显示的推演结果
    return this.enabled && this.actions.length ? this.sim : null;
  },

  // ------------------------------------------------ 动作增删改
  addAction(type, t) {
    const at = t ?? Player.timeT ?? 0;
    const a = Object.assign({
      id: U.uid("act"), type, t: Math.round(at * 100) / 100,
      label: this.typeLabel(type),
    }, EMG_DEFAULT[type] || {});
    if (type !== "tugForce") {
      a.lineId = this.defaultLineFor(type);
      if (!a.lineId) { alert(this.lineHint(type)); return; }
    }
    this.actions.push(a);
    this.sortActions();
    this.request();
    this.renderActionList();
  },

  defaultLineFor(type) {
    const lines = App.plan.lines || [];
    if (type === "enableLine") {
      const spare = lines.find(l => l.active === false && !this.isBroken(l.id));
      return spare ? spare.id : (lines[0] && lines[0].id);
    }
    return lines[0] ? lines[0].id : null;
  },
  lineHint(type) {
    if (type === "enableLine") return "方案中还没有缆绳；先在缆绳页添加并预先停用一根备用缆。";
    return "方案中还没有缆绳。";
  },
  isBroken(lineId) {
    const base = App.sim;
    if (!base) return false;
    return base.steps.some(s => s.newFailures.includes(lineId));
  },

  removeAction(id) {
    this.actions = this.actions.filter(a => a.id !== id);
    this.request();
    this.renderActionList();
  },
  updateAction(id, patch) {
    const a = this.actions.find(x => x.id === id);
    if (!a) return;
    Object.assign(a, patch);
    this.sortActions();
    this.request();
  },
  setActionTime(id, t) {
    const a = this.actions.find(x => x.id === id);
    if (!a) return;
    a.t = U.clamp(Math.round(t * 100) / 100, 0, App.scenario.duration);
    this.request();
  },
  sortActions() {
    this.actions.sort((a, b) => a.t - b.t || EMG_TYPES.indexOf(a.type) - EMG_TYPES.indexOf(b.type));
  },

  typeLabel(t) {
    return { enableLine: "启用备用缆", disableLine: "停用受损缆",
      setPretension: "调整预张力", tugForce: "限时拖轮力" }[t] || t;
  },
  lineName(id) {
    const l = (App.plan.lines || []).find(x => x.id === id);
    return l ? l.name : (id || "—");
  },

  // ------------------------------------------------ 推演
  request: U.debounce(function () { Emergency.run(); }, 300),

  async run() {
    if (!App.scenario || !App.plan) return;
    this.latest = null;
    this.renderLatest();
    if (!this.actions.length) {
      this.sim = null;
      Editor.redraw(); Timeline.redraw();
      renderResultPanel(); renderLineTable();
      this.renderEvents();
      return;
    }
    this.busy = true;
    try {
      this.sim = await U.api("/api/simulate", { method: "POST", body: {
        scenario: App.scenario, plan: App.plan, actions: this.actions } });
      // 动作拒收/目标失效时在面板给出原因，不阻断其余动作
      Editor.redraw(); Timeline.redraw();
      renderResultPanel(); renderLineTable();
      this.renderEvents();
      this.renderActionList();
      if (App.compare) Compare.markEmergencyDirty();
    } catch (err) {
      this.sim = null;
      this.renderEventsError(err.message);
    } finally {
      this.busy = false;
    }
  },

  // ------------------------------------------------ 最晚介入
  async findLatest() {
    if (!this.actions.length) { alert("请先在时间轴上安排应急动作。"); return; }
    const tLo = parseFloat(U.$("#emgLo").value) || 0;
    const tHi = parseFloat(U.$("#emgHi").value) || App.scenario.duration;
    const res = parseFloat(U.$("#emgRes").value) || 0.2;
    const box = U.$("#emgLatestResult");
    box.className = "emg-latest-result muted";
    box.textContent = "搜索中：正在区间内反复推演，请稍候…";
    try {
      this.latest = await U.api("/api/emergency/latest", { method: "POST", body: {
        scenario: App.scenario, plan: App.plan, actions: this.actions,
        tLo, tHi, resolution: res, tol: Math.min(0.05, res / 2) } });
    } catch (err) {
      this.latest = null;
      box.className = "emg-latest-result bad-text";
      box.textContent = err.message;
      U.$("#btnEmgApplyLatest").style.display = "none";
      return;
    }
    this.renderLatest();
    Timeline.redraw();
  },

  renderLatest() {
    const box = U.$("#emgLatestResult");
    const btn = U.$("#btnEmgApplyLatest");
    if (!this.latest) {
      box.className = "emg-latest-result muted";
      box.textContent = "将整套动作整体平移、反复推演：返回仍能避免失衡的最晚时刻与其紧邻的失败时刻。";
      btn.style.display = "none";
      return;
    }
    if (!this.latest.feasible) {
      box.className = "emg-latest-result bad-text";
      box.innerHTML = "✖ " + this.latest.reason;
      btn.style.display = "none";
      return;
    }
    const L = this.latest;
    box.className = "emg-latest-result ok-text";
    let html = `✔ 最晚可行介入时刻 <b>${L.latestTime.toFixed(2)} h</b>`;
    if (L.nearestFailTime != null)
      html += `；晚于 <b>${L.nearestFailTime.toFixed(2)} h</b>（裕量 ${L.margin.toFixed(2)}h）即失败`;
    else html += "（区间上界仍可行）";
    const fs = L.failRun && L.failRun.summary;
    if (fs) html += `<br><span class="muted">紧邻失败推演：首断缆 ${
      fs.firstFailure ? fs.firstFailure.name + " @" + fs.firstFailure.time.toFixed(2) + "h" : "—"}，
      最早失衡 ${fs.firstImbalance != null ? fs.firstImbalance.toFixed(2) + "h" : "—"}，
      最大残余 ${fs.maxResidual.toFixed(0)} kN</span>`;
    box.innerHTML = html;
    btn.style.display = "";
    btn.textContent = `应用最晚时刻 ${L.latestTime.toFixed(2)}h 并回放`;
  },

  async applyLatest() {
    if (!this.latest || !this.latest.feasible) return;
    // 用搜索返回的平移后动作时刻替换当前动作
    const byId = Object.fromEntries(this.latest.actions.map(a => [a.id, a]));
    this.actions.forEach(a => { if (byId[a.id]) a.t = byId[a.id].t; });
    this.sortActions();
    await this.run();
    this.renderActionList();
    Player.setTime(this.latest.latestTime);
  },

  // ------------------------------------------------ 应急方案存取
  async refreshSavedPlans() {
    if (!App.scenario) return;
    try {
      this.savedPlans = await U.api(
        `/api/scenarios/${App.scenario.id}/emergency-plans?planId=${App.plan.id}`);
    } catch { this.savedPlans = []; }
    const sel = U.$("#emgSavedSelect");
    sel.innerHTML = "";
    sel.appendChild(U.el("option", { value: "" }, "（选择已保存的应急方案）"));
    this.savedPlans.forEach(p => sel.appendChild(U.el("option",
      { value: p.id, selected: p.id === this.currentSavedId ? "" : null }, p.name)));
  },

  async savePlan() {
    const name = prompt("应急方案名称",
      (this.currentSavedId ? "" : App.plan.name + "·应急 " + new Date().toLocaleString("zh-CN")));
    if (!name) return;
    const payload = {
      id: this.currentSavedId || undefined,
      scenarioId: App.scenario.id, planId: App.plan.id, name,
      actions: this.actions,
      latestTime: this.latest?.latestTime ?? null,
      nearestFailTime: this.latest?.nearestFailTime ?? null,
    };
    const res = await U.api("/api/emergency-plans", { method: "POST", body: payload });
    this.currentSavedId = res.id;
    await this.refreshSavedPlans();
    U.$("#emgSavedSelect").value = res.id;
  },

  async loadSelected() {
    const id = U.$("#emgSavedSelect").value;
    if (!id) { alert("请先选择一个应急方案"); return; }
    const ep = await U.api("/api/emergency-plans/" + id);
    this.currentSavedId = ep.id;
    this.actions = (ep.actions || []).map(a => Object.assign({ id: U.uid("act") }, a));
    this.sortActions();
    await this.run();
    this.renderActionList();
  },

  async deleteSelected() {
    const id = U.$("#emgSavedSelect").value;
    if (!id) { alert("请先选择一个应急方案"); return; }
    if (!confirm("删除该应急方案？")) return;
    await U.api("/api/emergency-plans/" + id, { method: "DELETE" });
    if (this.currentSavedId === id) { this.currentSavedId = null; this.reset(); }
    await this.refreshSavedPlans();
  },

  // ------------------------------------------------ 动作列表侧栏
  renderActionList() {
    const box = U.$("#emgList");
    if (!box) return;
    box.innerHTML = "";
    if (!this.actions.length) {
      box.appendChild(U.el("p", { class: "muted", style: "font-size:11px;margin:4px 0" },
        "暂无动作。选择类型后点“插入”，或直接在时间轴动作行拖动标记改时刻。"));
      return;
    }
    const resultsById = {};
    (this.sim?.actionResults || []).forEach(r => { resultsById[r.actionId] = r; });

    for (const a of this.actions) {
      const res = resultsById[a.id];
      const rejected = res && res.status === "rejected";
      const color = EMG_MARKER_COLOR[a.type];
      const head = U.el("div", { class: "emg-item" + (rejected ? " rejected" : "") }, []);

      const title = U.el("div", { class: "emg-item-head", style: `border-left-color:${color}` }, [
        U.el("span", { class: "emg-dot", style: `background:${color}` }),
        U.el("b", {}, a.label),
        U.el("span", { class: "muted", style: "font-size:10.5px" },
          a.type === "tugForce" ? (a.name || "拖轮") : this.lineName(a.lineId)),
      ]);
      const tI = U.el("input", { type: "number", step: "0.1", min: "0",
        max: String(App.scenario.duration), value: a.t, style: "width:56px",
        title: "触发时刻 h（也可拖动时间轴标记）" });
      tI.oninput = e => this.updateAction(a.id, { t: U.clamp(parseFloat(e.target.value) || 0, 0, App.scenario.duration) });

      const fields = [U.el("label", { class: "emg-fld" }, ["t", tI])];

      if (a.type !== "tugForce") {
        const sel = U.el("select", { style: "max-width:130px" });
        App.plan.lines.forEach(l => sel.appendChild(U.el("option",
          { value: l.id, selected: l.id === a.lineId ? "" : null },
          l.name + (l.active === false ? "（停用中）" : ""))));
        sel.onchange = e => this.updateAction(a.id, { lineId: e.target.value });
        fields.push(U.el("label", { class: "emg-fld" }, ["缆", sel]));
      }
      if (a.type === "setPretension") {
        const pI = U.el("input", { type: "number", step: "10", value: a.pretension ?? 150,
          style: "width:64px" });
        pI.oninput = e => this.updateAction(a.id, { pretension: Math.max(0, parseFloat(e.target.value) || 0) });
        fields.push(U.el("label", { class: "emg-fld" }, ["预张力kN", pI]));
      }
      if (a.type === "tugForce") {
        const fI = U.el("input", { type: "number", step: "50", min: "0", value: a.force, style: "width:64px" });
        fI.oninput = e => this.updateAction(a.id, { force: Math.max(0, parseFloat(e.target.value) || 0) });
        const dI = U.el("input", { type: "number", step: "0.1", min: "0", value: a.duration, style: "width:52px",
          title: "持续时长 h（限时施力，到时自动解除）" });
        dI.oninput = e => this.updateAction(a.id, { duration: Math.max(0, parseFloat(e.target.value) || 0) });
        const dS = U.el("select", {}, [
          ["shore", "顶推靠泊"], ["sea", "拉离泊位"], ["bow", "向船首"], ["stern", "向船尾"],
        ].map(([v, nm]) => U.el("option", { value: v, selected: a.direction === v ? "" : null }, nm)));
        dS.onchange = e => this.updateAction(a.id, { direction: e.target.value });
        fields.push(U.el("label", { class: "emg-fld" }, ["力kN", fI]));
        fields.push(U.el("label", { class: "emg-fld" }, ["持续h", dI]));
        fields.push(U.el("label", { class: "emg-fld" }, ["方向", dS]));
      }
      const del = U.el("button", { class: "btn small danger", onclick: () => this.removeAction(a.id) }, "删除");
      fields.push(del);
      head.appendChild(title);
      head.appendChild(U.el("div", { class: "emg-item-fields" }, fields));
      if (rejected) {
        head.appendChild(U.el("div", { class: "emg-reason" }, "⚠ " + res.reason));
      } else if (res && res.cascadedFailures.length) {
        head.appendChild(U.el("div", { class: "emg-reason warn-text" },
          "动作后级联断缆：" + res.cascadedFailures.map(f => f.name).join("、")));
      }
      box.appendChild(head);
    }
  },

  // ------------------------------------------------ 事件日志
  renderEventsError(msg) {
    const box = U.$("#emgEvents");
    box.innerHTML = `<p class="bad-text">求解失败：${msg}</p>`;
  },

  renderEvents() {
    const box = U.$("#emgEvents");
    if (!box) return;
    const sim = this.activeSim();
    if (!this.actions.length) {
      box.innerHTML = '<p class="muted">安排动作并求解后，此处按时间列出计划动作、自动断缆及其前后的'
        + "缆绳利用率、船体偏移与未平衡载荷。</p>";
      return;
    }
    if (!sim) { box.innerHTML = '<p class="muted">求解中…</p>'; return; }

    const rows = [];
    // 汇总拒收/结构错误（未排上时间步的）
    const struct = sim.structuralErrors || [];
    struct.forEach(e => rows.push({ t: null, kind: "struct", text: e.reason }));

    sim.steps.forEach(st => {
      (st.newFailures || []).forEach(lid => {
        const l = App.plan.lines.find(x => x.id === lid);
        rows.push({ t: st.t, kind: "fail", text: `自动失效：${l ? l.name : lid}`,
          step: st });
      });
      (st.events || []).forEach(ev => rows.push({ t: ev.t, kind: ev.kind, ev, step: st }));
    });
    rows.sort((a, b) => (a.t ?? -1) - (b.t ?? -1));

    box.innerHTML = "";
    if (!rows.length) {
      box.appendChild(U.el("p", { class: "muted" }, "全程无断缆、无动作事件。"));
    }
    const nRej = sim.summary.nRejected || 0;
    if (nRej) {
      box.appendChild(U.el("p", { class: "bad-text", style: "margin:2px 0 6px" },
        `⚠ ${nRej} 条动作未能执行（见下方原因），其余动作照常生效。`));
    }
    for (const r of rows) {
      if (r.kind === "struct") {
        box.appendChild(U.el("div", { class: "emg-log reject" }, "⚠ " + r.text));
        continue;
      }
      const item = U.el("div", { class: "emg-log " + (r.kind === "fail" ? "fail"
        : r.ev.kind === "rejected" ? "reject" : "action"),
        onclick: () => Player.setTime(r.t) }, []);
      const ttag = U.el("span", { class: "emg-log-t" }, (r.t ?? 0).toFixed(2) + "h");
      if (r.kind === "fail") {
        item.appendChild(ttag);
        item.appendChild(U.el("span", {}, "✖ " + r.text));
        box.appendChild(item);
        continue;
      }
      const ev = r.ev;
      if (ev.kind === "rejected") {
        item.appendChild(ttag);
        item.appendChild(U.el("span", {}, `${ev.label} → ${ev.target || "—"}：未执行`));
        item.appendChild(U.el("div", { class: "emg-reason" }, "⚠ " + ev.reason));
        box.appendChild(item);
        continue;
      }
      const b = ev.before, a = ev.after;
      item.appendChild(ttag);
      item.appendChild(U.el("span", { class: "emg-log-title" },
        `${ev.label} → ${ev.target || "—"}`));
      // 目标相关的利用率/张力变化
      const dT = this.deltaLineText(ev, b, a);
      const dDisp = `偏移 ${b.disp.mag.toFixed(2)}→${a.disp.mag.toFixed(2)}m`;
      const dR = `未平衡 ${b.residual.force.toFixed(0)}→${a.residual.force.toFixed(0)}kN`;
      item.appendChild(U.el("div", { class: "emg-log-delta" },
        [dT, dDisp, dR].filter(Boolean).join("　|　")));
      if (ev.cascadedFailures.length)
        item.appendChild(U.el("div", { class: "emg-reason warn-text" },
          "随后级联断缆：" + ev.cascadedFailures.map(f => f.name).join("、")));
      box.appendChild(item);
    }
  },

  deltaLineText(ev, b, a) {
    const lid = ev.target && App.plan.lines.find(l => l.name === ev.target)?.id;
    const pick = ev.type === "tugForce" ? null : (ev.actionId && this.actions.find(x => x.id === ev.actionId)?.lineId);
    const id = pick || lid;
    if (!id) {
      // 拖轮：给出总残余变化即可
      return `残余横向 ${b.residual.fy.toFixed(0)}→${a.residual.fy.toFixed(0)}kN`;
    }
    const ub = (b.util[id] || 0) * 100, ua = (a.util[id] || 0) * 100;
    const tb = b.tensions[id] || 0, ta = a.tensions[id] || 0;
    const arrow = ua > ub + 1 ? "▲" : ua < ub - 1 ? "▼" : "·";
    return `目标缆利用率 ${ub.toFixed(0)}%→${ua.toFixed(0)}% ${arrow}（${tb.toFixed(0)}→${ta.toFixed(0)}kN）`;
  },

  // ------------------------------------------------ 时间轴标记
  markersAt(t) {
    // 返回该时刻的动作（含拒收状态），供 Timeline 绘制
    const rejected = new Set((this.sim?.actionResults || [])
      .filter(r => r.status === "rejected").map(r => r.actionId));
    return this.actions.map(a => ({ id: a.id, t: a.t, type: a.type,
      color: EMG_MARKER_COLOR[a.type], rejected: rejected.has(a.id),
      label: a.type === "tugForce" ? (a.name || "拖轮") : this.lineName(a.lineId),
      duration: a.type === "tugForce" ? a.duration : 0 }));
  },

  hitMarker(xPos, timeline) {
    // 由 Timeline 在动作行内调用：xPos 为屏幕 x
    if (!this.actions.length) return null;
    const r = timeline.canvas.getBoundingClientRect();
    const w = timeline.canvas.clientWidth, pad = 44;
    const t = ((xPos - r.left - pad) / (w - pad * 2)) * App.scenario.duration;
    let best = null, bd = 0.06 * App.scenario.duration / (w - pad * 2) * w + 8;
    for (const a of this.actions) {
      const ax = pad + (a.t / App.scenario.duration) * (w - pad * 2);
      if (Math.abs(ax - xPos) < bd) { bd = Math.abs(ax - xPos); best = a; }
    }
    return best;
  },
};

Object.assign(window, { Emergency, EMG_TYPES, EMG_MARKER_COLOR });
