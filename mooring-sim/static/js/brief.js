// 生成可打印的靠泊简报（新窗口调用浏览器打印）
const Brief = {
  init() { U.$("#btnPrint").onclick = () => this.print(); },

  async print() {
    await persistCurrent(true);
    // 确保有最新仿真
    let sim = App.sim;
    if (!sim) sim = await U.api("/api/simulate", { method: "POST",
      body: { scenario: App.scenario, plan: App.plan } });

    const sc = App.scenario, plan = App.plan, s = sim.summary;
    const now = new Date();
    const win = window.open("", "_blank");

    // 俯视图快照
    const snap = Editor.canvas.toDataURL("image/png");
    // 时间轴快照（临时把播放头置到最早失衡处）
    const tSnap = s.firstImbalance ?? s.firstFailure?.time ?? sc.duration;
    Player.setTime(tSnap);
    await new Promise(r => setTimeout(r, 60));
    Timeline.redraw();
    const tlSnap = U.$("#timelineCanvas").toDataURL("image/png");

    const envRows = sc.env.map(e => `<tr>
      <td>${e.t.toFixed(1)}</td><td>${e.tide.toFixed(2)}</td>
      <td>${U.fmt(U.deg(e.windDir), 0)}°</td><td>${e.windSpeed.toFixed(1)}</td>
      <td>${e.currentSpeed.toFixed(2)}</td><td>${e.draft.toFixed(1)}</td>
      <td>${e.areaX.toFixed(0)}</td><td>${e.areaY.toFixed(0)}</td></tr>`).join("");

    const lineRows = plan.lines.map(l => {
      const b = sc.bollards.find(b => b.id === l.bollardId);
      const u = s.maxUtil[l.id] || 0;
      const cls = u >= 1 ? "bad" : u >= 0.9 ? "bad" : u >= 0.7 ? "" : "ok";
      const lenMode = l.autoLength === false ? "手填" : "几何";
      // 峰值应变（从步骤中取该缆最大应变）
      let maxStrain = 0;
      for (const st of sim.steps) if (st.strain?.[l.id] != null) maxStrain = Math.max(maxStrain, st.strain[l.id]);
      return `<tr>
        <td>${l.name}</td><td>${U.lineTypeName(l.type)}</td>
        <td>${b ? b.name : "—"}</td>
        <td>${l.length.toFixed(1)}<br><span style="color:#777;font-size:10px">${lenMode}</span></td>
        <td>${l.k.toFixed(0)}</td>
        <td>${l.safeLoad.toFixed(0)}</td><td>${l.pretension.toFixed(0)}</td>
        <td class="${cls}">${(u * 100).toFixed(0)}%</td>
        <td>${(maxStrain * 100).toFixed(2)}%</td>
        <td>${s.maxUtilTime[l.id]?.toFixed(2) ?? "—"}</td>
        <td>${l.active === false ? "停用" : "在用"}</td></tr>`;
    }).join("");

    const verdict = s.balanced
      ? `<b class="ok">结论：在设定的分时风/流/潮工况下，本方案全程保持平衡，无缆绳越过安全载荷。</b>`
      : `<b class="bad">结论：本方案于 ${s.firstImbalance ?? "—"}h 出现未平衡载荷；
         首先失效缆绳为「${s.firstFailure?.name}」（${s.firstFailure?.time.toFixed(2)}h），
         其后系缆受力重分配，最大残余载荷 ${s.maxResidual.toFixed(0)} kN，最大船位偏移 ${s.maxDisplacement.toFixed(2)} m。</b>`;

    win.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>靠泊简报 - ${sc.name}</title>
<style>
  body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#000;font-size:12px;padding:24px;max-width:900px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;border-bottom:1px solid #888;margin:16px 0 6px}
  table{border-collapse:collapse;width:100%;font-size:11px;margin:4px 0}
  th,td{border:1px solid #999;padding:3px 5px;text-align:left}
  .ok{color:#1a7f37}.bad{color:#c0392b;font-weight:700}
  .hd{display:flex;justify-content:space-between;color:#444}
  img{border:1px solid #999;max-width:100%}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 20px}
</style></head><body>
<div class="hd"><h1>靠泊系缆方案简报</h1><span>生成：${now.toLocaleString("zh-CN")}</span></div>
<div class="hd"><span>场景：<b>${sc.name}</b> ｜ 方案：<b>${plan.name}</b></span>
<span>仿真时长 ${sc.duration}h，步长 ${sc.dt}h</span></div>

<h2>一、船舶与泊位</h2>
<p>${sc.ship.name}：船长 ${sc.ship.L} m，船宽 ${sc.ship.B} m，贴泊线 y=${sc.ship.berthY} m；
护舷刚度 ${sc.fenderK.toFixed(0)} kN/m，额定反力 ${sc.ship.fenderMax ?? "—"} kN；
失衡判定阈值 ${sc.imbaThreshold} kN。共 ${sc.bollards.length} 个缆桩，
${sc.ship.fairleads.length} 个导缆孔。</p>

<h2>二、分时环境（风角=力方向，90°为海→岸横风）</h2>
<table><thead><tr><th>时刻h</th><th>潮位m</th><th>风向</th><th>风速m/s</th>
<th>流速m/s</th><th>吃水m</th><th>纵受风m²</th><th>横受风m²</th></tr></thead>
<tbody>${envRows}</tbody></table>

<h2>三、系缆配置与峰值利用率（安装缆长含潮位高差；手填长度直接决定无载原长与应变）</h2>
<table><thead><tr><th>缆名</th><th>类型</th><th>缆桩</th><th>安装缆长m</th>
<th>刚度kN/m</th><th>安全载荷kN</th><th>预张力kN</th><th>峰值利用率</th>
<th>峰值应变</th><th>峰值时刻h</th><th>状态</th></tr></thead><tbody>${lineRows}</tbody></table>

<h2>四、图示</h2>
<div class="grid">
  <div><p>泊位俯视图（t=${tSnap.toFixed(2)}h）</p><img src="${snap}"></div>
  <div><p>时间轴：利用率 / 未平衡载荷 / 潮位</p><img src="${tlSnap}"></div>
</div>

<h2>五、平衡评估</h2>
<p>${verdict}</p>
<p>主导载荷：${sim.steps[Math.floor(sim.steps.length * 2 / 3)].dominant}；
峰值风速出现在末时刻 ${sc.env[sc.env.length - 1].windSpeed.toFixed(0)} m/s 叠加落潮。
缆绳张力超过安全载荷即判失效并退出受力，由其余缆绳重新分配；
全部缆绳无法约束外载时记录未平衡载荷与船体外移。</p>
<p class="ok" style="color:#555">注：本简报由系缆方案推演台按准静态三自由度模型生成，供方案比选参考，不替代正式系泊分析。</p>
</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 400);
  },
};
window.Brief = Brief;
