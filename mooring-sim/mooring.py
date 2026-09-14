"""系缆方案时间步平衡求解器。

坐标约定（平面俯视图，单位 m / kN / rad）：
  世界坐标 +x 向船首方向，+y 向海侧（离泊方向），岸侧 y 较小。
  船位 state = (X, Y, psi)：船心位置与航向角（小角度）。
  缆桩为世界坐标固定点；导缆孔为船体系局部坐标，随船体平移+转动。

缆绳模型（张力型弹簧）：
  T = max(0, k * (L/L0 - 1)) ；T 超过安全载荷则该缆失效（卸载、退出受力，
  力由其余缆绳重新分配）。每一时间步用主动集策略配合 Newton 迭代解
  三自由度（纵移、横移、首摇）准静态平衡。
"""
import math

# 全局量纲：长度 m，力 kN，角度 rad
AIR_DENSITY = 1.225  # kg/m^3
WATER_DENSITY = 1025.0  # kg/m^3
# 纵向（来流沿船长）阻力系数远小于横向（OCIMF 量级）
CD_X = 0.10          # 风纵向
CD_Y = 0.90          # 风横向
CD_CURR_X = 0.05     # 流纵向
CD_CURR_Y = 0.90     # 流横向
CM_WIND = 0.90       # 风偏航力矩系数（配合 yawArm 用）
CM_CURR = 0.90


# ---------------------------------------------------------------- 线性代数
def solve_linear_3x3(A, b):
    """带部分选主元的高斯消元，解 3x3 线性方程组。"""
    M = [[A[i][j] for j in range(3)] + [b[i]] for i in range(3)]
    for col in range(3):
        pivot = max(range(col, 3), key=lambda r: abs(M[r][col]))
        if abs(M[pivot][col]) < 1e-14:
            return None
        if pivot != col:
            M[col], M[pivot] = M[pivot], M[col]
        for r in range(col + 1, 3):
            f = M[r][col] / M[col][col]
            if f != 0.0:
                for c in range(col, 4):
                    M[r][c] -= f * M[col][c]
    x = [0.0, 0.0, 0.0]
    for i in range(2, -1, -1):
        s = M[i][3]
        for j in range(i + 1, 3):
            s -= M[i][j] * x[j]
        if abs(M[i][i]) < 1e-14:
            return None
        x[i] = s / M[i][i]
    return x


# ---------------------------------------------------------------- 工具函数
def wrap_pi(a):
    """把角度归一化到 [-pi, pi)。"""
    return (a + math.pi) % (2 * math.pi) - math.pi


def interpolate_env(env_keys, t, imba_threshold):
    """对环境时间关键帧做线性插值。

    env_keys 为 [{t, tide, windDir(rad), windSpeed(m/s), currentSpeed(m/s),
                  currentDir(rad), draft(m), areaX, areaY}, ...]，按 t 升序。
    风向按最短弧插值。返回对应时刻字典。
    """
    ks = sorted(env_keys, key=lambda e: e["t"])
    if t <= ks[0]["t"]:
        e = dict(ks[0])
    elif t >= ks[-1]["t"]:
        e = dict(ks[-1])
    else:
        for i in range(len(ks) - 1):
            a, b = ks[i], ks[i + 1]
            if a["t"] <= t <= b["t"]:
                r = (t - a["t"]) / (b["t"] - a["t"]) if b["t"] > a["t"] else 0.0
                dwd = wrap_pi(b["windDir"] - a["windDir"]) * r
                dcd = wrap_pi(b.get("currentDir", 0.0) - a.get("currentDir", 0.0)) * r
                e = {
                    "t": t,
                    "tide": a["tide"] + (b["tide"] - a["tide"]) * r,
                    "windDir": wrap_pi(a["windDir"] + dwd),
                    "windSpeed": a["windSpeed"] + (b["windSpeed"] - a["windSpeed"]) * r,
                    "currentSpeed": a.get("currentSpeed", 0.0)
                    + (b.get("currentSpeed", 0.0) - a.get("currentSpeed", 0.0)) * r,
                    "currentDir": wrap_pi(a.get("currentDir", 0.0) + dcd),
                    "draft": a.get("draft", 10.0) + (b.get("draft", 10.0) - a.get("draft", 10.0)) * r,
                    "areaX": a.get("areaX", 300.0) + (b.get("areaX", 300.0) - a.get("areaX", 300.0)) * r,
                    "areaY": a.get("areaY", 300.0) + (b.get("areaY", 300.0) - a.get("areaY", 300.0)) * r,
                }
                break
        else:  # pragma: no cover - 区间逻辑保证不会走到
            e = dict(ks[-1])
    e["imba_threshold"] = imba_threshold
    return e


