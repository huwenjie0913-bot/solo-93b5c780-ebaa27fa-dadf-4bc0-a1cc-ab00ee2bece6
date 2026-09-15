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


def fender_points(ship):
    """离散护舷在船体系的坐标（安装不变量）。"""
    L2, B2 = ship["L"] / 2, ship["B"] / 2
    spacing = ship.get("fenderSpacing", 30.0)
    n = max(2, int(math.ceil(ship["L"] / spacing)))
    return [(-L2 + ship["L"] * j / n, -B2) for j in range(n + 1)]


def _clip_fender(pen, fender_k, fmax):
    """单具护舷在穿透 pen 下的截断反力（pen≤0 为零）。"""
    if pen <= 0.0:
        return 0.0
    f = fender_k * pen
    return fmax if f > fmax else f


def assemble_lines(state, lines, bollards, env, ext):
    """缆绳（含解析对称切向刚度）部分的残差、Jacobian、张力。

    与护舷接触无关，可被护舷力的多次差分复用，避免每步重复组装缆绳。
    """
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
    return R, J, tensions


def fender_residual_jacobian(ship, state, fender_k):
    """护舷合力、力矩及其对 (Y, ψ) 的切向刚度。

    接触反力与 X 无关（J 对 X 行/列均为零）；Y、ψ 方向用当前状态逐点标量
    中心差分子 —— 与对整状态做 ±ε 后重算接触力的中心差分数学等价
    （ψ 扰动只改变穿透与力臂，标量结果完全一致），但只需计算一次几何。
    截断非线性用 (f⁺+f⁻)/2 复现差分点上的真实力，避免平台区间偏置。
    """
    X, Y, psi = state
    c, s = math.cos(psi), math.sin(psi)
    L2, B2 = ship["L"] / 2, ship["B"] / 2
    fmax = ship.get("fenderMax", 1.0e12)
    contact_tol = 0.02
    eps_y, eps_p = 2e-4, 2e-6

    fy = m = 0.0
    active = 0
    j11 = j12 = j21 = j22 = 0.0
    for lx, ly in fender_points(ship):
        ax = lx * c - ly * s          # 相对船心的 x（力臂）
        ay = lx * s + ly * c          # 相对船心的 y
        pen = ship["berthY"] - (Y + ay) + contact_tol
        if pen > 0.0:
            f = _clip_fender(pen, fender_k, fmax)
            fy += f
            m += ax * f
            active += 1
        fp, fm_ = _clip_fender(pen - eps_y, fender_k, fmax), \
            _clip_fender(pen + eps_y, fender_k, fmax)
        df_y = (fp - fm_) / (2 * eps_y)
        j11 += df_y
        j21 += ax * df_y
        fp2, fm2 = _clip_fender(pen - ax * eps_p, fender_k, fmax), \
            _clip_fender(pen + ax * eps_p, fender_k, fmax)
        df_p = (fp2 - fm2) / (2 * eps_p)
        j12 += df_p
        j22 += ax * df_p - ay * (fp2 + fm2) * 0.5
    return {"fx": 0.0, "fy": fy, "m": m, "n": active}, j11, j12, j21, j22


# ---------------------------------------------------------------- 平衡迭代
def assemble_residual(state, lines, bollards, env, ship, ext, fender_k):
    """计算残差 R = 缆力 + 护舷力 + 外载荷（外载荷取负值表示环境推船）。"""
    R, J, tensions = assemble_lines(state, lines, bollards, env, ext)
    cf, j11, j12, j21, j22 = fender_residual_jacobian(ship, state, fender_k)
    R[1] += cf["fy"]
    R[2] += cf["m"]
    J[1][1] += j11
    J[1][2] += j12
    J[2][1] += j21
    J[2][2] += j22
    return R, J, tensions


