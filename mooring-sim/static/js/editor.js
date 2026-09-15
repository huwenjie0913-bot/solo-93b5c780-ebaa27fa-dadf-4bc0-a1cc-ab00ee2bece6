// ============ 编辑交互：画布拖放 + 侧栏表单 ============
const Editor = {
  canvas: null, ctx: null, vp: null,
  drag: null,          // {kind,id,startWorld,offset}
  connecting: null,    // 引线模式 {lineId|null,fairleadId,type}
  suppressSim: false,

  init() {
    if (!this.canvas) {
      this.canvas = U.$("#planCanvas");
      this.ctx = this.canvas.getContext("2d");
      this.bindCanvas();
      this.bindPanel();
      window.addEventListener("resize", () => this.redraw());
    }
    this.vp = this.vp || new Viewport(this.canvas);
    this.fitAll();
  },

  worldBox() {
    const sc = App.scenario;
    let xs = sc.bollards.map(b => b.x), ys = sc.bollards.map(b => b.y);
    xs.push(sc.ship.x - sc.ship.L / 2, sc.ship.x + sc.ship.L / 2);
    ys.push(sc.ship.y - sc.ship.B, sc.ship.y + sc.ship.B, sc.ship.berthY);
    return { xmin: Math.min(...xs) - 30, xmax: Math.max(...xs) + 30,
             ymin: Math.min(...ys) - 30, ymax: Math.max(...ys) + 30 };
  },
  fitAll() { this.vp.fit(this.worldBox(), 50); this.redraw(); },

  redraw() {
    if (!this.canvas || !App.scenario || !App.plan) return;
    resizeCanvasToDisplay(this.canvas);
    const emgSim = window.Emergency ? Emergency.activeSim() : null;
    const step = emgSim ? currentSimStep(emgSim) : (App.sim ? currentSimStep(App.sim) : null);
    drawScene({ ctx: this.ctx, vp: this.vp, scenario: App.scenario,
      plan: App.plan, step, selectedLineId: App.selectedLineId,
      dimmed: false });
    this.drawTugArrows(step);
    // 引线模式的橡皮筋
    if (this.connecting && this.connecting.mouse) {
      const fl = App.scenario.ship.fairleads.find(f => f.id === this.connecting.fairleadId);
      const st = G.currentState();
      const a = this.vp.toScreen(G.fairleadWorld([fl.x, fl.y], st));
      this.ctx.strokeStyle = "#fff";
      this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y);
      this.ctx.lineTo(this.connecting.mouse.x, this.connecting.mouse.y);
      this.ctx.stroke(); this.ctx.setLineDash([]);
    }
  },

  // 应急拖轮力箭头（俯视图右侧标注当前时刻生效拖轮）
  drawTugArrows(step) {
    if (!step || !step.tugs || !step.tugs.length) return;
    const ctx = this.ctx;
    const W = this.canvas.clientWidth;
    step.tugs.forEach((g, i) => {
      const ox = W - 130, oy = 110 + i * 26;
      const len = 22 + Math.min(22, g.force / 40);
      const dx = Math.cos(g.angle) * len, dy = -Math.sin(g.angle) * len;
      ctx.strokeStyle = "#f5b041"; ctx.fillStyle = "#f5b041"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(ox - dx, oy - dy); ctx.lineTo(ox, oy); ctx.stroke();
      const ang = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox - 8 * Math.cos(ang - 0.4), oy - 8 * Math.sin(ang - 0.4));
      ctx.lineTo(ox - 8 * Math.cos(ang + 0.4), oy - 8 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
      ctx.font = "10px sans-serif";
      ctx.fillText(`${g.name} ${Math.round(g.force)}kN`, ox - 60, oy - 8);
    });
  },

  // ------------------------------------------------ 画布事件
  bindCanvas() {
    const c = this.canvas;
    c.addEventListener("mousedown", e => {
      const s = mousePt(c, e);
      const hit = hitTest(this.vp, App.scenario, App.plan, s);
      if (e.shiftKey) { this.drag = { kind: "pan", start: s, cx: this.vp.cx, cy: this.vp.cy }; return; }
      if (this.connecting) return;  // 引线模式由 click 处理
      if (!hit) return;
      if (hit.kind === "line") { App.selectedLineId = hit.id; this.redraw(); renderPanels(); return; }
      if (hit.kind === "lineEnd") {
        // 拖缆的导缆孔端：改接到其它导缆孔（松手时判定）
        this.drag = { kind: "lineEndMove", id: hit.id, start: s };
        return;
      }
      const w = this.vp.toWorld(s);
      if (hit.kind === "bollard") {
        const b = App.scenario.bollards.find(b => b.id === hit.id);
        this.drag = { kind: "bollard", id: hit.id, dx: b.x - w.x, dy: b.y - w.y };
      } else if (hit.kind === "fairlead") {
        const f = App.scenario.ship.fairleads.find(f => f.id === hit.id);
        this.drag = { kind: "fairlead", id: hit.id, dx: f.x - w.x, dy: f.y - w.y };
      } else if (hit.kind === "ship") {
        this.drag = { kind: "ship", dx: App.scenario.ship.x - w.x, dy: App.scenario.ship.y - w.y };
      }
    });

    window.addEventListener("mousemove", e => {
      const s = mousePt(c, e);
      if (this.connecting) { this.connecting.mouse = s; this.redraw(); return; }
      if (!this.drag) return;
      const w = this.vp.toWorld(s);
      const d = this.drag;
      if (d.kind === "pan") {
        const dw0 = this.vp.toWorld(d.start);
        const dw1 = this.vp.toWorld(s);
        this.vp.cx += dw0.x - dw1.x;
        this.vp.cy += dw0.y - dw1.y;
      } else if (d.kind === "bollard") {
        const b = App.scenario.bollards.find(b => b.id === d.id);
        b.x = Math.round((w.x + d.dx) * 10) / 10;
        b.y = Math.round((w.y + d.dy) * 10) / 10;
      } else if (d.kind === "fairlead") {
        const f = App.scenario.ship.fairleads.find(f => f.id === d.id);
        f.x = U.clamp(Math.round((w.x + d.dx) * 10) / 10, -App.scenario.ship.L / 2, App.scenario.ship.L / 2);
        f.y = U.clamp(Math.round((w.y + d.dy) * 10) / 10, -App.scenario.ship.B / 2, App.scenario.ship.B / 2);
        // 同步挂在该导缆孔上的缆的 local
        for (const l of App.plan.lines) if (l.fairleadId === f.id) l.local = [f.x, f.y];
      } else if (d.kind === "ship") {
        App.scenario.ship.x = Math.round((w.x + d.dx) * 10) / 10;
        App.scenario.ship.y = Math.round((w.y + d.dy) * 10) / 10;
      } else if (d.kind === "lineEndMove") {
        // 寻找最近的导缆孔
        const fl = nearestFairlead(this.vp, App.scenario, s);
        d.hoverFairlead = fl ? fl.id : null;
      }
      this.redraw();
      renderPanels();
    });

    window.addEventListener("mouseup", e => {
      const d = this.drag;
      if (!d) return;
      if (d.kind === "lineEndMove" && d.hoverFairlead) {
        const line = App.plan.lines.find(l => l.id === d.id);
        const f = App.scenario.ship.fairleads.find(x => x.id === d.hoverFairlead);
        line.fairleadId = f.id; line.local = [f.x, f.y];
        line.autoLength = true;
        App.selectedLineId = line.id;
        scheduleSim(); renderPanels();
      } else if (["bollard", "fairlead", "ship"].includes(d.kind)) {
        scheduleSim();
      }
      this.drag = null;
    });

    c.addEventListener("click", e => {
      const s = mousePt(c, e);
      if (this.connecting) {
        const hit = hitTest(this.vp, App.scenario, App.plan, s);
        if (hit && hit.kind === "bollard") this.finishConnect(hit.id);
        else if (hit && hit.kind === "fairlead") {
          // 允许先改起始导缆孔
          this.connecting.fairleadId = hit.id;
          this.redraw();
        }
        return;
      }
    });
    c.addEventListener("dblclick", e => {
      const s = mousePt(c, e);
      const w = this.vp.toWorld(s);
      const hit = hitTest(this.vp, App.scenario, App.plan, s);
      if (!hit) {
        const b = { id: U.uid("b"), name: `${App.scenario.bollards.length + 1}#新桩`,
          x: Math.round(w.x), y: Math.round(w.y), z: 4.0 };
        App.scenario.bollards.push(b);
        renderPanels(); this.redraw(); scheduleSim();
      } else if (hit.kind === "bollard") {
        const b = App.scenario.bollards.find(b => b.id === hit.id);
        const nm = prompt("缆桩名称", b.name);
        if (nm) { b.name = nm; renderPanels(); this.redraw(); }
      }
    });
    c.addEventListener("wheel", e => {
      e.preventDefault();
      const s = mousePt(c, e);
      this.vp.zoomAt(s, e.deltaY < 0 ? 1.12 : 0.89);
      this.redraw();
    }, { passive: false });

    U.$("#zoomIn").onclick = () => { this.vp.zoomAt(centerPx(this.canvas), 1.2); this.redraw(); };
    U.$("#zoomOut").onclick = () => { this.vp.zoomAt(centerPx(this.canvas), 0.83); this.redraw(); };
    U.$("#zoomFit").onclick = () => this.fitAll();
  },

  startConnect(type) {
    if (!App.scenario.ship.fairleads.length) { alert("请先在船舶上设置导缆孔"); return; }
    this.connecting = { type, fairleadId: App.scenario.ship.fairleads[0].id, mouse: null };
    this.canvas.style.cursor = "crosshair";
  },
  finishConnect(bollardId) {
    const f = App.scenario.ship.fairleads.find(x => x.id === this.connecting.fairleadId);
    const line = {
      id: U.uid("l"),
      name: nextLineName(App.plan, this.connecting.type),
      type: this.connecting.type,
      fairleadId: f.id, bollardId, local: [f.x, f.y],
      length: 0, k: 50000, safeLoad: 700, pretension: 100,
      autoLength: true, active: true,
    };
    line.length = G.lineLength(line);
    App.plan.lines.push(line);
    App.selectedLineId = line.id;
    this.connecting = null;
    this.redraw(); renderPanels(); scheduleSim();
  },

  // ------------------------------------------------ 侧栏
  bindPanel() {
    U.$$(".tab").forEach(t => t.addEventListener("click", () => {
      U.$$(".tab").forEach(x => x.classList.remove("active"));
      U.$$(".tab-panel").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      U.$(`.tab-panel[data-panel="${t.dataset.tab}"]`).classList.add("active");
    }));
    U.$("#btnAddLine").onclick = () => this.startConnect(U.$("#newLineType").value);
    U.$("#btnAddBollard").onclick = () => {
      const sh = App.scenario.ship;
      App.scenario.bollards.push({ id: U.uid("b"),
        name: `${App.scenario.bollards.length + 1}#桩`,
        x: U.clamp(sh.L / 2 + 20, -200, 200), y: sh.berthY - 8, z: 4.0 });
      renderPanels(); this.redraw(); scheduleSim();
    };
    U.$("#btnAddEnv").onclick = () => {
      const env = App.scenario.env;
      const last = env[env.length - 1] || { tide: 0, windDir: Math.PI / 2, windSpeed: 10,
        currentSpeed: 1, draft: 10, areaX: 400, areaY: 2000 };
      env.push({ ...last, t: (last.t || 0) + 1 });
      renderPanels(); scheduleSim();
    };
    this.bindShipForm();
  },

  bindShipForm() {
    const map = [
      ["shipName", "name", "text"], ["shipL", "L", "num"], ["shipB", "B", "num"],
      ["shipX", "x", "num"], ["shipY", "y", "num"], ["berthY", "berthY", "num"],
      ["windArm", "windArm", "num"], ["currArm", "currArm", "num"],
    ];
    for (const [id, key, typ] of map) {
      U.$("#" + id).addEventListener("input", e => {
        App.scenario.ship[key] = typ === "num" ? parseFloat(e.target.value) || 0 : e.target.value;
        this.redraw(); scheduleSim();
      });
    }
    for (const [id, key] of [["duration", "duration"], ["dt", "dt"],
      ["fenderK", "fenderK"], ["fenderMax", "fenderMax"],
      ["fenderSpacing", "fenderSpacing"], ["imbaThreshold", "imbaThreshold"]]) {
      U.$("#" + id).addEventListener("input", e => {
        const v = parseFloat(e.target.value) || 0;
        if (key === "fenderK") App.scenario[key] = v;
        else if (key === "duration" || key === "dt" || key === "imbaThreshold") App.scenario[key] = v;
        else App.scenario.ship[key] = v;
        this.redraw(); scheduleSim();
      });
    }
  },
};