# ---------------------------------------------------------------- 外载荷
def wind_force(env):
    """风力分量（kN）。方向角 d 为风"推船的方向"（pi/2 即海→岸横风）。

    Fx = 0.5 rho Cx Ax v^2 cos d ;  Fy = 0.5 rho Cy Ay v^2 sin d
    首摇力矩按 sin(2d) 经验律（横风前后不对称时最大，顶风为零）。
    """
    v = env["windSpeed"]
    p = 0.5 * AIR_DENSITY * v * v * 1e-3
    d = env["windDir"]
    cx, sy = math.cos(d), math.sin(d)
    fx = p * CD_X * env["areaX"] * cx
    fy = p * CD_Y * env["areaY"] * sy
    m = p * CD_Y * env["areaY"] * env.get("yawArm", 0.0) * CM_WIND * math.sin(2 * d)
    return {
        "fx": fx, "fy": fy, "m": m,
        "mag_lat": p * CD_Y * env["areaY"] * abs(sy),
        "mag_long": p * CD_X * env["areaX"] * abs(cx),
    }


def current_force(env):
    """水流力分量（kN）：纵向用船长×吃水湿表面，横向用船宽方向系数。"""
    v = env["currentSpeed"]
    p = 0.5 * WATER_DENSITY * v * v * 1e-3
    d = env.get("currentDir", 0.0)
    cx, sy = math.cos(d), math.sin(d)
    draft = env["draft"]
    surf_x = env.get("surfX", 1.0) * draft
    surf_y = env.get("surfY", 1.0) * draft
    fx = p * CD_CURR_X * surf_x * cx
    fy = p * CD_CURR_Y * surf_y * sy
    m = p * CD_CURR_Y * surf_y * env.get("currYawArm", 0.0) * CM_CURR * math.sin(2 * d)
    return {
        "fx": fx, "fy": fy, "m": m,
        "mag_lat": abs(fy), "mag_long": abs(fx),
    }


# ---------------------------------------------------------------- 几何/张力
def fairlead_world(ship, local, state):
    """导缆孔局部坐标 (lx, ly) 转世界坐标。局部 +x 船首、+y 海侧。"""
    X, Y, psi = state
    lx, ly = local
    c, s = math.cos(psi), math.sin(psi)
    return (X + lx * c - ly * s, Y + lx * s + ly * c)


def line_tension(L, L0, k):
    """张力型弹簧：松弛为零。"""
    if L <= L0 or k <= 0:
        return 0.0
    return k * (L / L0 - 1.0)


def line_force(bollard, local, state, L0, k, pretension=0.0):
    """单根缆绳对船体的力 (fx, fy, m) 与张力/几何信息。

    预张力按安装时（初始船位 state0）几何给出，平衡计算中缆的有效原长
    由 L0_eff = L(初始) / (1 + T0/k) 反推，使初始张力恰为预张力。
    """
    px, py = fairlead_world({"L": 1.0}, local, state)
    bx, by = bollard
    dx, dy = bx - px, by - py
    L = math.hypot(dx, dy)
    if L < 1e-9:
        return {"fx": 0, "fy": 0, "m": 0, "T": 0, "L": L, "ux": 0, "uy": 0, "px": px, "py": py}
    ux, uy = dx / L, dy / L
    T = line_tension(L, L0, k)
    fx, fy = T * ux, T * uy
    m = (px - state[0]) * fy - (py - state[1]) * fx
    return {"fx": fx, "fy": fy, "m": m, "T": T, "L": L, "ux": ux, "uy": uy,
            "px": px, "py": py, "dT_dL": (k / L0) if L > L0 else 0.0}