def solve_equilibrium(state0, lines, bollards, env, ship, ext, fender_k,
                      max_iter=120, tol_f=0.15, tol_m=30.0):
    """Newton 迭代求平衡船位。缆绳状态（松弛/张紧）在迭代中冻结，由外层主动集切换。

    收敛容差按物理意义给出：残余力 0.5 kN、残余力矩 50 kN·m、
    平移增量 1e-4 m、转角增量 1e-5 rad。
    """
    anchor_k = 20.0  # 极弱参考约束，仅在全部缆绳失效时防止刚体数值漂移（kN/m）

    # 本次平衡内对同一候选船位的残差做缓存：回退线搜索会反复评估
    # 相近/相同状态，缆绳组装昂贵而结果只依赖状态（数学等价的加速）。
    norm_cache = {}

    def residual_norm(st):
        key = (round(st[0], 7), round(st[1], 7), round(st[2], 8))
        val = norm_cache.get(key)
        if val is None:
            Rb, _, _ = assemble_residual(st, lines, bollards, env, ship, ext, fender_k)
            val = math.hypot(Rb[0] + anchor_k * (st[0] - state0[0]),
                             Rb[1] + anchor_k * (st[1] - state0[1])) + \
                abs(Rb[2] + anchor_k * 0.01 * st[2]) / 50.0
            if len(norm_cache) > 600:
                norm_cache.clear()
                norm_cache[key] = val
            else:
                norm_cache[key] = val
        return val

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


# ====================================================================
# 应急处置：计划动作（启用备用缆/停用受损缆/调预张力/限时拖轮力）
#
# 求解器按时间步推进，动作在其触发时刻（吸附到时间步）先于自然载荷求解
# 执行；每次动作执行后立即重新求平衡并做断缆级联，自动失效与计划动作
# 分别打标（step.newFailures vs 动作事件链），回放可区分二者。
# ====================================================================
ACTION_TYPES = ("enableLine", "disableLine", "setPretension", "tugForce")
ACTION_LABELS = {
    "enableLine": "启用备用缆",
    "disableLine": "停用受损缆",
    "setPretension": "调整预张力",
    "tugForce": "限时拖轮力",
}
TUG_DIRECTIONS = {
    # 与风/流方向角同一约定（力推船的方向）。世界坐标 +y 为海侧、−y 为岸，
    # 故“顶推靠泊（向岸）”对应 −90°，用于抵消横风+落潮把船拉离泊位的力。
    "shore": -math.pi / 2,
    "sea": math.pi / 2,
    "bow": 0.0,
    "stern": math.pi,
}


def normalize_actions(actions, duration):
    """规整/校验动作表，不依赖具体方案。返回 (actions, errors)。

    errors 为 [{id, reason}]，描述结构层面无法执行的问题（类型/时刻/数值）；
    目标缆不存在、冲突、对象已失效等运行期原因在求解时逐条标注。
    """
    out, errors = [], []
    if not isinstance(actions, list):
        return out, [{"id": None, "reason": "动作表必须是数组"}]
    seen = set()
    for i, raw in enumerate(actions):
        if not isinstance(raw, dict):
            errors.append({"id": None, "reason": f"第 {i + 1} 条动作不是对象"})
            continue
        aid = raw.get("id") or f"act_{i}"
        if aid in seen:
            errors.append({"id": aid, "reason": "动作 id 重复"})
            aid = f"{aid}_{i}"
        seen.add(aid)
        typ = raw.get("type")
        if typ not in ACTION_TYPES:
            errors.append({"id": aid, "reason": f"未知动作类型：{typ}"})
            continue
        try:
            t = float(raw.get("t", 0.0))
        except (TypeError, ValueError):
            errors.append({"id": aid, "reason": "时刻不是数字"})
            continue
        a = {"id": aid, "type": typ, "t": max(0.0, min(float(duration), t)),
             "label": raw.get("label") or ACTION_LABELS[typ]}
        if typ in ("enableLine", "disableLine", "setPretension"):
            a["lineId"] = raw.get("lineId")
        if typ == "setPretension":
            try:
                a["pretension"] = max(0.0, float(raw.get("pretension", 0.0)))
            except (TypeError, ValueError):
                errors.append({"id": aid, "reason": "预张力不是数字"})
                continue
        if typ == "tugForce":
            a["name"] = raw.get("name") or "拖轮"
            try:
                a["force"] = max(0.0, float(raw.get("force", 0.0)))
                a["duration"] = max(0.0, float(raw.get("duration", 0.5)))
            except (TypeError, ValueError):
                errors.append({"id": aid, "reason": "拖轮力或持续时长不是数字"})
                continue
            if a["force"] <= 0.0 or a["duration"] <= 0.0:
                errors.append({"id": aid, "reason": "拖轮力与持续时长必须为正数"})
                continue
            d = raw.get("direction", "shore")
            if d in TUG_DIRECTIONS:
                a["direction"] = d
            else:
                try:
                    a["direction"] = float(d)  # 也接受弧度数值
                except (TypeError, ValueError):
                    errors.append({"id": aid, "reason": f"拖轮方向无效：{d}"})
                    continue
        out.append(a)
    out.sort(key=lambda x: (x["t"], ACTION_TYPES.index(x["type"])))
    return out, errors


