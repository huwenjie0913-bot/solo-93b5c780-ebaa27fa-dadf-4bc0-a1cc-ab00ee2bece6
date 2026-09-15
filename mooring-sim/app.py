"""零依赖后端：标准库 http.server 提供静态页面 + REST API。

接口与（原本规划的）Flask 版本一致：
  GET  /                              静态 index.html
  GET  /static/...                    静态资源
  GET  /api/scenarios                 场景列表
  GET  /api/scenarios/<id>            场景详情 / DELETE 删除
  POST /api/scenarios                 新建/更新场景
  GET  /api/scenarios/<id>/plans      方案列表
  GET  /api/plans/<id>                方案详情 / DELETE 删除
  POST /api/plans                     新建/更新方案
  POST /api/simulate                  {scenario, plan} -> 时间步求解结果
  POST /api/simulate                  {scenario, plan, actions:[...]} -> 应急动作推演
  POST /api/emergency/latest          动作整体平移，二分求最晚可行介入时刻
  GET/POST /api/emergency-plans       应急方案列表 / 保存（DELETE /api/emergency-plans/<id>）
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db
import mooring

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "MooringSim/1.0"

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ------------------------------------------------ 工具
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        if not os.path.isfile(path):
            self.send_error(404)
            return
        ext = os.path.splitext(path)[1]
        body = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length", 0))
        if n == 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    # ------------------------------------------------ 路由
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/" or path == "/index.html":
            return self.send_file(os.path.join(STATIC, "index.html"))
        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            full = os.path.normpath(os.path.join(STATIC, rel))
            if not full.startswith(STATIC + os.sep) and full != STATIC:
                return self.send_error(403)
            return self.send_file(full)
        if path == "/api/scenarios":
            return self.send_json(db.list_scenarios())
        if path.startswith("/api/scenarios/") and path.endswith("/plans"):
            sid = path.split("/")[3]
            return self.send_json(db.list_plans(sid))
        if path.startswith("/api/scenarios/") and path.endswith("/emergency-plans"):
            sid = path.split("/")[3]
            plan_id = None
            q = parse_qs(urlparse(self.path).query)
            if q.get("planId"):
                plan_id = q["planId"][0]
            return self.send_json(db.list_emergency_plans(sid, plan_id))
        if path.startswith("/api/scenarios/"):
            s = db.load_scenario(path.rsplit("/", 1)[-1])
            return self.send_json(s, 200) if s else self.send_json({"error": "场景不存在"}, 404)
        if path.startswith("/api/plans/"):
            p = db.load_plan(path.rsplit("/", 1)[-1])
            return self.send_json(p, 200) if p else self.send_json({"error": "方案不存在"}, 404)
        if path.startswith("/api/emergency-plans/"):
            e = db.load_emergency_plan(path.rsplit("/", 1)[-1])
            return self.send_json(e, 200) if e else self.send_json({"error": "应急方案不存在"}, 404)
        self.send_error(404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/scenarios/"):
            db.delete_scenario(path.rsplit("/", 1)[-1])
            return self.send_json({"ok": True})
        if path.startswith("/api/plans/"):
            db.delete_plan(path.rsplit("/", 1)[-1])
            return self.send_json({"ok": True})
        if path.startswith("/api/emergency-plans/"):
            db.delete_emergency_plan(path.rsplit("/", 1)[-1])
            return self.send_json({"ok": True})
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self.read_json()
        except Exception as exc:
            return self.send_json({"error": f"请求体解析失败: {exc}"}, 400)
        if not isinstance(body, dict):
            return self.send_json({"error": "请求体必须为 JSON 对象"}, 400)

        if path == "/api/scenarios":
            return self.send_json({"id": db.save_scenario(body)})
        if path == "/api/plans":
            sid = body.get("scenarioId")
            if not isinstance(sid, str) or not sid:
                return self.send_json(
                    {"error": "scenarioId 必须为标量字符串（是否误用了创建接口的整个返回对象？）"}, 400)
            body["scenarioId"] = sid
            return self.send_json({"id": db.save_plan(body)})
        if path == "/api/simulate":
            scenario = body.get("scenario")
            plan = body.get("plan")
            if scenario is None and body.get("scenarioId"):
                scenario = db.load_scenario(body["scenarioId"])
            if plan is None and body.get("planId"):
                plan = db.load_plan(body["planId"])
            if not scenario or not plan:
                return self.send_json({"error": "缺少场景或方案数据"}, 400)
            try:
                actions = body.get("actions")
                if actions:
                    return self.send_json(mooring.run_emergency(scenario, plan, actions))
                return self.send_json(mooring.run_simulation(scenario, plan))
            except Exception as exc:
                return self.send_json({"error": f"求解失败: {exc}"}, 400)
        if path == "/api/emergency/latest":
            scenario = body.get("scenario")
            plan = body.get("plan")
            if scenario is None and body.get("scenarioId"):
                scenario = db.load_scenario(body["scenarioId"])
            if plan is None and body.get("planId"):
                plan = db.load_plan(body["planId"])
            actions = body.get("actions") or []
            if not scenario or not plan:
                return self.send_json({"error": "缺少场景或方案数据"}, 400)
            if not actions:
                return self.send_json({"error": "请先在时间轴上安排至少一条应急动作"}, 400)
            try:
                t_lo = float(body.get("tLo", 0.0))
                t_hi = float(body.get("tHi", scenario["duration"]))
                resolution = body.get("resolution")
                tol = float(body.get("tol", 0.05))
                return self.send_json(mooring.find_latest_intervention(
                    scenario, plan, actions, t_lo, t_hi,
                    resolution=float(resolution) if resolution else None, tol=tol))
            except ValueError as exc:
                return self.send_json({"error": f"区间参数无效: {exc}"}, 400)
            except Exception as exc:
                return self.send_json({"error": f"搜索失败: {exc}"}, 400)
        if path == "/api/emergency-plans":
            sid = body.get("scenarioId")
            if not isinstance(sid, str) or not sid:
                return self.send_json({"error": "scenarioId 必须为标量字符串"}, 400)
            try:
                return self.send_json({"id": db.save_emergency_plan(body)})
            except Exception as exc:
                return self.send_json({"error": f"保存应急方案失败: {exc}"}, 400)
        self.send_error(404)


def main():
    db.init_db()
    server = ThreadingHTTPServer(("0.0.0.0", 5000), Handler)
    print("系缆方案推演台已启动: http://localhost:5000")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
