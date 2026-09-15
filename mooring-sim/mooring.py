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


def line_force(bollard, local, state, L0, k, dz=0.0):
    """单根缆绳对船体的水平力 (fx, fy)、首摇力矩 m 与张力/几何信息。

    三维索模型：桩与导缆孔存在高差 dz（桩减孔，随潮位变化），
    实际缆长 L = sqrt(水平距² + dz²)；张力 T = k(L/L0 - 1) 沿 3D 缆向，
    对船体的水平分力按水平投影占比 rho/L 折减。
    """
    px, py = fairlead_world({"L": 1.0}, local, state)
    bx, by = bollard[0], bollard[1]
    dx, dy = bx - px, by - py
    rho = math.hypot(dx, dy)
    L = math.hypot(rho, dz)
    if L < 1e-9:
        return {"fx": 0, "fy": 0, "m": 0, "T": 0, "L": L, "rho": rho,
                "ux": 0, "uy": 0, "px": px, "py": py, "dz": dz,
                "vAngle": 0.0, "strain": 0.0}
    ux, uy = dx / L, dy / L          # 3D 单位向量的水平分量
    T = line_tension(L, L0, k)
    fx, fy = T * ux, T * uy
    m = (px - state[0]) * fy - (py - state[1]) * fx
    return {"fx": fx, "fy": fy, "m": m, "T": T, "L": L, "rho": rho,
            "ux": ux, "uy": uy, "px": px, "py": py, "dz": dz,
            "vAngle": math.degrees(math.asin(dz / L)),
            "strain": (L / L0 - 1.0) if L0 > 0 else 0.0,
            "dT_dL": (k / L0) if L > L0 else 0.0}


def contact_force(ship, state, fender_k):
    """沿岸侧舷边按护舷间距离散、但穿透随船位连续的护舷反力。

    沿船长每隔 fender_spacing（默认 30m）取一具护舷，每具反力
    F = k·pen（pen≤0 为零），达到单具额定 fenderMax 后截断。
    离散点足够多且穿透连续，首摇刚度有限、接触随 ψ 平滑出现/消失。
    Jacobian 由 assemble_residual 用中心差分单独计算。
    """
    X, Y, psi = state
    c, s = math.cos(psi), math.sin(psi)
    L2, B2 = ship["L"] / 2, ship["B"] / 2
    fmax = ship.get("fenderMax", 1.0e12)
    spacing = ship.get("fenderSpacing", 30.0)
    contact_tol = 0.02

    n = max(2, int(math.ceil(ship["L"] / spacing)))
    fy = m = 0.0
    max_pen = 0.0
    active = 0
    for j in range(n + 1):
        lx = -L2 + ship["L"] * j / n
        ly = -B2
        wx = X + lx * c - ly * s
        wy = Y + lx * s + ly * c
        pen = ship["berthY"] - wy + contact_tol
        if pen > 0:
            f = fender_k * pen
            if f > fmax:
                f = fmax
            fy += f
            m += (wx - X) * f
            active += 1
            max_pen = max(max_pen, pen)
    return {"fx": 0.0, "fy": fy, "m": m, "n": active, "pen": max_pen, "corners": []}

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
        # 潮位随时间步变化：高差变化使三维缆长/水平投影改变（落潮提缆）
        dz = line_dz(ln.get("bollardZ", b[2] if len(b) > 2 else 5.0),
                     ln.get("fairleadZ", 3.0), env)
        info = line_force(b, ln["local"], state, ln["L0_eff"], ln["k"], dz=dz)
        T = info["T"]
        tensions[ln["id"]] = T
        R[0] += info["fx"]
        R[1] += info["fy"]
        R[2] += info["m"]
        # 三维索切向刚度（水平运动），矩阵对称：
        #   F_horiz = T u_horiz；u 为 3D 单位向量的水平分量，L 为 3D 缆长
        #   K = T/L * I2 + (kt - T/L) u u^T，残差 Jacobian 取 -K
        kt = info["dT_dL"]
        L = info["L"]
        if L > 1e-9:
            ux, uy = info["ux"], info["uy"]
            a = kt - T / L
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
    # 离散护舷的切向刚度用中心有限差分（接触/脱离边界非光滑，解析雅可比会过刚）。
    # 当当前状态或任一扰动状态存在接触时才做差分；无接触时护舷项恒为零。
    eps_q = (2e-4, 2e-4, 2e-6)
    need = cf["n"] > 0
    cpm = []
    for j in range(3):
        sp, sm = list(state), list(state)
        sp[j] += eps_q[j]
        sm[j] -= eps_q[j]
        cp = contact_force(ship, sp, fender_k)
        cm = contact_force(ship, sm, fender_k)
        cpm.append((cp, cm))
        need = need or cp["n"] > 0 or cm["n"] > 0
    if need:
        for j in range(3):
            cp, cm = cpm[j]
            J[1][j] += (cp["fy"] - cm["fy"]) / (2 * eps_q[j])
            J[2][j] += (cp["m"] - cm["m"]) / (2 * eps_q[j])
        J[0][1] = J[1][0]  # 护舷无 x 向力，保持对称
    return R, J, tensions