def _line_by_id(lines, lid):
    for ln in lines:
        if ln["id"] == lid:
            return ln
    return None


def _tug_angle(a):
    d = a.get("direction", "shore")
    return TUG_DIRECTIONS[d] if isinstance(d, str) and d in TUG_DIRECTIONS else float(d)


def _ext_with_tugs(ext_base, tugs, ship):
    """环境外载叠加上当前生效的拖轮力（方向约定与风一致：力推船的方向）。"""
    fx, fy, m = ext_base["fx"], ext_base["fy"], ext_base["m"]
    arm = ship.get("windArm", ship["L"] * 0.05)
    for g in tugs:
        d = g["angle"]
        fx += g["force"] * math.cos(d)
        fy += g["force"] * math.sin(d)
        m += g["force"] * arm * math.sin(2 * d)
    return {"fx": fx, "fy": fy, "m": m}


def _solve_cascade(guess, lines, bollards, env, ship, ext, fender_k, fail_t):
    """求平衡并做断缆主动集级联。返回 (state, tensions, R, failures)。"""
    st, tens, R = solve_equilibrium(guess, lines, bollards, env, ship, ext, fender_k)
    failures = []
    for _outer in range(len(lines) + 2):
        changed = False
        for ln in lines:
            if not ln.get("active", True) or ln.get("failed", False):
                continue
            if tens.get(ln["id"], 0.0) > ln["safeLoad"] * (1 + 1e-6):
                ln["failed"] = True
                ln["failTime"] = fail_t
                failures.append({"lineId": ln["id"], "name": ln.get("name", ln["id"]),
                                 "time": fail_t})
                changed = True
        if not changed:
            break
        st, tens, R = solve_equilibrium(list(st), lines, bollards, env, ship, ext, fender_k)
    Rf, _, tens = assemble_residual(st, lines, bollards, env, ship, ext, fender_k)
    return st, tens, Rf, failures


def _metrics_snapshot(lines, tensions, R, state, state0):
    """动作前后缆绳利用率/船体偏移/未平衡载荷快照。"""
    return {
        "util": {ln["id"]: tensions.get(ln["id"], 0.0) / max(ln["safeLoad"], 1e-9)
                 for ln in lines},
        "tensions": {ln["id"]: tensions.get(ln["id"], 0.0) for ln in lines},
        "residual": {"fx": R[0], "fy": R[1], "m": R[2], "force": math.hypot(R[0], R[1])},
        "disp": {"x": state[0] - state0[0], "y": state[1] - state0[1],
                 "mag": math.hypot(state[0] - state0[0], state[1] - state0[1])},
    }


