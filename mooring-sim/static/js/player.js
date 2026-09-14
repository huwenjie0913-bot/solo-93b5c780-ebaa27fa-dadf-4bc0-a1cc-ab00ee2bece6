// 时间推进播放器（requestAnimationFrame）
const Player = {
  timeT: 0,
  playing: false,
  raf: null,
  lastTs: null,

  init() {
    U.$("#btnPlay").onclick = () => this.play();
    U.$("#btnPause").onclick = () => this.pause();
    U.$("#btnRestart").onclick = () => { this.setTime(0); };
  },

  play() {
    if (!App.sim) return;
    if (this.timeT >= App.scenario.duration - 1e-6) this.timeT = 0;
    this.playing = true;
    this.lastTs = null;
    U.$("#btnPlay").textContent = "▶ 播放中";
    const tick = ts => {
      if (!this.playing) return;
      if (this.lastTs != null) {
        const speed = parseFloat(U.$("#playSpeed").value);
        // 仿真 6 小时按 ~24 秒放完（1×）
        this.timeT += ((ts - this.lastTs) / 1000) * speed * (App.scenario.duration / 24);
        if (this.timeT >= App.scenario.duration) {
          this.timeT = App.scenario.duration;
          this.pause();
        }
      }
      this.lastTs = ts;
      this.refreshFrame();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  pause() {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    const btn = U.$("#btnPlay");
    if (btn) btn.textContent = "▶ 播放";
  },
  setTime(t) {
    this.timeT = U.clamp(t, 0, App.scenario ? App.scenario.duration : 0);
    this.refreshFrame();
  },
  refreshFrame() {
    Editor.redraw();
    Timeline.redraw();
    renderResultPanel();
    renderLineTable();
    U.$("#timeNow").textContent = this.timeT.toFixed(2);
    if (App.compare) Compare.refreshFrame();
  },
};
window.Player = Player;
