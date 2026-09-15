// 全局状态与几何计算
const App = {
  scenario: null,   // 当前编辑中的场景（含 ship/bollards/env）
  plan: null,       // 当前编辑中的方案（含 lines）
  planList: [],     // 该场景下方案元数据 [{id,name}]
  sim: null,        // 当前方案最新仿真结果 {steps,summary}
  selectedLineId: null,
  playMode: false,  // 是否正在/曾经播放（影响画布叠加层）
};

// ------------------------------------------------ 几何（世界坐标 m）
const G = {
  fairleadWorld(local, st) {
    const [lx, ly] = local;
    const psi = st.psi;
    const c = Math.cos(psi), s = Math.sin(psi);
    return { x: st.x + lx * c - ly * s, y: st.y + lx * s + ly * c };
  },
  currentState() {
    const sh = App.scenario.ship;
    return { x: sh.x, y: sh.y, psi: sh.psi0 || 0 };
  },
  fairleadZ(line) {
    const f = App.scenario.ship.fairleads.find(f => f.id === line.fairleadId);
    return line.fairleadZ ?? f?.z ?? 3.5;
  },
  bollardZ(line) {
    const b = App.scenario.bollards.find(b => b.id === line.bollardId);
    return b?.z ?? 4.0;
  },
  // 当前潮位下桩-导缆孔高差（桩高 − 孔高 − 潮位）
  lineDz(line, tide = 0) {
    return this.bollardZ(line) - this.fairleadZ(line) - tide;
  },
  // 取缆绳当前两端世界坐标（用于绘制/命中）
  lineEndpoints(line, st, tide = 0) {
    const fl = App.scenario.ship.fairleads.find(f => f.id === line.fairleadId);
    const local = line.local || [fl.x, fl.y];
    const p = this.fairleadWorld(local, st);
    const b = App.scenario.bollards.find(b => b.id === line.bollardId);
    return { p, b, dz: this.lineDz(line, tide) };
  },
  // 安装时刻（初始船位、初始潮位）三维几何缆长
  lineLength(line) {
    const st = this.currentState();
    const tide0 = (App.scenario.env?.[0]?.tide) ?? 0;
    const { p, b, dz } = this.lineEndpoints(line, st, tide0);
    return Math.hypot(Math.hypot(b.x - p.x, b.y - p.y), dz);
  },
};

// 规整场景/方案，补齐缺省字段（便于新建对象；不覆盖已有值）
function ensureDefaults() {
  const sc = App.scenario;
  sc.ship = sc.ship || {};
  const shipDefaults = {
    L: 150, B: 28, x: 0, y: 0, psi0: 0, berthY: -16, fenderMax: 800,
    fenderSpacing: 30, windArm: 8, currArm: 4, surfX: 130, surfY: 58, fairleads: [],
  };
  for (const [k, v] of Object.entries(shipDefaults)) {
    if (sc.ship[k] === undefined || sc.ship[k] === null) sc.ship[k] = v;
  }
  sc.bollards = sc.bollards || [];
  for (const b of sc.bollards) if (b.z === undefined) b.z = 4.0;
  sc.env = sc.env || [];
  sc.duration = sc.duration ?? 6;
  sc.dt = sc.dt ?? 0.2;
  sc.fenderK = sc.fenderK ?? 30000;
  sc.imbaThreshold = sc.imbaThreshold ?? 40;
  App.plan.lines = (App.plan.lines || []).map(l => ({
    autoLength: true, pretension: 100, active: true, k: 50000,
    safeLoad: 700, ...l,
  }));
}

// 调后端求解当前方案
async function simulateCurrent() {
  if (!App.scenario || !App.plan) return;
  App.sim = await U.api("/api/simulate", {
    method: "POST",
    body: { scenario: App.scenario, plan: App.plan },
  });
  return App.sim;
}

Object.assign(window, { App, G, ensureDefaults, simulateCurrent });