def _apply_action(a, lines, state, bollards, env, ship, ext_base, fender_k,
                  active_tugs, state0, t):
    """执行单条动作并立即重新平衡 + 断缆级联。

    active_tugs: {actionId: 拖轮力描述}，由调用方跨时间步持有；
    拖轮动作成功时写入，施力窗口在 run_emergency 主循环按时刻裁剪。
    """
    def live(tt=t):
        return [g for g in active_tugs.values()
                if g["t0"] - 1e-9 <= tt < g["t1"] - 1e-9]

    tugs_now = live()
    st0, t0, R0, _ = _solve_cascade(
        list(state), lines, bollards, env, ship,
        _ext_with_tugs(ext_base, tugs_now, ship), fender_k, t)
    before = _metrics_snapshot(lines, t0, R0, st0, state0)

    typ = a["type"]
    reason = None
    if typ in ("enableLine", "disableLine", "setPretension"):
        ln = _line_by_id(lines, a.get("lineId"))
        if ln is None:
            reason = f"目标缆绳不存在（id={a.get('lineId')}），可能已从方案中删除"
        elif ln.get("failed", False):
            reason = f"「{ln.get('name', ln['id'])}」已在 {ln.get('failTime', 0):.2f}h 断裂失效，无法再操作"
        elif typ == "enableLine":
            if ln.get("active", True):
                reason = f"「{ln.get('name', ln['id'])}」本来就在用，启用动作与之冲突"
            else:
                ln["active"] = True
        elif typ == "disableLine":
            if not ln.get("active", True):
                reason = f"「{ln.get('name', ln['id'])}」已停用，停用动作与之冲突"
            else:
                ln["active"] = False
        else:  # setPretension
            if not ln.get("active", True):
                reason = f"「{ln.get('name', ln['id'])}」已停用，不能调预张力；请先安排启用动作"
            else:
                # 以当前潮位/船位实际三维缆长反推新无载原长，使平衡后预张力
                # 趋近给定值（物理上即收/放缆）：L0' = L/(1+T_new/k)
                b = bollards[ln["bollardId"]]
                dz = line_dz(ln.get("bollardZ", 5.0), ln.get("fairleadZ", 3.0), env)
                info = line_force(b, ln["local"], st0, ln["L0_eff"], ln["k"], dz=dz)
                L_now = max(info["L"], 1e-6)
                k = max(ln["k"], 1e-9)
                ln["L0_eff"] = L_now / (1.0 + a["pretension"] / k)
                ln["pretension"] = a["pretension"]
    else:  # tugForce
        if a["force"] <= 0 or a["duration"] <= 0:
            reason = "拖轮力与持续时长必须为正数"
        elif a["id"] in active_tugs:
            reason = "同一拖轮动作已登记，动作冲突"
        else:
            active_tugs[a["id"]] = {
                "actionId": a["id"], "force": a["force"], "angle": _tug_angle(a),
                "name": a.get("name", "拖轮"), "t0": a["t"],
                "t1": a["t"] + a["duration"]}

    if reason:
        return {"actionId": a["id"], "type": typ, "t": t, "status": "rejected",
                "reason": reason, "before": before, "after": before,
                "cascadedFailures": [], "state": st0}

    st1, t1, R1, cascaded = _solve_cascade(
        list(st0), lines, bollards, env, ship,
        _ext_with_tugs(ext_base, list(active_tugs.values()), ship), fender_k, t)
    after = _metrics_snapshot(lines, t1, R1, st1, state0)
    return {"actionId": a["id"], "type": typ, "t": t, "status": "applied",
            "reason": None, "before": before, "after": after,
            "cascadedFailures": cascaded, "state": st1}


