// 通用小工具
const U = {
  $(sel, root = document) { return root.querySelector(sel); },
  $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); },

  el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  },

  async api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
  },

  uid(prefix) { return prefix + "_" + Math.random().toString(36).slice(2, 10); },
  clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); },
  fmt(v, n = 1) { return v == null ? "—" : Number(v).toFixed(n); },
  deg(rad) { return (rad * 180) / Math.PI; },
  rad(deg) { return (deg * Math.PI) / 180; },
  wrapDeg(d) { return ((d + 540) % 360) - 180; },

  // 利用率 → 颜色
  utilColor(u) {
    if (u >= 1.0) return "#e74c3c";
    if (u >= 0.9) return "#e67e22";
    if (u >= 0.7) return "#f1c40f";
    return "#2ecc71";
  },
  lineTypeColor(t) {
    return { head: "#5dade2", stern: "#af7ac5", breast: "#48c9b0", spring: "#f5b041" }[t] || "#95a5a6";
  },
  lineTypeName(t) {
    return { head: "首缆", stern: "尾缆", breast: "横缆", spring: "倒缆" }[t] || t;
  },

  debounce(fn, ms) {
    let h = null;
    return function (...args) {
      clearTimeout(h);
      h = setTimeout(() => fn.apply(this, args), ms);
    };
  },
};
window.U = U;
