// 启动、场景/方案管理、自动保存
async function persistCurrent(force = false) {
  if (!App.scenario) return;
  await U.api("/api/scenarios", { method: "POST", body: App.scenario });
  if (App.plan && App.plan.id) {
    App.plan.scenarioId = App.scenario.id;
    await U.api("/api/plans", { method: "POST", body: App.plan });
  }
  setState("已保存");
}
const autosave = U.debounce(() => persistCurrent().catch(() => {}), 1200);

function setState(txt) {
  const el = U.$("#saveState");
  el.textContent = txt;
  if (txt === "已保存") setTimeout(() => { if (el.textContent === "已保存") el.textContent = ""; }, 1500);
}

async function loadScenario(id) {
  App.scenario = await U.api("/api/scenarios/" + id);
  const plans = await U.api(`/api/scenarios/${id}/plans`);
  App.planList = plans;
  if (!plans.length) {
    App.plan = { scenarioId: id, name: "新方案", lines: [] };
    App.plan.id = await savePlan(App.plan);
  } else {
    App.plan = await U.api("/api/plans/" + plans[0].id);
  }
  ensureDefaults();
  Editor.init();
  Player.setTime(0);
  await simulateCurrent();
  refreshAllSelectors();
  renderPanels();
  Timeline.redraw();
}

async function savePlan(plan) {
  const res = await U.api("/api/plans", { method: "POST", body: plan });
  return res.id;
}

async function switchPlan(id) {
  App.plan = await U.api("/api/plans/" + id);
  ensureDefaults();
  App.selectedLineId = null;
  Player.setTime(0);
  await simulateCurrent();
  renderPanels();
  Editor.redraw();
  Timeline.redraw();
}

function refreshAllSelectors() {
  const scSel = U.$("#scenarioSelect");
  scSel.innerHTML = "";
  listAllScenarios().then(list => {
    list.forEach(s => scSel.appendChild(U.el("option", { value: s.id,
      selected: s.id === App.scenario.id ? "" : null }, s.name)));
  });
  refreshPlanSelector();
}
function refreshPlanSelector() {
  const sel = U.$("#planSelect");
  sel.innerHTML = "";
  App.planList.forEach(p => sel.appendChild(U.el("option", { value: p.id,
    selected: p.id === App.plan.id ? "" : null }, p.name)));
}
async function listAllScenarios() { return await U.api("/api/scenarios"); }

// 初始化编辑器拖拽后需要触发保存
function hookAutosave() {
  // scheduleSim 已处理求解；额外自动保存场景与方案
  const orig = scheduleSim;
  // 简单方式：定时检查脏状态
}

async function init() {
  Timeline.init();
  Player.init();
  Compare.init();
  Brief.init();

  const list = await listAllScenarios();
  await loadScenario(list[0].id);

  U.$("#scenarioSelect").onchange = e => loadScenario(e.target.value);
  U.$("#planSelect").onchange = e => switchPlan(e.target.value);

  U.$("#btnSaveScenario").onclick = async () => {
    await persistCurrent(true);
    App.planList = await U.api(`/api/scenarios/${App.scenario.id}/plans`);
    refreshPlanSelector();
  };

  U.$("#btnNewScenario").onclick = async () => {
    const name = prompt("新场景名称", "新靠泊场景");
    if (!name) return;
    const L = 150, B = 26;
    const sc = {
      name, duration: 6, dt: 0.2, fenderK: 30000, imbaThreshold: 30,
      ship: {
        name: "新船", L, B, x: 0, y: 0, psi0: 0, berthY: -15, fenderMax: 800,
        windArm: 8, currArm: 4, surfX: 130, surfY: 58,
        fairleads: [
          { id: "f_bow", name: "船首", x: L / 2 - 4, y: -B / 2 + 4 },
          { id: "f_stern", name: "船尾", x: -L / 2 + 4, y: -B / 2 + 4 },
        ],
      },
      bollards: [
        { id: "b1", name: "1#桩", x: -L / 2 - 30, y: -24 },
        { id: "b2", name: "2#桩", x: 0, y: -24 },
        { id: "b3", name: "3#桩", x: L / 2 + 30, y: -24 },
      ],
      env: [
        { t: 0, tide: 2, windDir: Math.PI / 2, windSpeed: 12, currentSpeed: 1.5,
          currentDir: 0, draft: 10, areaX: 400, areaY: 2200 },
        { t: 6, tide: -3, windDir: Math.PI / 2, windSpeed: 26, currentSpeed: 2,
          currentDir: 0, draft: 11.5, areaX: 420, areaY: 2400 },
      ],
    };
    const sid = await U.api("/api/scenarios", { method: "POST", body: sc });
    const plan = { scenarioId: sid, name: "方案1", lines: [] };
    const pid = await savePlan(plan);
    const sel = U.$("#scenarioSelect");
    await listAllScenarios().then(ls => {
      sel.innerHTML = "";
      ls.forEach(s => sel.appendChild(U.el("option", { value: s.id }, s.name)));
      sel.value = sid;
    });
    await loadScenario(sid);
    switchPlan(pid);
  };

  U.$("#btnNewPlan").onclick = async () => {
    const name = prompt("新方案名称", App.plan.name + " 副本");
    if (!name) return;
    const copy = JSON.parse(JSON.stringify(App.plan));
    delete copy.id; copy.name = name;
    copy.lines.forEach(l => { l.id = U.uid("l"); });
    copy.scenarioId = App.scenario.id;
    copy.id = await savePlan(copy);
    App.planList = await U.api(`/api/scenarios/${App.scenario.id}/plans`);
    refreshPlanSelector();
    U.$("#planSelect").value = copy.id;
    switchPlan(copy.id);
  };
  U.$("#btnDuplicatePlan").onclick = U.$("#btnNewPlan").onclick;

  U.$("#btnDeletePlan").onclick = async () => {
    if (!confirm("删除当前方案？")) return;
    await U.api("/api/plans/" + App.plan.id, { method: "DELETE" });
    App.planList = await U.api(`/api/scenarios/${App.scenario.id}/plans`);
    if (!App.planList.length) {
      const p = { scenarioId: App.scenario.id, name: "新方案", lines: [] };
      p.id = await savePlan(p); App.planList = [{ id: p.id, name: p.name }];
    }
    await switchPlan(App.planList[0].id);
    refreshPlanSelector();
  };

  // 编辑后自动保存（轮询输入变化代价大；这里在求解成功后顺带保存）
  setInterval(() => {
    if (App.scenario && App.plan && App.plan.id) autosave();
  }, 4000);
}

// 求解完成后自动保存（封装在 scheduleSim 链外，用 Mutation 不可靠；直接定时 + 手动保存按钮）
init().catch(err => alert("启动失败: " + err.message));