def run_emergency(scenario, plan, actions, dt=None):
    """带应急动作的时间步推演。

    每个时间步：先按自然载荷（含生效拖轮）求平衡与自动断缆级联；
    随后按序执行触发动作，每条动作后立即重新平衡；动作全部落定后再
    求一次最终平衡作为该步记录。steps 结构与 run_simulation 同构，
    另含 events（计划动作/拒收/级联）与 tugs（本步生效拖轮力）。
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

    norm_actions, struct_errors = normalize_actions(actions, duration)

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
    action_results = []
    applied_ids = set()   # 成功执行过的动作 id（拖轮/缆操作都登记）
    active_tugs = {}      # actionId -> 拖轮描述（按时间窗裁剪是否出力）

    by_step = {}
    for a in norm_actions:
        # 与前端 Math.round(t/dt) 一致（floor(x+1/2)），避免银行家舍入偏差
        idx = int(math.floor(a["t"] / dt + 0.5))
        by_step.setdefault(min(idx, n - 1), []).append(a)

    for i in range(n):
        t = round(i * dt, 6)
        env = enrich_env(interpolate_env(scenario["env"], t, imba_threshold))
        w = wind_force(env)
        c = current_force(env)
        env_ext = {"fx": w["fx"] + c["fx"], "fy": w["fy"] + c["fy"],
                   "m": w["m"] + c["m"]}

        # 拖轮仅在施力窗口 [t0, t1) 内出力（不修改登记字典本身）
        def live_at(tt):
            return [g for g in active_tugs.values()
                    if g["t0"] - 1e-9 <= tt < g["t1"] - 1e-9]

        live_tugs = live_at(t)
        ext_live = _ext_with_tugs(env_ext, live_tugs, ship)

        step_events = []
        # 1) 自然载荷下的平衡与自动断缆级联
        state, tensions, R, natural = _solve_cascade(
            list(state0), lines, bollards, env, ship, ext_live, fender_k, t)

        # 2) 触发本时刻计划动作（normalize 已按时刻+类型排序）
        due = by_step.get(i, [])
        action_fail_ids = set()
        for a in due:
            res = _apply_action(a, lines, state, bollards, env, ship, env_ext,
                                fender_k, active_tugs, state0, t)
            state = res["state"]
            action_results.append(res)
            for f in res["cascadedFailures"]:
                action_fail_ids.add(f["lineId"])
            target = _action_target(a, lines)
            if res["status"] == "applied":
                applied_ids.add(a["id"])
                step_events.append({
                    "kind": "action", "actionId": a["id"], "type": a["type"],
                    "t": t, "label": a.get("label", ACTION_LABELS[a["type"]]),
                    "target": target,
                    "cascadedFailures": res["cascadedFailures"],
                    "before": res["before"], "after": res["after"]})
            else:
                step_events.append({
                    "kind": "rejected", "actionId": a["id"], "type": a["type"],
                    "t": t, "label": a.get("label", ACTION_LABELS[a["type"]]),
                    "target": target, "reason": res["reason"]})

        # 3) 动作落定后的最终平衡：与 run_simulation 口径一致，从安装船位
        #    重新求解（避免沿漂移状态热启动得到不同平衡点），再做主动集
        live_tugs = live_at(t)
        ext = _ext_with_tugs(env_ext, live_tugs, ship)
        state, tensions, R, extra = _solve_cascade(
            list(state0), lines, bollards, env, ship, ext, fender_k, t)
        # 动作后级联与最终平衡的断裂都在时间轴以红✖展示（计划动作另以
        # 事件链标注“动作后级联”）；同一缆在本步只计一次
        all_step_fail = [x for x in [f["lineId"] for f in natural]]
        for lid in action_fail_ids:
            if lid not in all_step_fail:
                all_step_fail.append(lid)
        for f in extra:
            if f["lineId"] not in all_step_fail:
                all_step_fail.append(f["lineId"])
        extra_ids = all_step_fail

        residual_force = math.hypot(R[0], R[1])
        residual_moment = abs(R[2])
        imba_force = max(0.0, residual_force - imba_threshold)
        imba_moment = max(0.0, residual_moment - imba_threshold * ship["L"] * 0.5)
        imbalanced = imba_force > 1.0 or imba_moment > 1.0
        if imbalanced and first_imbalance is None and t > 1e-9:
            first_imbalance = t
        for lid in extra_ids:
            if first_fail is None:
                ln = _line_by_id(lines, lid)
                first_fail = {"lineId": lid,
                              "name": ln.get("name", lid) if ln else lid, "time": t}

        util, line_T, strain, vangle, length3d = {}, {}, {}, {}, {}
        for ln in lines:
            T = tensions.get(ln["id"], 0.0)
            line_T[ln["id"]] = T
            util[ln["id"]] = T / max(ln["safeLoad"], 1e-9)
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

        comps = [("横风", w["mag_lat"]), ("顺风/顶风", w["mag_long"]),
                 ("横向流（落潮）", c["mag_lat"]), ("纵向流", c["mag_long"])]
        dominant = max(comps, key=lambda z: z[1])

        steps.append({
            "t": t,
            "state": {"x": state[0], "y": state[1], "psi": state[2]},
            "displacement": {"x": state[0] - state0[0], "y": state[1] - state0[1]},
            "tensions": line_T, "util": util, "strain": strain,
            "vAngle": vangle, "length3d": length3d,
            "failed": {ln["id"]: ln.get("failed", False) for ln in lines},
            "active": {ln["id"]: ln.get("active", True) for ln in lines},
            "residual": {"fx": R[0], "fy": R[1], "m": R[2],
                         "force": residual_force, "moment": residual_moment},
            "env": {"tide": env["tide"], "windSpeed": env["windSpeed"],
                    "windDir": env["windDir"], "currentSpeed": env["currentSpeed"],
                    "currentDir": env.get("currentDir", 0.0),
                    "draft": env["draft"], "areaX": env["areaX"], "areaY": env["areaY"]},
            "loads": {"wind": {"fx": w["fx"], "fy": w["fy"], "m": w["m"]},
                      "current": {"fx": c["fx"], "fy": c["fy"], "m": c["m"]}},
            "tugs": [{"actionId": g["actionId"], "name": g["name"], "force": g["force"],
                      "fx": g["force"] * math.cos(g["angle"]),
                      "fy": g["force"] * math.sin(g["angle"]),
                      "angle": g["angle"], "t0": g["t0"], "t1": g["t1"]}
                     for g in live_tugs],
            "dominant": dominant[0], "dominantMag": dominant[1],
            "imbalanced": imbalanced,
            "newFailures": extra_ids,
            "events": step_events,
        })

    max_util = {ln["id"]: 0.0 for ln in lines}
    max_util_t = {ln["id"]: 0.0 for ln in lines}
    max_residual = max_disp = 0.0
    for s in steps:
        for lid, u in s["util"].items():
            if u > max_util[lid]:
                max_util[lid] = u
                max_util_t[lid] = s["t"]
        max_residual = max(max_residual, s["residual"]["force"])
        max_disp = max(max_disp, math.hypot(s["displacement"]["x"], s["displacement"]["y"]))
    if first_fail is None:
        for ln in lines:
            if ln.get("failed"):
                if first_fail is None or ln.get("failTime", 0) < first_fail["time"]:
                    first_fail = {"lineId": ln["id"], "name": ln.get("name", ln["id"]),
                                  "time": ln.get("failTime", 0.0)}

    result_ids = {r["actionId"] for r in action_results}
    structural = [{"actionId": e["id"], "reason": e["reason"]}
                  for e in struct_errors if e["id"] not in result_ids]
    summary = {
        "firstImbalance": first_imbalance,
        "firstFailure": first_fail,
        "maxResidual": max_residual,
        "maxDisplacement": max_disp,
        "maxUtil": max_util,
        "maxUtilTime": max_util_t,
        "balanced": first_imbalance is None and first_fail is None,
        "nSteps": len(steps),
        "nActions": len(norm_actions),
        "nApplied": sum(1 for r in action_results if r["status"] == "applied"),
        "nRejected": sum(1 for r in action_results if r["status"] == "rejected"),
        "nCascadeFailures": sum(len(r["cascadedFailures"]) for r in action_results),
    }
    return {"steps": steps, "summary": summary,
            "actionResults": action_results, "structuralErrors": structural,
            "actions": norm_actions}


def _action_target(a, lines):
    if a["type"] == "tugForce":
        return a.get("name", "拖轮")
    ln = _line_by_id(lines, a.get("lineId"))
    return ln.get("name", a.get("lineId")) if ln else a.get("lineId")


def find_latest_intervention(scenario, plan, actions, t_lo, t_hi,
                             resolution=None, tol=0.05):
    """在 [t_lo, t_hi] 内整体平移动作触发时刻，反复推演找最晚可行介入时刻。

    “可行”= 推演全程不出现失衡（自动断缆允许发生，但不能发展到未平衡载荷
    越限）。网格从晚到早扫描，找到首个可行点后在该点与相邻失败点之间
    二分细化到 tol。返回最晚可行时刻、紧邻失败时刻及对应两次推演结果。
    """
    duration = float(scenario["duration"])
    dt = float(scenario.get("dt", 0.25))
    t_lo = max(0.0, min(duration, float(t_lo)))
    t_hi = max(0.0, min(duration, float(t_hi)))
    if t_hi < t_lo:
        t_lo, t_hi = t_hi, t_lo
    base_t = min(float(a.get("t", 0.0)) for a in actions) if actions else 0.0
    resolution = max(float(resolution), dt) if resolution else max(dt, 0.25)

    norm0, errs0 = normalize_actions(actions, duration)
    if errs0:
        return {"feasible": False, "reason": "动作表存在错误：" +
                "；".join(e["reason"] for e in errs0)}

    def shifted(delta):
        moved = []
        for a in norm0:
            b = dict(a)
            b["t"] = round(max(0.0, min(duration, a["t"] + delta)), 6)
            moved.append(b)
        return moved

    def feasible(delta):
        r = run_emergency(scenario, plan, shifted(delta), dt=dt)
        return r["summary"]["balanced"], r

    grid = []
    k = int(round((t_hi - t_lo) / resolution))
    for j in range(k, -1, -1):
        grid.append(round(min(t_hi, t_lo + j * resolution), 6))

    best = best_run = None
    nearest_fail = fail_run = None
    prev = prev_run = None
    for cand in grid:
        ok, run = feasible(cand - base_t)
        if ok:
            best, best_run = cand, run
            nearest_fail, fail_run = prev, prev_run
            break
        prev, prev_run = cand, run

    if best is None:
        return {"feasible": False,
                "reason": f"在 [{t_lo:.2f}, {t_hi:.2f}]h 内任何时刻介入均无法避免失衡；"
                          f"请加大拖轮力/延长持续时间，或提前到 {t_lo:.2f}h 之前。",
                "testedAt": grid, "resolution": resolution}

    if nearest_fail is None:
        # 整段网格都可行：再探窗口上界之外一个分辨率，确认边界
        hi = min(duration, t_hi + resolution)
        ok, run = feasible(hi - base_t)
        if ok:
            return _latest_result(t_hi, None, best_run, None, resolution)
        nearest_fail, fail_run = hi, run

    lo = best
    for _ in range(40):
        if nearest_fail - lo <= tol:
            break
        mid = (lo + nearest_fail) / 2
        ok, run = feasible(mid - base_t)
        if ok:
            lo, best_run = mid, run
        else:
            nearest_fail, fail_run = mid, run
    return _latest_result(lo, nearest_fail, best_run, fail_run, resolution)


def _latest_result(latest, fail_at, run_ok, run_fail, resolution):
    return {
        "feasible": True,
        "latestTime": round(latest, 4),
        "nearestFailTime": None if fail_at is None else round(fail_at, 4),
        "margin": None if fail_at is None else round(fail_at - latest, 4),
        "resolution": resolution,
        "actions": run_ok["actions"],
        "run": run_ok,
        "failRun": run_fail,
        "summary": run_ok["summary"],
    }