def solve_equilibrium(state0, lines, bollards, env, ship, ext, fender_k,
                      max_iter=120, tol_f=0.15, tol_m=30.0):
    """Newton 迭代求平衡船位。缆绳状态（松弛/张紧）在迭代中冻结，由外层主动集切换。

    收敛容差按物理意义给出：残余力 0.5 kN、残余力矩 50 kN·m、
    平移增量 1e-4 m、转角增量 1e-5 rad。
    """
    anchor_k = 20.0  # 极弱参考约束，仅在全部缆绳失效时防止刚体数值漂移（kN/m）

    def residual_norm(st):
        Rb, _, _ = assemble_residual(st, lines, bollards, env, ship, ext, fender_k)
        return math.hypot(Rb[0] + anchor_k * (st[0] - state0[0]),
                          Rb[1] + anchor_k * (st[1] - state0[1])) + \
            abs(Rb[2] + anchor_k * 0.01 * st[2]) / 50.0

    state = list(state0)
    for _ in range(max_iter):
        R, J, tensions = assemble_residual(state, lines, bollards, env, ship, ext, fender_k)
        res_f, res_m = math.hypot(R[0], R[1]), abs(R[2])
        if res_f < tol_f and res_m < tol_m:
            break
        Ra = [R[0] + anchor_k * (state[0] - state0[0]),
              R[1] + anchor_k * (state[1] - state0[1]),
              R[2] + anchor_k * 0.01 * state[2]]
        for i in range(2):
            J[i][i] += anchor_k
        J[2][2] += anchor_k * 0.01
        d = solve_linear_3x3(J, [-Ra[0], -Ra[1], -Ra[2]])
        if d is None:
            break
        # 步长上限（力/力矩很大时仍允许足够穿透量找到护舷平衡）
        scale = 1.0
        for limit, dv in ((0.05, abs(d[0])), (0.05, abs(d[1])), (0.002, abs(d[2]))):
            if dv > limit:
                scale = min(scale, limit / dv)
        # 残差不下降时阻尼回退（比较口径与实际残差一致）
        alpha, cur = scale, residual_norm(state)
        for _bt in range(14):
            cand = [state[i] + d[i] * alpha for i in range(3)]
            if residual_norm(cand) <= cur * (1.0 - 1e-4) + 1e-9:
                state = cand
                break
            alpha *= 0.5
        else:
            break
    R, _, tensions = assemble_residual(state, lines, bollards, env, ship, ext, fender_k)
    return state, tensions, R


def line_dz(bollard_z, fairlead_z, env):
    """当前潮位下桩与导缆孔的高差（桩高 − 孔高 − 潮位）。

    潮位以 tide=0 时水面为基准；船随水面整体升降，固定于码头的缆桩不随潮。
    落潮（tide 为负）→ 高差增大 → 缆被"提起"、实际缆长增大、水平投影占比减小。
    """
    return (bollard_z - fairlead_z) - env.get("tide", 0.0)