def contact_force(ship, state, fender_k):
    """船体压向岸侧（y <= berthY）的线性护舷反弹力，逐角点检查。"""
    X, Y, psi = state
    c, s = math.cos(psi), math.sin(psi)
    L2, B2 = ship["L"] / 2, ship["B"] / 2
    fx = fy = m = 0.0
    n_contact = 0
    max_pen = 0.0
    corners = []
    for lx in (-L2, L2):
        for ly in (-B2, B2):
            wx = X + lx * c - ly * s
            wy = Y + lx * s + ly * c
            pen = ship["berthY"] - wy
            if pen > 0:
                cf = fender_k * pen
                fmax = ship.get("fenderMax", 1.0e12)
                if cf > fmax:
                    cf = fmax  # 护舷达到额定反力后不再增加支撑
                fy += cf
                m += (wx - X) * cf  # r=(wx-X,wy-Y), F=(0,cf): m=rx*cf
                n_contact += 1
                max_pen = max(max_pen, pen)
                corners.append({"wx": wx, "wy": wy, "rcx": wx - X,
                                "dpy_dpsi": lx * c - ly * s, "F": cf,
                                "kc": 0.0 if cf >= fmax else fender_k})
    return {"fx": fx, "fy": fy, "m": m, "n": n_contact, "pen": max_pen,
            "corners": corners}


# ---------------------------------------------------------------- 平衡迭代
def assemble_residual(state, lines, bollards, env, ship, ext, fender_k):
    """计算残差 R = 缆力 + 护舷力 + 外载荷（外载荷取负值表示环境推船）。"""
    R = [ext["fx"], ext["fy"], ext["m"]]
    J = [[0.0] * 3 for _ in range(3)]
    tensions = {}
    for ln in lines:
        if not ln.get("active", True) or ln.get("failed", False):
            tensions[ln["id"]] = 0.0
            continue
        b = bollards[ln["bollardId"]]
        info = line_force(b, ln["local"], state, ln["L0_eff"], ln["k"])
        T = info["T"]
        tensions[ln["id"]] = T
        R[0] += info["fx"]
        R[1] += info["fy"]
        R[2] += info["m"]
        # 解析切向刚度矩阵（对称）：
        #   K_t = k_t u u^T + (T/L)(I - u u^T)
        #   导缆孔 r_p 对 psi 导数：r_psi = (-lx s - ly c, lx c - ly s)
        kt = info["dT_dL"]
        L = info["L"]
        if L > 1e-9:
            ux, uy = info["ux"], info["uy"]
            a = kt - T / L
            # dF/dp = -K_t（恢复力，符号为负）
            kxx = T / L + a * ux * ux
            kxy = a * ux * uy
            kyy = T / L + a * uy * uy
            J[0][0] -= kxx
            J[0][1] -= kxy
            J[1][0] -= kxy
            J[1][1] -= kyy
            lx, ly = ln["local"]
            c0, s0 = math.cos(state[2]), math.sin(state[2])
            rpx = -lx * s0 - ly * c0
            rpy = lx * c0 - ly * s0
            # dF/dpsi = -K_t r_psi；矩阵对称性给出力矩-平移耦合
            gx = -(kxx * rpx + kxy * rpy)
            gy = -(kxy * rpx + kyy * rpy)
            J[0][2] += gx
            J[1][2] += gy
            J[2][0] += gx
            J[2][1] += gy
            rcx, rcy = info["px"] - state[0], info["py"] - state[1]
            # dm/dpsi = r_psi × F + r × F_psi
            dm = rpx * info["fy"] - rpy * info["fx"] + rcx * gy - rcy * gx
            J[2][2] += dm
    cf = contact_force(ship, state, fender_k)
    R[0] += cf["fx"]
    R[1] += cf["fy"]
    R[2] += cf["m"]
    # 护舷刚度（逐接触角点解析）
    for cn in cf["corners"]:
        kc = cn["kc"]
        J[1][1] += kc
        J[1][2] += -kc * cn["dpy_dpsi"]
        J[2][1] += -kc * cn["dpy_dpsi"]
        J[2][2] += -cn["rcx"] * kc * cn["dpy_dpsi"]
    return R, J, tensions