// ------------------------------------------------ 辅助
function mousePt(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function centerPx(canvas) {
  return { x: (canvas.clientWidth || canvas.width) / 2, y: (canvas.clientHeight || canvas.height) / 2 };
}
function nearestFairlead(vp, scenario, s) {
  const st = G.currentState();
  let best = null, bd = 12;
  for (const f of scenario.ship.fairleads) {
    const p = vp.toScreen(G.fairleadWorld([f.x, f.y], st));
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
function nextLineName(plan, type) {
  const n = plan.lines.filter(l => l.type === type).length + 1;
  return U.lineTypeName(type) + n;
}
function resizeCanvasToDisplay(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ============ 侧栏渲染 ============
function renderPanels() {
  if (!App.scenario || !App.plan) return;
  renderLineTable();
  renderLineDetail();
  renderEnvTable();
  renderShipPanel();
  renderResultPanel();
}

function renderLineTable() {
  const tb = U.$("#lineTable tbody");
  tb.innerHTML = "";
  const sim = window.Emergency && Emergency.activeSim() ? Emergency.activeSim() : App.sim;
  const step = sim ? currentSimStep(sim) : null;
  for (const l of App.plan.lines) {
    const b = App.scenario.bollards.find(b => b.id === l.bollardId);
    const u = step ? (step.util[l.id] || 0) : null;
    const failed = step && step.failed[l.id];
    const geoLen = G.lineLength(l);
    const lengthCell = l.autoLength === false
      ? numTd(l, "length", 6, true)
      : U.el("td", { class: "muted", title: "按几何自动计算；详情面板可改为手填" },
          geoLen.toFixed(1));
    const tr = U.el("tr", { class: l.id === App.selectedLineId ? "sel" : "",
      onclick: () => { App.selectedLineId = l.id; renderPanels(); Editor.redraw(); } }, [
      U.el("td", {}, l.name),
      U.el("td", {}, U.lineTypeName(l.type)),
      U.el("td", {}, b ? b.name : "?"),
      lengthCell,
      numTd(l, "k", 7),
      numTd(l, "safeLoad", 6),
      numTd(l, "pretension", 6),
      U.el("td", { class: "util-cell", style: u == null ? "" : `color:${failed ? "#e74c3c" : U.utilColor(u)}` },
        u == null ? "" : (failed ? "断" : Math.round(u * 100) + "%")),
    ]);
    if (l.active === false) tr.style.opacity = .4;
    tb.appendChild(tr);
  }
}
function numTd(line, key, width, enabled = true) {
  const inp = U.el("input", { type: "number",
    value: Math.round((line[key] || 0) * 100) / 100,
    style: `width:${width}px`,
    disabled: enabled ? null : "" });
  inp.addEventListener("click", e => e.stopPropagation());
  inp.addEventListener("input", e => {
    line[key] = parseFloat(e.target.value) || 0;
    if (key === "length") line.autoLength = false;
    scheduleSim();
  });
  return U.el("td", {}, [inp]);
}

function renderLineDetail() {
  const box = U.$("#lineDetail");
  const l = App.plan.lines.find(x => x.id === App.selectedLineId);
  if (!l) { box.innerHTML = '<p class="muted">点击画布或表格中的缆绳编辑；取消勾选"启用"可停用某根缆。</p>'; return; }
  const bollards = App.scenario.bollards;
  const fls = App.scenario.ship.fairleads;
  const autoLen = G.lineLength(l);
  box.innerHTML = "";
  box.appendChild(U.el("h4", {}, `缆绳：${l.name}`));
  const row = (label, node) => U.el("div", { style: "display:flex;align-items:center;gap:8px;margin:6px 0" },
    [U.el("label", { style: "width:96px;color:var(--muted)" }, label), node]);

  const nameI = U.el("input", { type: "text", value: l.name });
  nameI.oninput = e => { l.name = e.target.value; renderLineTable(); scheduleSim(); };
  box.appendChild(row("名称", nameI));

  const typeS = U.el("select", {}, ["head", "stern", "breast", "spring"].map(t =>
    U.el("option", { value: t, selected: l.type === t ? "" : null }, U.lineTypeName(t))));
  typeS.onchange = e => { l.type = e.target.value; renderLineTable(); Editor.redraw(); };
  box.appendChild(row("类型", typeS));

  const flS = U.el("select", {}, fls.map(f =>
    U.el("option", { value: f.id, selected: l.fairleadId === f.id ? "" : null }, f.name)));
  flS.onchange = e => {
    const f = fls.find(x => x.id === e.target.value);
    l.fairleadId = f.id; l.local = [f.x, f.y]; l.autoLength = true;
    renderPanels(); Editor.redraw(); scheduleSim();
  };
  box.appendChild(row("导缆孔", flS));

  const bS = U.el("select", {}, bollards.map(b =>
    U.el("option", { value: b.id, selected: l.bollardId === b.id ? "" : null }, b.name)));
  bS.onchange = e => { l.bollardId = e.target.value; l.autoLength = true; renderPanels(); Editor.redraw(); scheduleSim(); };
  box.appendChild(row("缆桩", bS));

  const autoC = U.el("input", { type: "checkbox" });
  autoC.checked = l.autoLength !== false;
  const lenI = U.el("input", { type: "number", value: Math.round(l.length * 100) / 100, disabled: autoC.checked ? "" : null, step: "0.1" });
  autoC.onchange = () => {
    l.autoLength = autoC.checked;
    if (autoC.checked) l.length = autoLen;
    renderPanels(); scheduleSim();
  };
  lenI.oninput = e => { l.length = parseFloat(e.target.value) || 0; l.autoLength = false; autoC.checked = false; scheduleSim(); };
  box.appendChild(row("安装缆长 m", U.el("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" },
    [autoC, U.el("span", { class: "muted", style: "font-size:11px" }, "按几何"), lenI,
     U.el("span", { class: "muted", style: "font-size:11px" },
       `初始几何 ${autoLen.toFixed(1)}（含潮位高差）`)])));
  box.appendChild(U.el("p", { class: "muted", style: "font-size:10.5px;margin:2px 0 6px" },
    "手填长度为安装时两系点间的实际缆长；缩短会增大初始应变/张力并使缆更早超载，加长超过几何长度则初始松弛。"));

  for (const [label, key] of [["刚度 kN/m", "k"], ["安全载荷 kN", "safeLoad"], ["预张力 kN", "pretension"]]) {
    const i = U.el("input", { type: "number", value: l[key], style: "width:130px" });
    i.oninput = e => { l[key] = parseFloat(e.target.value) || 0; renderLineTable(); scheduleSim(); };
    box.appendChild(row(label, i));
  }
  const actC = U.el("input", { type: "checkbox" });
  actC.checked = l.active !== false;
  actC.onchange = () => { l.active = actC.checked; renderPanels(); Editor.redraw(); scheduleSim(); };
  box.appendChild(row("启用该缆", actC));

  const del = U.el("button", { class: "btn small danger", onclick: () => {
      App.plan.lines = App.plan.lines.filter(x => x.id !== l.id);
      App.selectedLineId = null; renderPanels(); Editor.redraw(); scheduleSim();
    } }, "删除该缆绳");
  box.appendChild(U.el("div", { style: "margin-top:8px" }, [del]));
}

function renderEnvTable() {
  const sc = App.scenario;
  U.$("#duration").value = sc.duration;
  U.$("#dt").value = sc.dt;
  U.$("#fenderK").value = sc.fenderK;
  U.$("#fenderMax").value = sc.ship.fenderMax ?? 800;
  U.$("#fenderSpacing").value = sc.ship.fenderSpacing ?? 30;
  U.$("#imbaThreshold").value = sc.imbaThreshold;
  const tb = U.$("#envTable tbody");
  tb.innerHTML = "";
  sc.env.forEach((env, i) => {
    const mk = (key, val, isDeg) => U.el("input", {
      type: "number", step: "any", value: val,
      oninput: e => {
        let v = parseFloat(e.target.value) || 0;
        env[key] = isDeg ? U.rad(v) : v;
        scheduleSim();
      } });
    const tr = U.el("tr", {}, [
      U.el("td", {}, [mk("t", env.t)]),
      U.el("td", {}, [mk("tide", env.tide)]),
      U.el("td", {}, [mk("windDir", U.fmt(U.deg(env.windDir), 0), true)]),
      U.el("td", {}, [mk("windSpeed", env.windSpeed)]),
      U.el("td", {}, [mk("currentSpeed", env.currentSpeed)]),
      U.el("td", {}, [mk("draft", env.draft)]),
      U.el("td", {}, [mk("areaX", env.areaX)]),
      U.el("td", {}, [mk("areaY", env.areaY)]),
      U.el("td", {}, [U.el("button", { class: "btn small danger", onclick: () => {
          sc.env.splice(i, 1); renderPanels(); scheduleSim(); } }, "×")]),
    ]);
    tb.appendChild(tr);
  });
}

function renderShipPanel() {
  const sh = App.scenario.ship;
  const vals = { shipName: sh.name, shipL: sh.L, shipB: sh.B, shipX: sh.x, shipY: sh.y,
    berthY: sh.berthY, windArm: sh.windArm, currArm: sh.currArm };
  for (const [id, v] of Object.entries(vals)) {
    const el = U.$("#" + id);
    if (document.activeElement !== el) el.value = v;
  }
  // 导缆孔（局部 x/y + 高程 z，潮位通过桩-孔高差影响缆长）
  const fl = U.$("#fairleadList");
  fl.innerHTML = "";
  sh.fairleads.forEach((f, i) => {
    const xI = U.el("input", { type: "number", value: f.x, style: "width:60px" });
    const yI = U.el("input", { type: "number", value: f.y, style: "width:60px" });
    const zI = U.el("input", { type: "number", value: f.z ?? 3.5, step: "0.1", style: "width:52px", title: "高程 m（潮位基准）" });
    xI.oninput = e => { f.x = U.clamp(parseFloat(e.target.value) || 0, -sh.L / 2, sh.L / 2);
      App.plan.lines.filter(l => l.fairleadId === f.id).forEach(l => l.local = [f.x, f.y]);
      Editor.redraw(); scheduleSim(); };
    yI.oninput = e => { f.y = U.clamp(parseFloat(e.target.value) || 0, -sh.B / 2, sh.B / 2);
      App.plan.lines.filter(l => l.fairleadId === f.id).forEach(l => l.local = [f.x, f.y]);
      Editor.redraw(); scheduleSim(); };
    zI.oninput = e => { f.z = parseFloat(e.target.value) || 0; scheduleSim(); };
    fl.appendChild(U.el("div", { style: "display:flex;gap:4px;align-items:center;margin:4px 0;flex-wrap:wrap" },
      [U.el("span", { style: "width:44px;color:var(--muted)" }, f.name),
       U.el("span", { class: "muted", style: "font-size:10px" }, "x"), xI,
       U.el("span", { class: "muted", style: "font-size:10px" }, "y"), yI,
       U.el("span", { class: "muted", style: "font-size:10px" }, "z高"), zI,
       U.el("button", { class: "btn small danger", onclick: () => {
         if (App.plan.lines.some(l => l.fairleadId === f.id)) { alert("该导缆孔上还接有缆绳"); return; }
         sh.fairleads.splice(i, 1); renderPanels(); Editor.redraw(); } }, "×")]));
  });
  if (!sh.fairleads.length) {
    fl.appendChild(U.el("button", { class: "btn small", onclick: () => {
      sh.fairleads.push({ id: U.uid("f"), name: "导缆孔" + (sh.fairleads.length + 1),
        x: sh.L / 2 - 5, y: -sh.B / 2 + 4, z: 3.5 });
      renderPanels(); Editor.redraw(); } }, "＋ 添加导缆孔"));
  }
  // 缆桩列表（平面 x/y + 高程 z）
  const bl = U.$("#bollardList");
  bl.innerHTML = "";
  App.scenario.bollards.forEach((b, i) => {
    const xI = U.el("input", { type: "number", value: b.x, style: "width:60px" });
    const yI = U.el("input", { type: "number", value: b.y, style: "width:60px" });
    const zI = U.el("input", { type: "number", value: b.z ?? 4.0, step: "0.1", style: "width:52px", title: "桩顶高程 m" });
    xI.oninput = e => { b.x = parseFloat(e.target.value) || 0; Editor.redraw(); scheduleSim(); };
    yI.oninput = e => { b.y = parseFloat(e.target.value) || 0; Editor.redraw(); scheduleSim(); };
    zI.oninput = e => { b.z = parseFloat(e.target.value) || 0; scheduleSim(); };
    bl.appendChild(U.el("div", { style: "display:flex;gap:4px;align-items:center;margin:4px 0;flex-wrap:wrap" },
      [U.el("span", { style: "width:44px;color:var(--muted)" }, b.name),
       U.el("span", { class: "muted", style: "font-size:10px" }, "x"), xI,
       U.el("span", { class: "muted", style: "font-size:10px" }, "y"), yI,
       U.el("span", { class: "muted", style: "font-size:10px" }, "z高"), zI,
       U.el("button", { class: "btn small danger", onclick: () => {
         if (App.plan.lines.some(l => l.bollardId === b.id)) { alert("该缆桩上还接有缆绳"); return; }
         App.scenario.bollards.splice(i, 1); renderPanels(); Editor.redraw(); } }, "×")]));
  });
}

function renderResultPanel() {
  const box = U.$("#resultPanel");
  const emgSim = window.Emergency ? Emergency.activeSim() : null;
  const sim = emgSim || App.sim;
  if (!sim) { box.innerHTML = '<p class="muted">求解中…</p>'; return; }
  const s = sim.summary;
  const step = currentSimStep(sim);
  const balBadge = s.balanced
    ? '<span class="badge ok">全程平衡</span>'
    : '<span class="badge bad">出现失衡/断缆</span>';
  const emgBadge = emgSim
    ? `<span class="badge warn">应急推演（${s.nActions || 0}动作${s.nRejected ? `，${s.nRejected}条拒收` : ""}）</span>`
    : "";
  let html = `<div class="kpi-grid">
    <div class="kpi"><div class="k">结论</div><div class="v">${balBadge} ${emgBadge}</div></div>
    <div class="k"><div class="k">最早失衡时刻</div><div class="v">${s.firstImbalance == null ? "—" : s.firstImbalance.toFixed(2) + " h"}</div></div>
    <div class="k"><div class="k">首先失效缆绳</div><div class="v" style="font-size:14px">${s.firstFailure ? s.firstFailure.name + " @ " + s.firstFailure.time.toFixed(2) + "h" : "—"}</div></div>
    <div class="k"><div class="k">最大残余载荷</div><div class="v">${s.maxResidual.toFixed(0)} kN</div></div>
    <div class="k"><div class="k">最大船位偏移</div><div class="v">${s.maxDisplacement.toFixed(2)} m</div></div>
    <div class="k"><div class="k">当前主导载荷</div><div class="v" style="font-size:14px">${step.dominant} ${step.dominantMag.toFixed(0)}kN</div></div>
  </div>`;
  if (emgSim && step.tugs && step.tugs.length) {
    html += `<p class="muted" style="margin:4px 0">当前时刻生效拖轮：${step.tugs.map(g =>
      `${g.name} ${Math.round(g.force)}kN（${g.t0.toFixed(1)}–${g.t1.toFixed(1)}h）`).join("、")}</p>`;
  }
  html += `<h4>当前时刻各缆利用率（t=${step.t.toFixed(2)}h，潮位 ${step.env.tide.toFixed(2)}m）</h4>`;
  for (const l of App.plan.lines) {
    const u = step.util[l.id] || 0, T = step.tensions[l.id] || 0;
    const failed = step.failed[l.id];
    const inactive = (step.active?.[l.id] === false) && l.active === false;
    const strain = step.strain?.[l.id] ?? 0;
    const va = step.vAngle?.[l.id] ?? 0;
    let detail;
    if (inactive) detail = "停用";
    else if (failed) detail = "已失效";
    else detail = `${T.toFixed(0)}kN · ${(u * 100).toFixed(0)}% · ε${(strain * 100).toFixed(2)}% · 仰角${va.toFixed(1)}°`;
    html += `<div class="bar-row"><span class="nm">${l.name}</span>
      <span class="bar"><i style="width:${U.clamp(u, 0, 1) * 100}%;background:${failed ? "#e74c3c" : U.utilColor(u)}"></i></span>
      <span class="val" style="width:172px;font-size:10px">${detail}</span></div>`;
  }
  html += `<h4>当前未平衡载荷</h4>
    <p>横向残余 ${step.residual.fy.toFixed(0)} kN ｜ 纵向残余 ${step.residual.fx.toFixed(0)} kN ｜
    残余力矩 ${step.residual.m.toFixed(0)} kN·m ｜ 合力 ${step.residual.force.toFixed(0)} kN</p>`;
  box.innerHTML = html;
}

// 防频繁求解
const scheduleSim = U.debounce(async () => {
  try {
    await simulateCurrent();
    Editor.redraw();
    Timeline.redraw();
    renderResultPanel();
    renderLineTable();
  } catch (err) {
    U.$("#resultPanel").innerHTML = `<p class="badge bad">${err.message}</p>`;
  }
}, 350);

Object.assign(window, { Editor, renderPanels, renderLineTable, renderLineDetail,
  renderEnvTable, renderShipPanel, renderResultPanel, scheduleSim });