def prepare_lines(plan, bollards, state0, env0, ship):
    """预处理缆绳：确定安装参考长度与有效无载原长 L0_eff。

    - autoLength=True：参考长度 L_ref 取安装时刻（初始船位、初始潮位）的
      实际三维缆长；
    - autoLength=False：L_ref 用用户手工录入的长度（安装时两系点间的缆长）。
    - L_ref 对应预张力 T0，故真正的无载原长 L0_eff = L_ref / (1 + T0/k)：
      手填长度缩短 → L0_eff 减小 → 初始应变/张力增大，后续平衡与失效随之变化；
      手填长度过长则初始即松弛（T=0）。
    """
    fairlead_z = {f["id"]: f.get("z", 3.0) for f in ship.get("fairleads", [])}
    out = []
    for ln in plan["lines"]:
        bx, by, bz = bollards[ln["bollardId"]]
        px, py = fairlead_world(None, ln["local"], state0)
        fz = ln.get("fairleadZ", fairlead_z.get(ln.get("fairleadId"), 3.0))
        dz0 = line_dz(bz, fz, env0)
        rho0 = math.hypot(bx - px, by - py)
        L_init = math.hypot(rho0, dz0)
        if ln.get("autoLength", True):
            L_ref = L_init
        else:
            L_ref = max(float(ln.get("length", L_init)), 1e-6)
        k = max(ln["k"], 1e-9)
        T0 = max(ln.get("pretension", 0.0), 0.0)
        L0_eff = L_ref / (1.0 + T0 / k)
        d = dict(ln)
        d["length"] = L_ref        # 安装参考长度（手填时即为录入值）
        d["lengthAuto"] = L_init   # 安装几何长度（信息用）
        d["L0_eff"] = L0_eff       # 真正的无载原长，进入应变/张力/平衡
        d["bollardZ"] = bz
        d["fairleadZ"] = fz
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

    bollards = {b["id"]: (b["x"], b["y"], b.get("z", 5.0)) for b in scenario["bollards"]}
    env0 = interpolate_env(scenario["env"], 0.0, imba_threshold)
    lines = prepare_lines(plan, bollards, state0, env0, ship)

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

        # 每一步是当前载荷下的准静态平衡：从安装船位重新求解，
        # 避免上一步漂移状态在无外载时把缆绳"带松"。
        # 主动集：失效缆卸载后，反复平衡直到无新松弛/失效
        newly_failed = []
        guess = list(state0)
        for outer in range(len(lines) + 2):
            state, tensions, R = solve_equilibrium(
                guess, lines, bollards, env, ship, ext, fender_k)
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
        # 力矩阈值：力阈值 × 半船长（30 kN × 90 m ≈ 2700 kN·m）
        imba_moment = max(0.0, residual_moment - imba_threshold * ship["L"] * 0.5)
        imbalanced = imba_force > 1.0 or imba_moment > 1.0

        if imbalanced and first_imbalance is None and t > 1e-9:
            first_imbalance = t
        for ln in newly_failed:
            if first_fail is None:
                first_fail = {"lineId": ln["id"], "name": ln.get("name", ln["id"]), "time": t}

        util = {}
        line_T = {}
        strain = {}
        vangle = {}
        length3d = {}
        for ln in lines:
            T = tensions.get(ln["id"], 0.0)
            line_T[ln["id"]] = T
            sl = max(ln["safeLoad"], 1e-9)
            util[ln["id"]] = T / sl
            if ln.get("active", True) and not ln.get("failed", False):
                dz = line_dz(ln.get("bollardZ", 5.0), ln.get("fairleadZ", 3.0), env)
                info = line_force(bollards[ln["bollardId"]], ln["local"], state,
                                  ln["L0_eff"], ln["k"], dz=dz)
                strain[ln["id"]] = max(0.0, info["strain"])
                vangle[ln["id"]] = info["vAngle"]
                length3d[ln["id"]] = info["L"]
            else:
                strain[ln["id"]] = 0.0
                vangle[ln["id"]] = 0.0
                length3d[ln["id"]] = 0.0

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
            "strain": strain,
            "vAngle": vangle,
            "length3d": length3d,
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
