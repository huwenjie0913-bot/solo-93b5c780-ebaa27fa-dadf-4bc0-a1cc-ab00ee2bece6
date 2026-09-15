"""SQLite 持久化层：场景（泊位/船/环境）与系缆方案。"""
import json
import os
import sqlite3
import time
import uuid

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mooring.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS scenarios (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at REAL,
            updated_at REAL
        );
        CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at REAL,
            updated_at REAL
        );
        CREATE TABLE IF NOT EXISTS emergency_plans (
            id TEXT PRIMARY KEY,
            scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
            plan_id TEXT,
            name TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at REAL,
            updated_at REAL
        );
        """
    )
    conn.commit()

    if conn.execute("SELECT COUNT(*) FROM scenarios").fetchone()[0] == 0:
        seed(conn)
    migrate_demo_spares(conn)
    conn.close()


def migrate_demo_spares(conn):
    """给演示方案A补两根预先停用的备用横缆（应急处置演示用）。

    老库已存在 pl_demo_a 但没有备用缆时执行一次；新库由 seed 直接写入。
    """
    row = conn.execute("SELECT data FROM plans WHERE id='pl_demo_a'").fetchone()
    if not row:
        return
    data = json.loads(row["data"])
    ids = {l.get("id") for l in data.get("lines", [])}
    if "l_bx" in ids:
        return
    spares = [
        {"id": "l_bx", "name": "备用首横缆", "type": "breast",
         "fairleadId": "f_bow", "bollardId": "b6", "local": [86.0, -10.0],
         "length": 36.06, "k": 70000.0, "safeLoad": 2000.0,
         "pretension": 100.0, "autoLength": True, "active": False},
        {"id": "l_by", "name": "备用尾横缆", "type": "breast",
         "fairleadId": "f_stern", "bollardId": "b2", "local": [-86.0, -10.0],
         "length": 36.06, "k": 70000.0, "safeLoad": 2000.0,
         "pretension": 100.0, "autoLength": True, "active": False},
    ]
    data["lines"].extend(spares)
    conn.execute("UPDATE plans SET data=? WHERE id='pl_demo_a'",
                 (json.dumps(data, ensure_ascii=False),))
    conn.commit()


def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


# ---------------------------------------------------------------- 序列化
def row_to_scenario(r):
    d = json.loads(r["data"])
    d["id"] = r["id"]
    d["name"] = r["name"]
    d["createdAt"] = r["created_at"]
    d["updatedAt"] = r["updated_at"]
    return d


def row_to_plan(r):
    d = json.loads(r["data"])
    d["id"] = r["id"]
    d["scenarioId"] = r["scenario_id"]
    d["name"] = r["name"]
    d["createdAt"] = r["created_at"]
    d["updatedAt"] = r["updated_at"]
    return d


# ---------------------------------------------------------------- CRUD
def list_scenarios():
    conn = get_db()
    rows = conn.execute("SELECT * FROM scenarios ORDER BY updated_at DESC").fetchall()
    out = [{"id": r["id"], "name": r["name"], "updatedAt": r["updated_at"]} for r in rows]
    conn.close()
    return out


def load_scenario(sid):
    conn = get_db()
    r = conn.execute("SELECT * FROM scenarios WHERE id=?", (sid,)).fetchone()
    conn.close()
    return row_to_scenario(r) if r else None


def save_scenario(data):
    now = time.time()
    sid = data.get("id") or new_id("sc")
    conn = get_db()
    existing = conn.execute("SELECT id FROM scenarios WHERE id=?", (sid,)).fetchone()
    payload = json.dumps(data, ensure_ascii=False)
    if existing:
        conn.execute("UPDATE scenarios SET name=?, data=?, updated_at=? WHERE id=?",
                     (data.get("name", "未命名场景"), payload, now, sid))
    else:
        conn.execute("INSERT INTO scenarios(id, name, data, created_at, updated_at) VALUES(?,?,?,?,?)",
                     (sid, data.get("name", "未命名场景"), payload, now, now))
    conn.commit()
    conn.close()
    return sid


def delete_scenario(sid):
    conn = get_db()
    conn.execute("DELETE FROM scenarios WHERE id=?", (sid,))
    conn.execute("DELETE FROM emergency_plans WHERE scenario_id=?", (sid,))
    conn.commit()
    conn.close()


def list_plans(sid):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM plans WHERE scenario_id=? ORDER BY updated_at DESC", (sid,)
    ).fetchall()
    out = [{"id": r["id"], "name": r["name"], "updatedAt": r["updated_at"]} for r in rows]
    conn.close()
    return out


def load_plan(pid):
    conn = get_db()
    r = conn.execute("SELECT * FROM plans WHERE id=?", (pid,)).fetchone()
    conn.close()
    return row_to_plan(r) if r else None


def save_plan(data):
    now = time.time()
    pid = data.get("id") or new_id("pl")
    sid = data.get("scenarioId")
    if not isinstance(sid, str) or not sid:
        raise ValueError("scenarioId 必须为标量字符串")
    conn = get_db()
    existing = conn.execute("SELECT id FROM plans WHERE id=?", (pid,)).fetchone()
    payload = json.dumps(data, ensure_ascii=False)
    if existing:
        conn.execute("UPDATE plans SET name=?, data=?, updated_at=? WHERE id=?",
                     (data.get("name", "未命名方案"), payload, now, pid))
    else:
        conn.execute(
            "INSERT INTO plans(id, scenario_id, name, data, created_at, updated_at) VALUES(?,?,?,?,?,?)",
            (pid, data["scenarioId"], data.get("name", "未命名方案"), payload, now, now),
        )
    conn.commit()
    conn.close()
    return pid


def delete_plan(pid):
    conn = get_db()
    conn.execute("DELETE FROM plans WHERE id=?", (pid,))
    conn.execute("DELETE FROM emergency_plans WHERE plan_id=?", (pid,))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------- 应急方案
def row_to_emergency(r):
    d = json.loads(r["data"])
    d["id"] = r["id"]
    d["scenarioId"] = r["scenario_id"]
    d["planId"] = r["plan_id"]
    d["name"] = r["name"]
    d["createdAt"] = r["created_at"]
    d["updatedAt"] = r["updated_at"]
    return d


def list_emergency_plans(sid, plan_id=None):
    conn = get_db()
    if plan_id:
        rows = conn.execute(
            "SELECT * FROM emergency_plans WHERE scenario_id=? AND "
            "(plan_id=? OR plan_id IS NULL OR plan_id='') ORDER BY updated_at DESC",
            (sid, plan_id)).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM emergency_plans WHERE scenario_id=? ORDER BY updated_at DESC",
            (sid,)).fetchall()
    conn.close()
    return [{"id": r["id"], "name": r["name"], "planId": r["plan_id"],
             "updatedAt": r["updated_at"]} for r in rows]


def load_emergency_plan(eid):
    conn = get_db()
    r = conn.execute("SELECT * FROM emergency_plans WHERE id=?", (eid,)).fetchone()
    conn.close()
    return row_to_emergency(r) if r else None


def save_emergency_plan(data):
    now = time.time()
    eid = data.get("id") or new_id("em")
    sid = data.get("scenarioId")
    if not isinstance(sid, str) or not sid:
        raise ValueError("scenarioId 必须为标量字符串")
    conn = get_db()
    existing = conn.execute("SELECT id FROM emergency_plans WHERE id=?", (eid,)).fetchone()
    payload = json.dumps(data, ensure_ascii=False)
    if existing:
        conn.execute("UPDATE emergency_plans SET name=?, plan_id=?, data=?, updated_at=? WHERE id=?",
                     (data.get("name", "未命名应急方案"), data.get("planId"), payload, now, eid))
    else:
        conn.execute(
            "INSERT INTO emergency_plans(id,scenario_id,plan_id,name,data,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (eid, sid, data.get("planId"), data.get("name", "未命名应急方案"),
             payload, now, now))
    conn.commit()
    conn.close()
    return eid


def delete_emergency_plan(eid):
    conn = get_db()
    conn.execute("DELETE FROM emergency_plans WHERE id=?", (eid,))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------- 种子数据
def seed(conn):
    """横风叠加落潮的典型靠泊场景 + 两套对照方案。"""
    now = time.time()
    sid = "sc_demo"

    scenario = {
        "name": "3号泊位·横风落潮工况",
        "ship": {
            "name": "散货船 180m",
            "L": 180.0, "B": 32.0,
            "x": 0.0, "y": 0.0, "psi0": 0.0,
            "berthY": -16.0,
            "fenderMax": 800.0,
            "windArm": 9.0, "currArm": 4.5,
            "surfX": 150.0, "surfY": 62.0,
            "fairleads": [
                {"id": "f_bow", "name": "船首", "x": 86.0, "y": -10.0, "z": 3.5},
                {"id": "f_fore", "name": "前舷", "x": 45.0, "y": -14.0, "z": 3.5},
                {"id": "f_aft", "name": "后舷", "x": -45.0, "y": -14.0, "z": 3.5},
                {"id": "f_stern", "name": "船尾", "x": -86.0, "y": -10.0, "z": 3.5},
            ],
        },
        "bollards": [
            {"id": "b1", "name": "1#桩", "x": -120.0, "y": -28.0, "z": 4.0},
            {"id": "b2", "name": "2#桩", "x": -80.0, "y": -28.0, "z": 4.0},
            {"id": "b3", "name": "3#桩", "x": -40.0, "y": -28.0, "z": 4.0},
            {"id": "b4", "name": "4#桩", "x": 0.0, "y": -28.0, "z": 4.0},
            {"id": "b5", "name": "5#桩", "x": 40.0, "y": -28.0, "z": 4.0},
            {"id": "b6", "name": "6#桩", "x": 80.0, "y": -28.0, "z": 4.0},
            {"id": "b7", "name": "7#桩", "x": 120.0, "y": -28.0, "z": 4.0},
        ],
        "duration": 6.0,
        "dt": 0.2,
        "fenderK": 30000.0,
        "imbaThreshold": 40.0,
        # 环境关键帧（t 单位 h；角度为"来向力方向"：pi/2 表示自海向岸横风）
        "env": [
            {"t": 0.0, "tide": 2.0, "windDir": 1.5708, "windSpeed": 14.0,
             "currentSpeed": 1.6, "currentDir": 0.0, "draft": 11.0,
             "areaX": 420.0, "areaY": 2400.0},
            {"t": 3.0, "tide": -1.5, "windDir": 1.45, "windSpeed": 22.0,
             "currentSpeed": 2.4, "currentDir": 0.0, "draft": 11.6,
             "areaX": 430.0, "areaY": 2550.0},
            {"t": 6.0, "tide": -3.2, "windDir": 1.62, "windSpeed": 30.0,
             "currentSpeed": 2.0, "currentDir": 0.0, "draft": 12.0,
             "areaX": 440.0, "areaY": 2650.0},
        ],
    }

    def L(lx, ly, bx, by):
        return round(((bx - lx) ** 2 + (by - ly) ** 2) ** 0.5, 2)

    # 方案A：常规 6-2-2 配置（首2 尾2 横2……此处 6 根）
    plan_a = {
        "name": "方案A·常规6缆",
        "lines": [
            {"id": "l_h1", "name": "首缆", "type": "head",
             "fairleadId": "f_bow", "bollardId": "b7",
             "local": [86.0, -10.0],
             "length": L(86, -10, 120, -28), "k": 50000.0,
             "safeLoad": 800.0, "pretension": 100.0, "autoLength": True,
             "active": True},
            {"id": "l_b1", "name": "首横缆", "type": "breast",
             "fairleadId": "f_fore", "bollardId": "b5",
             "local": [45.0, -14.0],
             "length": L(45, -14, 40, -28), "k": 50000.0,
             "safeLoad": 450.0, "pretension": 120.0, "autoLength": True,
             "active": True},
            {"id": "l_s1", "name": "首倒缆", "type": "spring",
             "fairleadId": "f_bow", "bollardId": "b5",
             "local": [86.0, -10.0],
             "length": L(86, -10, 40, -28), "k": 50000.0,
             "safeLoad": 800.0, "pretension": 100.0, "autoLength": True,
             "active": True},
            {"id": "l_s2", "name": "尾倒缆", "type": "spring",
             "fairleadId": "f_stern", "bollardId": "b3",
             "local": [-86.0, -10.0],
             "length": L(-86, -10, -40, -28), "k": 50000.0,
             "safeLoad": 800.0, "pretension": 100.0, "autoLength": True,
             "active": True},
            {"id": "l_b2", "name": "尾横缆", "type": "breast",
             "fairleadId": "f_aft", "bollardId": "b3",
             "local": [-45.0, -14.0],
             "length": L(-45, -14, -40, -28), "k": 50000.0,
             "safeLoad": 450.0, "pretension": 120.0, "autoLength": True,
             "active": True},
            {"id": "l_h2", "name": "尾缆", "type": "stern",
             "fairleadId": "f_stern", "bollardId": "b1",
             "local": [-86.0, -10.0],
             "length": L(-86, -10, -120, -28), "k": 50000.0,
             "safeLoad": 800.0, "pretension": 100.0, "autoLength": True,
             "active": True},
            # 预先停用的备用横缆（应急处置：横缆断裂后启用替代）
            {"id": "l_bx", "name": "备用首横缆", "type": "breast",
             "fairleadId": "f_bow", "bollardId": "b6",
             "local": [86.0, -10.0],
             "length": L(86, -10, 80, -28), "k": 70000.0,
             "safeLoad": 2000.0, "pretension": 100.0, "autoLength": True,
             "active": False},
            {"id": "l_by", "name": "备用尾横缆", "type": "breast",
             "fairleadId": "f_stern", "bollardId": "b2",
             "local": [-86.0, -10.0],
             "length": L(-86, -10, -80, -28), "k": 70000.0,
             "safeLoad": 2000.0, "pretension": 100.0, "autoLength": True,
             "active": False},
        ],
    }

    # 方案B：加强配置 8 根缆（增配横缆/倒缆，提高预张力）
    plan_b = {
        "name": "方案B·加强8缆",
        "lines": [
            {"id": "l_h1", "name": "首缆", "type": "head",
             "fairleadId": "f_bow", "bollardId": "b7",
             "local": [86.0, -10.0],
             "length": L(86, -10, 120, -28), "k": 70000.0,
             "safeLoad": 800.0, "pretension": 140.0, "autoLength": True,
             "active": True},
            {"id": "l_b1", "name": "首横缆", "type": "breast",
             "fairleadId": "f_fore", "bollardId": "b5",
             "local": [45.0, -14.0],
             "length": L(45, -14, 40, -28), "k": 70000.0,
             "safeLoad": 2000.0, "pretension": 100.0, "autoLength": True,
             "active": True},
            {"id": "l_b3", "name": "首横缆2", "type": "breast",
             "fairleadId": "f_bow", "bollardId": "b6",
             "local": [86.0, -10.0],
             "length": L(86, -10, 80, -28), "k": 70000.0,
             "safeLoad": 2000.0, "pretension": 100.0, "autoLength": True,
             "active": True},
            {"id": "l_s1", "name": "首倒缆", "type": "spring",
             "fairleadId": "f_bow", "bollardId": "b5",
             "local": [86.0, -10.0],
             "length": L(86, -10, 40, -28), "k": 70000.0,
             "safeLoad": 800.0, "pretension": 140.0, "autoLength": True,
             "active": True},
            {"id": "l_s2", "name": "尾倒缆", "type": "spring",
             "fairleadId": "f_stern", "bollardId": "b3",
             "local": [-86.0, -10.0],
             "length": L(-86, -10, -40, -28), "k": 70000.0,
             "safeLoad": 800.0, "pretension": 140.0, "autoLength": True,
             "active": True},
            {"id": "l_b2", "name": "尾横缆", "type": "breast",
             "fairleadId": "f_aft", "bollardId": "b3",
             "local": [-45.0, -14.0],
             "length": L(-45, -14, -40, -28), "k": 70000.0,
             "safeLoad": 2000.0, "pretension": 100.0, "autoLength": True,
             "active": True},
            {"id": "l_b4", "name": "尾横缆2", "type": "breast",
             "fairleadId": "f_stern", "bollardId": "b2",
             "local": [-86.0, -10.0],
             "length": L(-86, -10, -80, -28), "k": 70000.0,
             "safeLoad": 2000.0, "pretension": 100.0, "autoLength": True,
             "active": True},
            {"id": "l_h2", "name": "尾缆", "type": "stern",
             "fairleadId": "f_stern", "bollardId": "b1",
             "local": [-86.0, -10.0],
             "length": L(-86, -10, -120, -28), "k": 70000.0,
             "safeLoad": 800.0, "pretension": 140.0, "autoLength": True,
             "active": True},
        ],
    }

    conn.execute(
        "INSERT INTO scenarios(id,name,data,created_at,updated_at) VALUES(?,?,?,?,?)",
        (sid, scenario["name"], json.dumps(scenario, ensure_ascii=False), now, now),
    )
    for pid, plan in (("pl_demo_a", plan_a), ("pl_demo_b", plan_b)):
        plan["scenarioId"] = sid
        conn.execute(
            "INSERT INTO plans(id,scenario_id,name,data,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (pid, sid, plan["name"], json.dumps(plan, ensure_ascii=False), now, now),
        )
    conn.commit()