def solve_equilibrium(state0, lines, bollards, env, ship, ext, fender_k,
                      max_iter=80, tol=1e-3):
    """Newton 迭代求平衡船位。缆绳状态（松弛/张紧）在迭代中冻结，由外层主动集切换。"""
    anchor_k = 20.0  # 极弱参考约束，仅在全部缆绳失效时防止刚体数值漂移（kN/m）
    state = list(state0)
    last_tensions = {}
    for _ in range(max_iter):
        R, J, tensions = assemble_residual(state, lines, bollards, env, ship, ext, fender_k)
        last_tensions = tensions
        # 弱锚定：把船"拉"回泊位附近，保证全缆失效后仍可图示，残余力依旧可见
        R[0] += anchor_k * (state[0] - state0[0])
        R[1] += anchor_k * (state[1] - state0[1])
        R[2] += anchor_k * state[2] * 0.01
        J[0][0] += anchor_k
        J[1][1] += anchor_k
        J[2][2] += anchor_k * 0.01
        d = solve_linear_3x3(J, [-R[0], -R[1], -R[2]])
        if d is None:
            break
        # 限制单步步长
        scale = 1.0
        for limit, dv in ((0.5, abs(d[0])), (0.5, abs(d[1])), (0.02, abs(d[2]))):
            if dv > limit:
                scale = min(scale, limit / dv)
        d = [v * scale for v in d]
        nrm = math.hypot(math.hypot(R[0], R[1]), R[2])
        state = [state[i] + d[i] for i in range(3)]
        if nrm < tol and math.hypot(d[0], d[1]) < 1e-5 and abs(d[2]) < 1e-7:
            break
    R, _, tensions = assemble_residual(state, lines, bollards, env, ship, ext, fender_k)
    return state, tensions, R


def prepare_lines(plan, bollards, state0, sim_env_for_pretension):
    """预处理缆绳：由标称长度/预张力反推有效原长 L0_eff。

    - autoLength=True 时 L0 取初始几何长度；否则用录入长度。
    - 有效原长 = L0 / (1 + T0/k)，则初始张紧时 T(L0)=k*T0/k=T0（按安装状态）。
      实现中直接令初始长度对应预张力：L0_eff = L_init / (1 + T0/k)。
    """
    out = []
    for ln in plan["lines"]:
        L0 = ln["length"]
        if ln.get("autoLength", True):
            px, py = fairlead_world(None, ln["local"], state0)
            b = bollards[ln["bollardId"]]
            L0 = math.hypot(b[0] - px, b[1] - py)
        px, py = fairlead_world(None, ln["local"], state0)
        b = bollards[ln["bollardId"]]
        L_init = math.hypot(b[0] - px, b[1] - py)
        k = max(ln["k"], 1e-9)
        T0 = max(ln.get("pretension", 0.0), 0.0)
        L0_eff = L_init / (1.0 + T0 / k)
        d = dict(ln)
        d["length"] = L0
        d["L0_eff"] = L0_eff
        d["active"] = ln.get("active", True)
        d.setdefault("failed", False)
        out.append(d)
    return out


# ---------------------------------------------------------------- 主仿真
def run_simulation(scenario, plan, dt=None):
    """按时间步求解船体平衡。

    返回 dict：steps（每步完整记录）、summary（最早失衡/主导载荷/首断缆等）。
    """
    ship = scenario["ship"]
    state0 = [ship["x"], ship["y"], ship.get("psi0", 0.0)]
    duration = scenario["duration"]
    dt = dt or scenario.get("dt", 0.25)
    fender_k = scenario.get("fenderK", 50000.0)
    imba_threshold = scenario.get("imbaThreshold", 20.0)

    bollards = {b["id"]: (b["x"], b["y"]) for b in scenario["bollards"]}
    env0 = interpolate_env(scenario["env"], 0.0, imba_threshold)
    lines = prepare_lines(plan, bollards, state0, env0)

    # 环境参数补充（湿表面系数、风力矩臂等）
    def enrich_env(env):
        env.setdefault("yawArm", ship.get("windArm", ship["L"] * 0.05))
        env.setdefault("currYawArm", ship.get("currArm", ship["L"] * 0.05))
        env.setdefault("surfX", ship.get("surfX", ship["L"] * 0.8))
        env.setdefault("surfY", ship.get("surfY", ship["B"] * 2.2))
        return env

    n = int(round(duration / dt)) + 1
    steps = []
    state = list(state0)
    first_imbalance = None
    first_fail = None

    for i in range(n):
        t = round(i * dt, 6)
        env = enrich_env(interpolate_env(scenario["env"], t, imba_threshold))
        w = wind_force(env)
        c = current_force(env)
        ext = {"fx": w["fx"] + c["fx"], "fy": w["fy"] + c["fy"], "m": w["m"] + c["m"]}

        # 主动集：失效缆卸载后，反复平衡直到无新松弛/失效
        newly_failed = []
        for outer in range(len(lines) + 2):
            state, tensions, R = solve_equilibrium(
                state, lines, bollards, env, ship, ext, fender_k)
            changed = False
            for ln in lines:
                if not ln.get("active", True) or ln.get("failed", False):
                    continue
                T = tensions.get(ln["id"], 0.0)
                if T > ln["safeLoad"] * (1 + 1e-6):
                    ln["failed"] = True
                    ln["failTime"] = t
                    newly_failed.append(ln)
                    changed = True
            if not changed:
                break

        # 残差（未平衡载荷）
        R, _, tensions = assemble_residual(state, lines, bollards, env, ship, ext, fender_k)
        residual_force = math.hypot(R[0], R[1])
        residual_moment = abs(R[2])
        imba_force = max(0.0, residual_force - imba_threshold)
        imba_moment = max(0.0, residual_moment - imba_threshold * ship["L"] * 0.25)
        imbalanced = imba_force > 1.0 or imba_moment > 1.0

        if imbalanced and first_imbalance is None and t > 1e-9:
            first_imbalance = t
        for ln in newly_failed:
            if first_fail is None:
                first_fail = {"lineId": ln["id"], "name": ln.get("name", ln["id"]), "time": t}

        util = {}
        line_T = {}
        for ln in lines:
            T = tensions.get(ln["id"], 0.0)
            line_T[ln["id"]] = T
            sl = max(ln["safeLoad"], 1e-9)
            util[ln["id"]] = T / sl

        # 主导载荷：比较横向风力/纵向风力/横向流力/纵向流力的量级
        comps = [
            ("横风", w["mag_lat"]),
            ("顺风/顶风", w["mag_long"]),
            ("横向流（落潮）", c["mag_lat"]),
            ("纵向流", c["mag_long"]),
        ]
        dominant = max(comps, key=lambda z: z[1])

        steps.append({
            "t": t,
            "state": {"x": state[0], "y": state[1], "psi": state[2]},
            "displacement": {"x": state[0] - state0[0], "y": state[1] - state0[1]},
            "tensions": line_T,
            "util": util,
            "failed": {ln["id"]: ln.get("failed", False) for ln in lines},
            "active": {ln["id"]: ln.get("active", True) for ln in lines},
            "residual": {"fx": R[0], "fy": R[1], "m": R[2],
                         "force": residual_force, "moment": residual_moment},
            "env": {
                "tide": env["tide"], "windSpeed": env["windSpeed"],
                "windDir": env["windDir"], "currentSpeed": env["currentSpeed"],
                "currentDir": env.get("currentDir", 0.0),
                "draft": env["draft"], "areaX": env["areaX"], "areaY": env["areaY"],
            },
            "loads": {
                "wind": {"fx": w["fx"], "fy": w["fy"], "m": w["m"]},
                "current": {"fx": c["fx"], "fy": c["fy"], "m": c["m"]},
            },
            "dominant": dominant[0],
            "dominantMag": dominant[1],
            "imbalanced": imbalanced,
            "newFailures": [ln["id"] for ln in newly_failed],
        })

    # 汇总
    max_util = {ln["id"]: 0.0 for ln in lines}
    max_util_t = {ln["id"]: 0.0 for ln in lines}
    max_residual = 0.0
    max_disp = 0.0
    for s in steps:
        for lid, u in s["util"].items():
            if u > max_util[lid]:
                max_util[lid] = u
                max_util_t[lid] = s["t"]
        max_residual = max(max_residual, s["residual"]["force"])
        max_disp = max(max_disp, math.hypot(s["displacement"]["x"], s["displacement"]["y"]))

    # 首断缆（含初始步）
    if first_fail is None:
        for ln in lines:
            if ln.get("failed"):
                if first_fail is None or ln.get("failTime", 0) < first_fail["time"]:
                    first_fail = {"lineId": ln["id"], "name": ln.get("name", ln["id"]),
                                  "time": ln.get("failTime", 0.0)}

    summary = {
        "firstImbalance": first_imbalance,
        "firstFailure": first_fail,
        "maxResidual": max_residual,
        "maxDisplacement": max_disp,
        "maxUtil": max_util,
        "maxUtilTime": max_util_t,
        "balanced": first_imbalance is None and first_fail is None,
        "nSteps": len(steps),
    }
    return {"steps": steps, "summary": summary}
