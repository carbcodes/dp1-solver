// DP1 solver engine: expression language, model, statics, internal loads, stresses, deflection, cost.
// No DOM access, so tests can run it under Node.
const DP1 = (() => {
  'use strict';

  // ---------------------------------------------------------------- units
  const IN = 0.0254, LBF = 4.4482216, KSI = 6.894757e6;
  const UNITS = {
    '': 1, '—': 1, 'bool': 1, 'm': 1, 'mm': 1e-3, 'in': IN, 'ft': 0.3048, 'µm': 1e-6,
    'm²': 1, 'mm²': 1e-6, 'in²': IN * IN, 'mm³': 1e-9, 'mm⁴': 1e-12, 'in⁴': IN ** 4,
    'N': 1, 'kN': 1e3, 'lbf': LBF, 'N/m': 1, 'lb/ft': LBF / 0.3048, 'N·m': 1, 'W': 1,
    'Pa': 1, 'MPa': 1e6, 'GPa': 1e9, 'ksi': KSI, 'm/s': 1, 'm/s²': 1, 'kg/m³': 1,
    'rpm': 1, 'rad/s': 1, 'rad': 1, 'mrad': 1e-3, 'deg': Math.PI / 180, '%': 0.01, '$': 1, 'MPa/N·m': 1e6,
  };
  const toSI = (v, u) => v * (UNITS[u] ?? 1);
  const fromSI = (v, u) => v / (UNITS[u] ?? 1);

  // ---------------------------------------------------------------- ISO 286 tolerance grades (µm)
  const IT_RANGES = [3, 6, 10, 18, 30, 50, 80, 120];
  const IT_TABLE = {
    6: [6, 8, 9, 11, 13, 16, 19, 22],
    7: [10, 12, 15, 18, 21, 25, 30, 35],
    8: [14, 18, 22, 27, 33, 39, 46, 54],
    9: [25, 30, 36, 43, 52, 62, 74, 87],
    10: [40, 48, 58, 70, 84, 100, 120, 140],
    11: [60, 75, 90, 110, 130, 160, 190, 220],
  };
  function itol(d, grade) {
    const mm = d * 1000, row = IT_TABLE[Math.round(grade)] || IT_TABLE[8];
    let i = IT_RANGES.findIndex(r => mm <= r);
    if (i < 0) i = IT_RANGES.length - 1;
    return row[i] * 1e-6;
  }

  // ---------------------------------------------------------------- expression language
  function tokenize(src) {
    const out = [], re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(>=|<=|[-+*/^(),<>]))/y;
    let m, pos = 0;
    src = String(src);
    while (pos < src.length) {
      re.lastIndex = pos;
      m = re.exec(src);
      if (!m) {
        if (/^\s*$/.test(src.slice(pos))) break;
        throw new Error(`Unexpected “${src.slice(pos).trim()[0]}”`);
      }
      pos = re.lastIndex;
      if (m[1] !== undefined) out.push({ k: 'num', v: parseFloat(m[1]) });
      else if (m[2] !== undefined) out.push({ k: 'id', v: m[2] });
      else if (m[3] !== undefined) out.push({ k: 'op', v: m[3] });
    }
    return out;
  }

  function parse(src) {
    const toks = tokenize(src);
    let i = 0;
    const peek = () => toks[i], next = () => toks[i++];
    const isOp = (v) => toks[i] && toks[i].k === 'op' && toks[i].v === v;
    const expect = (v) => { if (!isOp(v)) throw new Error(`Expected “${v}”`); i++; };
    function compare() {
      let a = add();
      for (const op of ['>=', '<=', '>', '<']) if (isOp(op)) { i++; return { t: 'cmp', op, a, b: add() }; }
      return a;
    }
    function add() {
      let a = mul();
      while (isOp('+') || isOp('-')) { const op = next().v; a = { t: 'bin', op, a, b: mul() }; }
      return a;
    }
    function mul() {
      let a = unary();
      while (isOp('*') || isOp('/')) { const op = next().v; a = { t: 'bin', op, a, b: unary() }; }
      return a;
    }
    function unary() {
      if (isOp('-')) { i++; return { t: 'neg', a: unary() }; }
      if (isOp('+')) { i++; return unary(); }
      return power();
    }
    function power() {
      const base = primary();
      if (isOp('^')) { i++; return { t: 'bin', op: '^', a: base, b: unary() }; }
      return base;
    }
    function primary() {
      const tk = next();
      if (!tk) throw new Error('Expression ends early');
      if (tk.k === 'num') return { t: 'num', v: tk.v };
      if (tk.k === 'id') {
        if (isOp('(')) {
          i++;
          const args = [];
          if (!isOp(')')) { args.push(compare()); while (isOp(',')) { i++; args.push(compare()); } }
          expect(')');
          if (!(tk.v in FUNCS)) throw new Error(`Unknown function ${tk.v}()`);
          return { t: 'call', f: tk.v, args };
        }
        return { t: 'var', n: tk.v };
      }
      if (tk.k === 'op' && tk.v === '(') { const e = compare(); expect(')'); return { t: 'paren', a: e }; }
      throw new Error(`Unexpected “${tk.v}”`);
    }
    if (!toks.length) throw new Error('Empty expression');
    const ast = compare();
    if (i < toks.length) throw new Error(`Unexpected “${toks[i].v}”`);
    return ast;
  }

  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    atan2: Math.atan2, sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, exp: Math.exp,
    ln: Math.log, log10: Math.log10, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    sign: Math.sign, hypot: Math.hypot, if: null, itol,
  };
  const CONSTS = { pi: Math.PI, e: Math.E };

  function evalAst(n, s) {
    switch (n.t) {
      case 'num': return n.v;
      case 'paren': return evalAst(n.a, s);
      case 'var': {
        const v = s[n.n];
        if (v !== undefined) return v;
        if (n.n in CONSTS) return CONSTS[n.n];
        throw new Error(`Unknown symbol ${n.n}`);
      }
      case 'neg': return -evalAst(n.a, s);
      case 'cmp': {
        const a = evalAst(n.a, s), b = evalAst(n.b, s);
        return (n.op === '>=' ? a >= b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : a < b) ? 1 : 0;
      }
      case 'bin': {
        const a = evalAst(n.a, s), b = evalAst(n.b, s);
        switch (n.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '^': return Math.pow(a, b); }
        break;
      }
      case 'call': {
        if (n.f === 'if') {
          if (n.args.length !== 3) throw new Error('if(condition, then, else) needs 3 arguments');
          return evalAst(n.args[0], s) ? evalAst(n.args[1], s) : evalAst(n.args[2], s);
        }
        return FUNCS[n.f](...n.args.map(a => evalAst(a, s)));
      }
    }
    throw new Error('Bad expression');
  }

  function deps(n, out = new Set()) {
    if (!n) return out;
    if (n.t === 'var' && !(n.n in CONSTS)) out.add(n.n);
    for (const k of ['a', 'b']) if (n[k]) deps(n[k], out);
    if (n.args) n.args.forEach(a => deps(a, out));
    return out;
  }

  // ---------------------------------------------------------------- names
  // Old short code name → descriptive Object_Quantity name. The model uses the new names;
  // scopes also carry the old ones as aliases so internal code keeps working.
  const NAMES = {
    v_w: 'Water_v', rho_w: 'Water_rho', H_r: 'Rotor_H', B_r: 'Rotor_B', eta_h: 'Rotor_eta', eta_e: 'Gen_eta', n_r: 'Rotor_rpm',
    D_1: 'RotorSpr_D', D_2: 'GenSpr_D', N_1: 'RotorSpr_N', N_2: 'GenSpr_N', C: 'Chain_C', q_ch: 'Chain_q',
    F_D: 'Rotor_Drag', W_R: 'Rotor_W', W_G: 'Gen_W', X_r: 'Rotor_x', L_0: 'Beam_L0',
    e_CG: 'RotorCG_below', e_COP: 'RotorCOP_below', e_ch: 'Chain_below', H_D: 'Diag_y', x_T: 'DiagTop_x',
    t_br: 'Bracket_t', Sy_br: 'Bracket_Sy', n_d: 'FoS_req', delta_a: 'CG_allow', w_min: 'Beam_wmin', a_max: 'Diag_xmax', k_e: 'Edge_k',
    inc_bw: 'Beam_Wincl', inc_ch: 'Chain_Wincl', K_d: 'Diag_K', e_g: 'Pin_gap', m_sh: 'Pin_planes', k_c: 'Pin_kc', G_fit: 'Hole_IT', kerf: 'Saw_kerf',
    a: 'Diag_x', tube: 'Beam_tube', w: 'Beam_w', h: 'Beam_h', t: 'Beam_t', E_b: 'Beam_E', G_b: 'Beam_G', Sy_b: 'Beam_Sy', rho_b: 'Beam_rho',
    b_p: 'Diag_w', t_p: 'Diag_t', E_d: 'Diag_E', Sy_d: 'Diag_Sy', rho_d: 'Diag_rho', d_p: 'Pin_d', Sy_p: 'Pin_Sy', p_tu: 'Pin_devUp', p_tl: 'Pin_devLow',
    A_sw: 'Rotor_A', P_f: 'Water_P', P_m: 'Rotor_P', P_e: 'Gen_P', omega_r: 'Rotor_omega', T_r: 'Rotor_T', n_g: 'Gen_rpm',
    R_1: 'RotorSpr_R', R_2: 'GenSpr_R', p_c: 'Chain_p', theta_c: 'Chain_theta', T_c: 'Chain_T', F_cx: 'Chain_Fx', F_cz: 'Chain_Fz', M_cg: 'Gen_M',
    L_ch: 'Chain_L', W_ch: 'Chain_W', W_ch1: 'Chain_Wrotor', W_ch2: 'Chain_Wgen',
    IT_h: 'Hole_tol', h_min: 'Hole_min', h_max: 'Hole_max', p_max: 'Pin_max', p_min: 'Pin_min', c_min: 'Fit_cmin', c_max: 'Fit_cmax',
    X_g: 'Gen_x', d_h: 'Hole_d', x_L: 'Beam_xL', x_E: 'Beam_xE', L_E: 'Beam_LE', F_brk: 'Pin_break', L_b: 'Beam_L', y_G: 'RotorCG_y', y_P: 'RotorCOP_y', y_c: 'Chain_y',
    s_D: 'Diag_z', s_P: 'Bracket_z', L_x: 'Diag_dx', L_D: 'Diag_L', u_x: 'Diag_ux', u_y: 'Diag_uy', phi_D: 'Diag_phi',
    A_b: 'Beam_A', I_z: 'Beam_Iz', I_y: 'Beam_Iy', A_m: 'Beam_Am', p_m: 'Beam_pm', b_l: 'Beam_long', c_s: 'Beam_short', J_b: 'Beam_J', k_T: 'Beam_kT',
    t_z: 'Hole_len', A_n: 'Beam_An', I_zn: 'Beam_Izn', I_yn: 'Beam_Iyn', Q_z: 'Beam_Qz', b_z: 'Beam_bz', Q_y: 'Beam_Qy', b_y: 'Beam_by', q_b: 'Beam_q', W_b: 'Beam_W',
    W_1: 'Rotor_Wtot', W_2: 'Gen_Wtot', X_b: 'Beam_xc', S_D: 'Diag_sum', Delta_D: 'Diag_diff', D_Fc: 'Diag_Front_cf', D_Rc: 'Diag_Rear_cf', R_yc: 'Wall_y_cf',
    S_x: 'Wall_xsum', Delta_x: 'Wall_xdiff', R_xFc: 'Wall_xFront_cf', R_xRc: 'Wall_xRear_cf', R_zc: 'Wall_z_cf',
    S_ab: 'Beam_Sall', S_ad: 'Diag_Sall', tau_ap: 'Pin_tauall',
    A_d: 'Diag_A', A_dn: 'Diag_An', I_d: 'Diag_I', r_d: 'Diag_r', SR_d: 'Diag_lambda', SR_1: 'Diag_lambda1', P_cr: 'Diag_Pcr', D_max: 'Diag_max', D_c: 'Diag_comp',
    sig_dn: 'Diag_sigN', M_dw: 'Diag_Mw', sig_dw: 'Diag_sigW', sig_d: 'Diag_sig', n_dy: 'Diag_nYield', n_dk: 'Diag_nBuck', del_F: 'Diag_dFront', del_R: 'Diag_dRear',
    L_cut: 'Diag_Lcut', L_dst: 'Diag_Lstock',
    F_pW: 'PinWall_F', tau_pW: 'PinWall_tau', sig_pW: 'PinWall_sigBend', sig_bbW: 'PinWall_sigBeam', sig_bkW: 'PinWall_sigBracket',
    tau_pD: 'PinDiag_tau', sig_pD: 'PinDiag_sigBend', sig_bbD: 'PinDiag_sigBeam', sig_bdD: 'PinDiag_sigPlate',
    tau_pT: 'PinTop_tau', sig_pT: 'PinTop_sigBend', sig_bdT: 'PinTop_sigPlate', sig_bkT: 'PinTop_sigBracket',
    F_WF: 'WallPin_Front', F_WR: 'WallPin_Rear', F_pin: 'Pin_F', A_p: 'Pin_A', tau_p: 'Pin_tau', n_ps: 'Pin_nShear', t_cb: 'Beam_tBear',
    a_pW: 'PinWall_arm', a_pD: 'PinDiag_arm', a_pT: 'PinTop_arm', M_pW: 'PinWall_M', M_pD: 'PinDiag_M', M_pT: 'PinTop_M', M_p: 'Pin_M', sig_pb: 'Pin_sigB', n_pb: 'Pin_nBend',
    sig_bb: 'Beam_sigBear', n_bb: 'Beam_nBear', sig_bd: 'Diag_sigBear', n_bd: 'Diag_nBear', sig_bk: 'Bracket_sigBear', n_bk: 'Bracket_nBear', L_grip: 'Pin_grip',
    delta_CG: 'RotorCG_delta',
    R_xF: 'Wall_xFront', R_yF: 'Wall_yFront', R_xR: 'Wall_xRear', R_yR: 'Wall_yRear', R_z: 'Wall_z', D_F: 'Diag_Front', D_R: 'Diag_Rear',
    dx_CG: 'RotorCG_dx', dy_CG: 'RotorCG_dy', dz_CG: 'RotorCG_dz', N_pk: 'Beam_Nmax', Vy_pk: 'Beam_Vymax', Vz_pk: 'Beam_Vzmax', T_pk: 'Beam_Tmax',
    My_pk: 'Beam_Mymax', Mz_pk: 'Beam_Mzmax', vm_pk: 'Beam_sigVM', n_b: 'Beam_n',
  };
  const NEW2OLD = Object.fromEntries(Object.entries(NAMES).map(([o, n]) => [n, o]));
  const nameOf = (id) => NAMES[id] || id;
  const renameExpr = (expr) => String(expr).replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m) => NAMES[m] || m);
  const NAME_PAIRS = Object.entries(NAMES); // built once: alias runs several times per solve
  function alias(s, pairs = NAME_PAIRS) {
    for (let i = 0; i < pairs.length; i++) {
      const o = pairs[i][0], n = pairs[i][1], a = s[n], b = s[o];
      if (a !== undefined) { if (b === undefined) s[o] = a; }
      else if (b !== undefined) s[n] = b;
    }
    return s;
  }

  // ---------------------------------------------------------------- LaTeX rendering
  const GREEK = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'phi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Sigma', 'Phi', 'Psi', 'Omega']);
  const PREFIX = { sig: '\\sigma', del: '\\delta' };
  const TEX_OVERRIDE = { pi: '\\pi', Str_sN: '\\sigma_{axial}', Str_sMz: '\\sigma_{bend,vert}', Str_sMy: '\\sigma_{bend,side}', Str_tT: '\\tau_{torsion}', Str_tVy: '\\tau_{shear,vert}', Str_tVz: '\\tau_{shear,side}', Str_sig: '\\sigma', Str_tau: '\\tau',
    Def_dF: '\\delta_{diag,front}', Def_dR: '\\delta_{diag,rear}', Def_vF: 'v_{pin,front}', Def_vR: 'v_{pin,rear}', Def_thx: '\\theta_{twist,rigid}', Def_thz: '\\theta_{pitch,rigid}',
    Def_uA: 'u_{diag\\ pins}', Def_bowSlopeA: "w'_{diag\\ pins}", Def_uF: 'u_{pin,front}', Def_uR: 'u_{pin,rear}', Def_uRot: 'u_{rotor}', Def_slopeRot: "v'_{rotor}", Def_sagRot: 'v_{rotor}', Def_bowRot: 'w_{rotor}', Def_twistRot: '\\theta_{twist,elastic}' };
  function subTeX(parts) {
    return parts.map(p => (p.length > 1 && !GREEK.has(p) && !/^\d+$/.test(p)) ? `\\mathrm{${p}}` : (GREEK.has(p) ? `\\${p}` : p)).join(',');
  }
  // Object_Quantity → \mathit{Object}_{Quantity}; greek words in the quantity become symbols.
  const GREEK_PREFIX = /^(sigma|sig|tau|delta|lambda|theta|phi|omega|eta|rho|mu|kappa)(.*)$/;
  function subPart(p) {
    const m = p.match(GREEK_PREFIX);
    if (m) { const g = { sig: 'sigma' }[m[1]] || m[1]; return `\\${g}${m[2] ? `_{\\mathrm{${m[2]}}}` : ''}`; }
    if (p.length === 1) return p;
    return `\\mathrm{${p}}`;
  }
  // Variable classes for colouring: k = known (given), d = design variable (a direct choice),
  // g = calculated from design variables, u = unknown (depends on reactions).
  const CLASS_COLOR = { k: '#202124', d: '#007AFF', g: '#1E8E3E', u: '#BB322D' };
  let CLASSES = { Wall_y: 'u', Chain_Tslack: 'k' };
  const classOf = (name) => CLASSES[nameOf(name)] || null;
  function classify(model) {
    const c = { Wall_y: 'u', Chain_Tslack: 'k' };
    for (const i of model.inputs) c[i.id] = i.g === 'd' ? 'd' : 'k';
    for (const u of model.unknowns) c[u.id] = 'u';
    for (const n of ENGINE_OUT) c[nameOf(n)] = 'u';
    const byId = new Map(model.defs.map(d => [d.id, d]));
    const seen = {};
    const visit = (id, stack = new Set()) => {
      if (c[id] && !byId.has(id)) return c[id];
      if (seen[id]) return seen[id];
      if (stack.has(id)) return 'k';
      stack.add(id);
      const d = byId.get(id);
      let cls = 'k';
      if (d) {
        const cp = cparse(d.expr);
        if (!cp.err) for (const x of cp.deps) {
          const k = byId.has(x) ? visit(x, stack) : (c[x] || 'k');
          if (k === 'u') { cls = 'u'; break; }
          if (k === 'd' || k === 'g') cls = 'g';
        }
      }
      seen[id] = cls;
      return cls;
    };
    for (const d of model.defs) c[d.id] = visit(d.id);
    // loads on a cut face, the stresses they make and every deflection term depend on the reactions
    for (const k of ['N', 'Vy', 'Vz', 'T', 'My', 'Mz']) c['Cut_' + k] = 'u';
    for (const k of Object.keys(STRESS_FORMS)) c['Str_' + k] = 'u';
    for (const k of DEFL_NAMES) c['Def_' + k] = 'u';
    for (const k of ['A', 'Iz', 'Iy']) c['Sec_' + k] = 'g';
    CLASSES = c;
    return c;
  }
  function symTeX(name, opts = {}) {
    name = nameOf(name);
    const raw = symTeXraw(name);
    const cls = opts.plain ? null : CLASSES[name];
    const out = cls && cls !== 'k' ? `\\textcolor{${CLASS_COLOR[cls]}}{${raw}}` : raw;
    // the page turns this on so every typeset variable carries its name (hover card)
    return HOVER && !opts.plain && /^\w+$/.test(name) ? `\\htmlData{v=${name}}{${out}}` : out;
  }
  let HOVER = false;
  const setHover = (on) => { HOVER = !!on; };
  function symTeXraw(name) {
    if (TEX_OVERRIDE[name]) return TEX_OVERRIDE[name];
    const parts = name.split('_');
    const base = parts[0], sub = parts.slice(1);
    let b;
    if (GREEK.has(base)) b = `\\${base}`;
    else if (base.length === 1) b = base;
    else b = `\\mathit{${base}}`;
    if (!sub.length) return b;
    const inner = sub.map(subPart).join(',\\,');
    return `${b}_{${inner}}`;
  }

  function fmtNum(v, sig = 4) {
    if (!isFinite(v)) return v > 0 ? '\\infty' : (v < 0 ? '-\\infty' : '\\text{NaN}');
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) {
      const e = Math.floor(Math.log10(a)), m = v / Math.pow(10, e);
      return `${+m.toPrecision(sig)}\\times10^{${e}}`;
    }
    return String(+v.toPrecision(sig));
  }

  const PREC = { cmp: 0, '+': 1, '-': 1, neg: 1.5, '*': 2, '/': 3, '^': 4, atom: 5 };
  function precOf(n) {
    if (n.t === 'paren') return precOf(n.a); // brackets are re-added by precedence, so look through them
    if (n.t === 'bin') return PREC[n.op];
    if (n.t === 'neg') return PREC.neg;
    if (n.t === 'cmp') return 0;
    if (n.t === 'num' && n.v < 0) return PREC.neg;
    return PREC.atom;
  }
  const paren = (s) => `\\left(${s}\\right)`;

  // opts.values: substitute variables with numbers (SI); opts.unitOf(name) optional
  function toTeX(n, opts = {}) {
    const T = (x) => toTeX(x, opts);
    switch (n.t) {
      case 'num': return fmtNum(n.v, opts.sig || 6);
      case 'paren': return T(n.a);
      case 'var': {
        if (opts.values && n.n in opts.values) {
          const v = opts.values[n.n];
          const s = fmtNum(v, 4);
          return v < 0 ? paren(s) : s;
        }
        if (n.n === 'pi' && !opts.values) return '\\pi';
        if (n.n === 'pi') return '\\pi';
        return symTeX(n.n);
      }
      case 'neg': {
        const inner = T(n.a);
        return precOf(n.a) <= PREC['-'] || (n.a.t === 'neg') ? `-${paren(inner)}` : `-${inner}`;
      }
      case 'cmp': return `${T(n.a)} ${{ '>=': '\\ge', '<=': '\\le', '>': '>', '<': '<' }[n.op]} ${T(n.b)}`;
      case 'bin': {
        const { op, a, b } = n;
        if (op === '+') {
          if (b.t === 'neg') return `${T(a)} - ${precOf(b.a) <= 1 ? paren(T(b.a)) : T(b.a)}`;
          return `${T(a)} + ${T(b)}`;
        }
        if (op === '-') return `${T(a)} - ${precOf(b) <= 1 ? paren(T(b)) : T(b)}`;
        if (op === '/') return `\\dfrac{${T(a)}}{${T(b)}}`;
        if (op === '^') {
          const base = (precOf(a) < PREC.atom || (a.t === 'var' && opts.values && a.n in opts.values) || a.t === 'call') ? paren(T(a)) : T(a);
          return `${base}^{${T(b)}}`;
        }
        if (op === '*') {
          const L = precOf(a) < PREC['*'] ? paren(T(a)) : T(a);
          const rawR = T(b);
          const R = (precOf(b) < PREC['*'] || (b.t === 'neg')) ? paren(rawR) : rawR;
          const numeric = opts.values || b.t === 'num' || (b.t === 'paren' && false) || /^[\d-]/.test(R);
          return numeric ? `${L} \\cdot ${R}` : `${L}\\,${R}`;
        }
        break;
      }
      case 'call': {
        const args = n.args.map(T);
        switch (n.f) {
          case 'sqrt': return `\\sqrt{${args[0]}}`;
          case 'abs': return `\\left|${args[0]}\\right|`;
          case 'if': return `\\begin{cases} ${args[1]} & \\text{if } ${args[0]} \\\\ ${args[2]} & \\text{otherwise} \\end{cases}`;
          case 'itol': return `\\mathrm{IT}_{${args[1]}}\\!\\left(${args[0]}\\right)`;
          case 'hypot': return `\\sqrt{${n.args.map(x => `${precOf(x) < PREC.atom ? paren(T(x)) : T(x)}^{2}`).join(' + ')}}`;
          case 'ln': return `\\ln${paren(args[0])}`;
          case 'max': case 'min': case 'exp': case 'sin': case 'cos': case 'tan':
          case 'floor': case 'ceil': case 'round':
            return `\\${['floor', 'ceil', 'round'].includes(n.f) ? 'operatorname{' + n.f + '}' : n.f}${paren(args.join(',\\ '))}`;
          case 'asin': return `\\sin^{-1}${paren(args[0])}`;
          case 'acos': return `\\cos^{-1}${paren(args[0])}`;
          case 'atan': return `\\tan^{-1}${paren(args[0])}`;
          default: return `\\operatorname{${n.f}}${paren(args.join(',\\ '))}`;
        }
      }
    }
    return '?';
  }

  // Small AST builders with trivial simplification, for symbolic equilibrium terms
  const isZero = (n) => n && ((n.t === 'num' && n.v === 0) || (n.t === 'paren' && isZero(n.a)) || (n.t === 'neg' && isZero(n.a)));
  const isOne = (n) => n && n.t === 'num' && n.v === 1;
  const strip = (n) => (n.t === 'paren' ? strip(n.a) : n);
  const A = {
    num: (v) => ({ t: 'num', v }),
    sub(a, b) { if (isZero(b)) return a; if (isZero(a)) return A.neg(b); return { t: 'bin', op: '-', a, b }; },
    add(a, b) { if (isZero(a)) return b; if (isZero(b)) return a; return { t: 'bin', op: '+', a, b }; },
    mul(a, b) {
      a = strip(a); b = strip(b);
      if (isZero(a) || isZero(b)) return A.num(0);
      if (isOne(a)) return b; if (isOne(b)) return a;
      if (a.t === 'neg' && b.t === 'neg') return A.mul(a.a, b.a);
      if (a.t === 'neg') return A.neg(A.mul(a.a, b));
      if (b.t === 'neg') return A.neg(A.mul(a, b.a));
      return { t: 'bin', op: '*', a, b };
    },
    neg(a) { a = strip(a); if (isZero(a)) return A.num(0); if (a.t === 'neg') return a.a; return { t: 'neg', a }; },
  };

  // ---------------------------------------------------------------- default model
  // Inputs carry values in their display unit. g: given (problem/Piazza), a: assumption, d: design variable.
  const INPUTS = [
    // flow and power
    { id: 'v_w', label: 'Water speed', v: 2.5, unit: 'm/s', g: 'g', src: 'Req. 1' },
    { id: 'rho_w', label: 'Water density (fresh water, ~20 °C)', v: 1000, unit: 'kg/m³', g: 'a', src: 'L5' },
    { id: 'H_r', label: 'Rotor height', v: 500, unit: 'mm', g: 'g', src: 'Req. 1' },
    { id: 'B_r', label: 'Rotor width', v: 500, unit: 'mm', g: 'g', src: 'Req. 1' },
    { id: 'eta_h', label: 'Hydraulic efficiency', v: 30, unit: '%', g: 'g', src: 'Req. 2' },
    { id: 'eta_e', label: 'Mechanical → electrical efficiency', v: 82, unit: '%', g: 'g', src: 'Req. 2' },
    { id: 'n_r', label: 'Rotor speed', v: 285, unit: 'rpm', g: 'g', src: 'Req. 2' },
    // drive
    { id: 'D_1', label: 'Rotor sprocket pitch diameter (60T)', v: 9.554, unit: 'in', g: 'g', src: 'Req. 4' },
    { id: 'D_2', label: 'Generator sprocket pitch diameter (19T)', v: 3.038, unit: 'in', g: 'g', src: 'Req. 4' },
    { id: 'N_1', label: 'Rotor sprocket teeth', v: 60, unit: '', g: 'g', src: 'Fig. 2' },
    { id: 'N_2', label: 'Generator sprocket teeth', v: 19, unit: '', g: 'g', src: 'Fig. 2' },
    { id: 'C', label: 'Sprocket center distance', v: 39.49, unit: 'in', g: 'g', src: 'Fig. 2 [verify]' },
    { id: 'q_ch', label: 'Chain weight per length (ANSI #40)', v: 0.42, unit: 'lb/ft', g: 'a', src: 'L3' },
    // loads
    { id: 'F_D', label: 'Water drag on rotor (+z)', v: 560, unit: 'N', g: 'g', src: 'Req. 5' },
    { id: 'W_R', label: 'Rotor + shaft + sprocket + shaft box weight', v: 150, unit: 'N', g: 'g', src: 'Req. 8, @12' },
    { id: 'W_G', label: 'Generator + sprocket weight', v: 120, unit: 'N', g: 'g', src: 'Req. 8' },
    { id: 'g', label: 'Gravity', v: 9.81, unit: 'm/s²', g: 'g', src: '' },
    // geometry (Figure 2)
    { id: 'X_r', label: 'Rotor axis → wall pin (x)', v: 1200, unit: 'mm', g: 'g', src: 'Fig. 2' },
    { id: 'L_0', label: 'Rotor axis → beam left end', v: 100, unit: 'mm', g: 'g', src: 'Req. 6' },
    { id: 'L_E', label: 'Wall pin → beam right end', v: 50, unit: 'mm', g: 'g', src: 'Fig. 2 (bottom view)' },
    { id: 'e_CG', label: 'Beam bottom → rotor CG', v: 350, unit: 'mm', g: 'g', src: 'Req. 8, Fig. 2' },
    { id: 'e_COP', label: 'Beam bottom → drag COP', v: 500, unit: 'mm', g: 'g', src: 'Fig. 2 [verify]' },
    { id: 'e_ch', label: 'Beam bottom → chain plane', v: 50, unit: 'mm', g: 'g', src: 'Fig. 2 [verify]' },
    { id: 'H_D', label: 'Diagonal top pin height above beam pin line', v: 500, unit: 'mm', g: 'g', src: 'Fig. 2' },
    { id: 'x_T', label: 'Diagonal top pin x (from wall pin, + toward wall)', v: 0, unit: 'mm', g: 'a', src: 'G3 [verify]' },
    { id: 't_br', label: 'Bracket thickness', v: 0.5, unit: 'in', g: 'g', src: 'Req. 10' },
    { id: 'Sy_br', label: 'Bracket yield strength (Al)', v: 35, unit: 'ksi', g: 'g', src: 'Req. 10' },
    // requirements
    { id: 'n_d', label: 'Design factor of safety', v: 2, unit: '', g: 'g', src: 'Req. 11' },
    { id: 'delta_a', label: 'Allowed CG deflection', v: 0.7, unit: 'mm', g: 'g', src: 'Req. 12' },
    { id: 'w_min', label: 'Minimum beam width (z)', v: 4, unit: 'in', g: 'g', src: 'Req. 13' },
    { id: 'a_max', label: 'Max diagonal attach distance', v: 800, unit: 'mm', g: 'g', src: 'Fig. 2' },
    { id: 'F_brk', label: 'Pin rated single-shear breaking strength from McMaster (0 = not listed)', v: 0, unit: 'N', g: 'd', src: 'McMaster' },
    { id: 'k_e', label: 'Edge distance / hole diameter', v: 2, unit: '', g: 'g', src: 'Req. 9' },
    // modelling switches & factors
    { id: 'inc_bw', label: 'Include beam self-weight', v: 1, unit: 'bool', g: 'a', src: 'section 2' },
    { id: 'inc_ch', label: 'Include chain weight (not given by the problem; neglected)', v: 0, unit: 'bool', g: 'a', src: 'L3' },
    { id: 'K_d', label: 'Diagonal buckling effective-length factor', v: 1, unit: '', g: 'a', src: 'D1' },
    { id: 'm_sh', label: 'Pin shear planes per side', v: 1, unit: '', g: 'a', src: 'P1/P2' },
    { id: 'e_g', label: 'Gap between plate/bracket and beam wall (pin bending arm)', v: 0, unit: 'mm', g: 'a', src: 'P1/P2' },
    { id: 'k_c', label: 'Solid-beam pin contact length / d (Piazza @20)', v: 1, unit: '', g: 'a', src: 'P3' },
    { id: 'G_fit', label: 'Hole tolerance grade (H)', v: 8, unit: '', g: 'd', src: 'ISO 286' },
    { id: 'kerf', label: 'Saw kerf between the two diagonals', v: 3, unit: 'mm', g: 'a', src: '' },
    // design variables (set from the catalog, editable directly)
    { id: 'a', label: 'Diagonal attach distance from wall pin', v: 500, unit: 'mm', g: 'd', src: '' },
    { id: 'tube', label: 'Beam is a hollow rectangular tube', v: 1, unit: 'bool', g: 'd', src: '' },
    { id: 'w', label: 'Beam width (z)', v: 6, unit: 'in', g: 'd', src: '' },
    { id: 'h', label: 'Beam height (y)', v: 3, unit: 'in', g: 'd', src: '' },
    { id: 't', label: 'Beam wall thickness (solid: min(w,h)/2)', v: 0.25, unit: 'in', g: 'd', src: '' },
    { id: 'E_b', label: 'Beam modulus E', v: 190, unit: 'GPa', g: 'd', src: 'Shigley A-5' },
    { id: 'G_b', label: 'Beam shear modulus G', v: 73.1, unit: 'GPa', g: 'd', src: 'Shigley A-5' },
    { id: 'Sy_b', label: 'Beam yield strength', v: 276, unit: 'MPa', g: 'd', src: 'Shigley A-23' },
    { id: 'rho_b', label: 'Beam density', v: 8000, unit: 'kg/m³', g: 'd', src: '' },
    { id: 'b_p', label: 'Diagonal plate width', v: 2, unit: 'in', g: 'd', src: '' },
    { id: 't_p', label: 'Diagonal plate thickness', v: 0.375, unit: 'in', g: 'd', src: '' },
    { id: 'E_d', label: 'Diagonal modulus E', v: 190, unit: 'GPa', g: 'd', src: 'Shigley A-5' },
    { id: 'Sy_d', label: 'Diagonal yield strength', v: 276, unit: 'MPa', g: 'd', src: 'Shigley A-23' },
    { id: 'rho_d', label: 'Diagonal density', v: 8000, unit: 'kg/m³', g: 'd', src: '' },
    { id: 'd_p', label: 'Pin diameter', v: 0.5, unit: 'in', g: 'd', src: '' },
    { id: 'Sy_p', label: 'Pin yield strength', v: 724, unit: 'MPa', g: 'd', src: '17-4 PH H1150 [verify]' },
    { id: 'p_tu', label: 'Pin diameter upper deviation', v: 0, unit: 'in', g: 'g', src: 'McMaster 98404A670 listing' },
    { id: 'p_tl', label: 'Pin diameter lower deviation', v: -0.003, unit: 'in', g: 'g', src: 'McMaster 98404A670 listing' },
  ];

  // Derived quantities. expr is in SI; unit is the display unit.
  const DEFS = [
    // 1 · power
    { id: 'A_sw', s: 'power', expr: 'H_r*B_r', unit: 'm²', label: 'Swept area' },
    { id: 'P_f', s: 'power', expr: '1/2*rho_w*A_sw*v_w^3', unit: 'W', label: 'Fluid power through the swept area', note: 'Kinetic-energy flux ṁ·v²/2 with ṁ = ρAv.' },
    { id: 'P_m', s: 'power', expr: 'eta_h*P_f', unit: 'W', label: 'Mechanical (shaft) power' },
    { id: 'P_e', s: 'power', expr: 'eta_e*P_m', unit: 'W', label: 'Electrical power' },
    { id: 'omega_r', s: 'power', expr: '2*pi*n_r/60', unit: 'rad/s', label: 'Rotor angular speed' },
    { id: 'T_r', s: 'power', expr: 'P_m/omega_r', unit: 'N·m', label: 'Rotor shaft torque (P = Tω, Piazza @19)' },
    { id: 'n_g', s: 'power', expr: 'n_r*N_1/N_2', unit: 'rpm', label: 'Generator speed (check ≈ 900 rpm)' },
    // 2 · chain
    { id: 'R_1', s: 'chain', expr: 'D_1/2', unit: 'mm', label: 'Rotor sprocket pitch radius' },
    { id: 'R_2', s: 'chain', expr: 'D_2/2', unit: 'mm', label: 'Generator sprocket pitch radius' },
    { id: 'p_c', s: 'chain', expr: 'D_1*sin(pi/N_1)', unit: 'in', label: 'Chain pitch from sprocket geometry (0.5 in → ANSI #40)' },
    { id: 'theta_c', s: 'chain', expr: 'asin((R_1-R_2)/C)', unit: 'deg', label: 'Strand angle to the x axis (open drive)' },
    { id: 'T_c', s: 'chain', expr: 'T_r/R_1', unit: 'N', label: 'Tight-strand tension (slack side ≈ 0, no preload)' },
    { id: 'F_cx', s: 'chain', expr: 'T_c*cos(theta_c)', unit: 'N', label: 'Strand force, x component' },
    { id: 'F_cz', s: 'chain', expr: 'T_c*sin(theta_c)', unit: 'N', label: 'Strand force, z component (tight strand at rear)' },
    { id: 'M_cg', s: 'chain', expr: 'T_c*R_2', unit: 'N·m', label: 'Couple from moving the generator strand force to its axis (+y)' },
    { id: 'L_ch', s: 'chain', expr: '2*C*cos(theta_c)+(pi+2*theta_c)*R_1+(pi-2*theta_c)*R_2', unit: 'mm', label: 'Chain length (open belt geometry)' },
    { id: 'W_ch', s: 'chain', expr: 'q_ch*L_ch', unit: 'N', label: 'Chain weight' },
    { id: 'W_ch1', s: 'chain', expr: 'inc_ch*q_ch*((pi+2*theta_c)*R_1+C*cos(theta_c))', unit: 'N', label: 'Chain weight carried by rotor sprocket (wrap + half of both strands)' },
    { id: 'W_ch2', s: 'chain', expr: 'inc_ch*q_ch*((pi-2*theta_c)*R_2+C*cos(theta_c))', unit: 'N', label: 'Chain weight carried by generator sprocket' },
    // hole and fit
    { id: 'IT_h', s: 'hole', expr: 'itol(d_p,G_fit)', unit: 'µm', label: 'Hole tolerance band (ISO 286-1 IT grade for this size)' },
    { id: 'h_min', s: 'hole', expr: 'd_p', unit: 'in', label: 'Smallest hole (H: lower deviation 0)' },
    { id: 'h_max', s: 'hole', expr: 'd_p+IT_h', unit: 'in', label: 'Largest hole' },
    { id: 'p_max', s: 'hole', expr: 'd_p+p_tu', unit: 'in', label: 'Largest pin' },
    { id: 'p_min', s: 'hole', expr: 'd_p+p_tl', unit: 'in', label: 'Smallest pin' },
    { id: 'c_min', s: 'hole', expr: 'h_min-p_max', unit: 'in', label: 'Minimum diametral clearance (must be > 0 for hand insertion)' },
    { id: 'c_max', s: 'hole', expr: 'h_max-p_min', unit: 'in', label: 'Maximum diametral clearance' },
    // 3 · geometry
    { id: 'X_g', s: 'geom', expr: 'X_r-C', unit: 'mm', label: 'Generator axis → wall pin' },
    { id: 'd_h', s: 'geom', expr: 'h_max', unit: 'mm', label: 'Largest pin-hole diameter (H tolerance on nominal)' },
    { id: 'x_L', s: 'geom', expr: '-(X_r+L_0)', unit: 'mm', label: 'Beam left end' },
    { id: 'x_E', s: 'geom', expr: 'L_E', unit: 'mm', label: 'Beam right end (Fig. 2: 50 mm past the wall pin)' },
    { id: 'L_b', s: 'geom', expr: 'x_E-x_L', unit: 'mm', label: 'Beam length' },
    { id: 'y_G', s: 'geom', expr: '-(h/2+e_CG)', unit: 'mm', label: 'Rotor CG height' },
    { id: 'y_P', s: 'geom', expr: '-(h/2+e_COP)', unit: 'mm', label: 'Drag COP height' },
    { id: 'y_c', s: 'geom', expr: '-(h/2+e_ch)', unit: 'mm', label: 'Chain plane height' },
    { id: 's_D', s: 'geom', expr: 'w/2', unit: 'mm', label: 'Diagonal pin loads on the beam: front/rear beam face, |z| (Piazza @37)' },
    { id: 's_P', s: 'geom', expr: 'w/2', unit: 'mm', label: 'Wall pin loads on the beam: front/rear beam face, |z| (Piazza @37)' },
    { id: 'L_x', s: 'geom', expr: 'a+x_T', unit: 'mm', label: 'Diagonal horizontal run' },
    { id: 'L_D', s: 'geom', expr: 'sqrt(L_x^2+H_D^2)', unit: 'mm', label: 'Diagonal pin-to-pin length' },
    { id: 'u_x', s: 'geom', expr: 'L_x/L_D', unit: '', label: 'Diagonal direction cosine, x (beam pin → top pin)' },
    { id: 'u_y', s: 'geom', expr: 'H_D/L_D', unit: '', label: 'Diagonal direction cosine, y' },
    { id: 'phi_D', s: 'geom', expr: 'atan(H_D/L_x)', unit: 'deg', label: 'Diagonal angle above horizontal' },
    // 4 · beam section
    { id: 'A_b', s: 'section', expr: 'w*h-(w-2*t)*(h-2*t)', unit: 'mm²', label: 'Area' },
    { id: 'I_z', s: 'section', expr: '(w*h^3-(w-2*t)*(h-2*t)^3)/12', unit: 'mm⁴', label: 'Second moment about z (vertical bending)' },
    { id: 'I_y', s: 'section', expr: '(h*w^3-(h-2*t)*(w-2*t)^3)/12', unit: 'mm⁴', label: 'Second moment about y (horizontal bending)' },
    { id: 'A_m', s: 'section', expr: '(w-t)*(h-t)', unit: 'mm²', label: 'Area enclosed by wall mid-line (tube)' },
    { id: 'p_m', s: 'section', expr: '2*((w-t)+(h-t))', unit: 'mm', label: 'Mid-line perimeter (tube)' },
    { id: 'b_l', s: 'section', expr: 'max(w,h)', unit: 'mm', label: 'Long side' },
    { id: 'c_s', s: 'section', expr: 'min(w,h)', unit: 'mm', label: 'Short side' },
    { id: 'J_b', s: 'section', expr: 'if(tube, 4*A_m^2*t/p_m, b_l*c_s^3*(1/3-0.21*c_s/b_l*(1-c_s^4/(12*b_l^4))))', unit: 'mm⁴', label: 'Torsion constant (Bredt thin-wall tube / Roark solid rectangle)' },
    { id: 'k_T', s: 'section', expr: 'if(tube, 1/(2*A_m*t), (3+1.8*c_s/b_l)/(b_l*c_s^2))', unit: 'MPa/N·m', label: 'Max torsional shear per unit torque (Bredt / Shigley eq. 3-40)' },
    { id: 't_z', s: 'section', expr: 'if(tube, 2*t, w)', unit: 'mm', label: 'Material the pin hole passes through' },
    { id: 'A_n', s: 'section', expr: 'A_b-d_h*t_z', unit: 'mm²', label: 'Net area at a pin hole' },
    { id: 'I_zn', s: 'section', expr: 'I_z-t_z*d_h^3/12', unit: 'mm⁴', label: 'Net Beam_Iz at a pin hole' },
    { id: 'I_yn', s: 'section', expr: 'I_y-if(tube, 2*(d_h*t^3/12+d_h*t*((w-t)/2)^2), d_h*w^3/12)', unit: 'mm⁴', label: 'Net Beam_Iy at a pin hole' },
    { id: 'Q_z', s: 'section', expr: '(w*h^2-(w-2*t)*(h-2*t)^2)/8', unit: 'mm³', label: 'First moment of half section (for V_y)' },
    { id: 'b_z', s: 'section', expr: 'if(tube, 2*t, w)', unit: 'mm', label: 'Shear width at neutral axis (for V_y)' },
    { id: 'Q_y', s: 'section', expr: '(h*w^2-(h-2*t)*(w-2*t)^2)/8', unit: 'mm³', label: 'First moment of half section (for V_z)' },
    { id: 'b_y', s: 'section', expr: 'if(tube, 2*t, h)', unit: 'mm', label: 'Shear width at neutral axis (for V_z)' },
    { id: 'q_b', s: 'section', expr: 'inc_bw*rho_b*g*A_b', unit: 'N/m', label: 'Beam weight per length' },
    { id: 'W_b', s: 'section', expr: 'q_b*L_b', unit: 'N', label: 'Beam weight' },
    // 5 · closed-form reactions about O (default load set)
    { id: 'W_1', s: 'closed', expr: 'W_R+W_ch1', unit: 'N', label: 'Vertical load at the rotor axis' },
    { id: 'W_2', s: 'closed', expr: 'W_G+W_ch2', unit: 'N', label: 'Vertical load at the generator axis' },
    { id: 'X_b', s: 'closed', expr: '-(x_L+x_E)/2', unit: 'mm', label: 'Beam weight lever arm (centroid left of O)' },
    { id: 'S_D', s: 'closed', expr: '(X_r*W_1+X_g*W_2+X_b*W_b)/(a*u_y)', unit: 'N', label: 'Diag_Front + Diag_Rear, from ΣM_z,O = 0' },
    { id: 'Delta_D', s: 'closed', expr: '-F_D*y_P/(s_D*u_y)', unit: 'N', label: 'Diag_Rear − Diag_Front, from ΣM_x,O = 0' },
    { id: 'D_Fc', s: 'closed', expr: '(S_D-Delta_D)/2', unit: 'N', label: 'Front diagonal force (+ tension)' },
    { id: 'D_Rc', s: 'closed', expr: '(S_D+Delta_D)/2', unit: 'N', label: 'Rear diagonal force (+ tension)' },
    { id: 'R_yc', s: 'closed', expr: '(W_1+W_2+W_b-u_y*S_D)/2', unit: 'N', label: 'Wall-pin y force per side (Wall_y), from ΣF_y' },
    { id: 'S_x', s: 'closed', expr: '-u_x*S_D', unit: 'N', label: 'Wall_xFront + Wall_xRear, from ΣF_x' },
    { id: 'Delta_x', s: 'closed', expr: '-(X_r*F_D+T_r+u_x/u_y*F_D*y_P)/s_P', unit: 'N', label: 'Wall_xFront − Wall_xRear, from ΣM_y,O' },
    { id: 'R_xFc', s: 'closed', expr: '(S_x+Delta_x)/2', unit: 'N', label: 'Front wall-pin x force' },
    { id: 'R_xRc', s: 'closed', expr: '(S_x-Delta_x)/2', unit: 'N', label: 'Rear wall-pin x force' },
    { id: 'R_zc', s: 'closed', expr: '-F_D', unit: 'N', label: 'Wall thrust from ΣF_z' },
    // 6 · allowables
    { id: 'S_ab', s: 'allow', expr: 'Sy_b/n_d', unit: 'MPa', label: 'Beam allowable (von Mises)' },
    { id: 'S_ad', s: 'allow', expr: 'Sy_d/n_d', unit: 'MPa', label: 'Diagonal allowable' },
    { id: 'tau_ap', s: 'allow', expr: '0.577*Sy_p/n_d', unit: 'MPa', label: 'Pin shear allowable (distortion energy, Ssy = 0.577 Sy)' },
    // 7 · diagonals (post-solve)
    { id: 'A_d', s: 'diag', expr: 'b_p*t_p', unit: 'mm²', label: 'Plate gross area' },
    { id: 'A_dn', s: 'diag', expr: '(b_p-d_h)*t_p', unit: 'mm²', label: 'Plate net area at the hole' },
    { id: 'I_d', s: 'diag', expr: 'b_p*t_p^3/12', unit: 'mm⁴', label: 'Weak-axis second moment' },
    { id: 'r_d', s: 'diag', expr: 'sqrt(I_d/A_d)', unit: 'mm', label: 'Weak-axis radius of gyration' },
    { id: 'SR_d', s: 'diag', expr: 'K_d*L_D/r_d', unit: '', label: 'Slenderness ratio' },
    { id: 'SR_1', s: 'diag', expr: 'sqrt(2*pi^2*E_d/Sy_d)', unit: '', label: 'Euler/Johnson transition slenderness (Shigley §4-12/4-13)' },
    { id: 'P_cr', s: 'diag', expr: 'if(SR_d>=SR_1, pi^2*E_d*I_d/(K_d*L_D)^2, A_d*(Sy_d-(Sy_d*SR_d/(2*pi))^2/E_d))', unit: 'kN', label: 'Critical buckling load (Euler or Johnson)' },
    { id: 'D_max', s: 'diag', expr: 'max(abs(D_F),abs(D_R))', unit: 'N', label: 'Peak diagonal axial load' },
    { id: 'D_c', s: 'diag', expr: 'max(0,-D_F,-D_R)', unit: 'N', label: 'Peak diagonal compression' },
    { id: 'sig_dn', s: 'diag', expr: 'D_max/A_dn', unit: 'MPa', label: 'Axial stress on net section' },
    { id: 'M_dw', s: 'diag', expr: 'rho_d*g*A_d*u_x*L_D^2/8', unit: 'N·m', label: 'Self-weight bending (in-plane, simply supported)' },
    { id: 'sig_dw', s: 'diag', expr: '6*M_dw/(t_p*b_p^2)', unit: 'MPa', label: 'Self-weight bending stress' },
    { id: 'sig_d', s: 'diag', expr: 'sig_dn+sig_dw', unit: 'MPa', label: 'Max normal stress (conservative sum)' },
    { id: 'n_dy', s: 'diag', expr: 'Sy_d/sig_d', unit: '', label: 'Diagonal yield factor of safety' },
    { id: 'n_dk', s: 'diag', expr: 'P_cr/max(D_c,0.001)', unit: '', label: 'Diagonal buckling factor of safety' },
    { id: 'del_F', s: 'diag', expr: 'D_F*L_D/(E_d*A_d)', unit: 'mm', label: 'Front diagonal elongation' },
    { id: 'del_R', s: 'diag', expr: 'D_R*L_D/(E_d*A_d)', unit: 'mm', label: 'Rear diagonal elongation' },
    { id: 'L_cut', s: 'diag', expr: 'L_D+2*k_e*d_h', unit: 'mm', label: 'Cut length of one diagonal (edge distance each end)' },
    { id: 'L_dst', s: 'diag', expr: '2*L_cut+kerf', unit: 'mm', label: 'Stock length needed for two diagonals' },
    // 8 · pins (post-solve)
    { id: 'F_WF', s: 'pin', expr: 'sqrt(R_xF^2+R_yF^2)', unit: 'N', label: 'Wall pin, front side' },
    { id: 'F_WR', s: 'pin', expr: 'sqrt(R_xR^2+R_yR^2)', unit: 'N', label: 'Wall pin, rear side' },
    { id: 'F_pin', s: 'pin', expr: 'max(F_WF,F_WR,abs(D_F),abs(D_R))', unit: 'N', label: 'Worst pin load per side' },
    { id: 'A_p', s: 'pin', expr: 'pi*d_p^2/4', unit: 'mm²', label: 'Pin cross-section' },
    { id: 'tau_p', s: 'pin', expr: 'F_pin/(m_sh*A_p)', unit: 'MPa', label: 'Pin direct shear' },
    { id: 'n_ps', s: 'pin', expr: '0.577*Sy_p/tau_p', unit: '', label: 'Pin shear factor of safety' },
    { id: 't_cb', s: 'pin', expr: 'if(tube, t, min(w/2, k_c*d_p))', unit: 'mm', label: 'Bearing length in the beam per side' },
    { id: 'a_pW', s: 'pin', expr: 't_br/2+e_g+t_cb/2', unit: 'mm', label: 'Bending arm, wall pin (bracket mid-plane to beam-wall mid-plane)' },
    { id: 'a_pD', s: 'pin', expr: 't_p/2+e_g+t_cb/2', unit: 'mm', label: 'Bending arm, diagonal-to-beam pin' },
    { id: 'a_pT', s: 'pin', expr: 't_p/2+e_g+t_br/2', unit: 'mm', label: 'Bending arm, diagonal-to-structure pin (1/2 in bracket assumed)' },
    { id: 'M_pW', s: 'pin', expr: 'max(F_WF,F_WR)*a_pW', unit: 'N·m', label: 'Pin bending moment, wall pin' },
    { id: 'M_pD', s: 'pin', expr: 'D_max*a_pD', unit: 'N·m', label: 'Pin bending moment, diagonal-to-beam pin' },
    { id: 'M_pT', s: 'pin', expr: 'D_max*a_pT', unit: 'N·m', label: 'Pin bending moment, diagonal-to-structure pin' },
    { id: 'M_p', s: 'pin', expr: 'max(M_pW,M_pD,M_pT)', unit: 'N·m', label: 'Worst pin bending moment' },
    { id: 'sig_pb', s: 'pin', expr: '32*M_p/(pi*d_p^3)', unit: 'MPa', label: 'Pin bending stress, σ = Mc/I = 32M/(πd³)' },
    { id: 'n_pb', s: 'pin', expr: 'Sy_p/sig_pb', unit: '', label: 'Pin bending factor of safety' },
    { id: 'sig_bb', s: 'pin', expr: 'F_pin/(d_p*t_cb)', unit: 'MPa', label: 'Bearing stress on beam' },
    { id: 'n_bb', s: 'pin', expr: 'Sy_b/sig_bb', unit: '', label: 'Beam bearing factor of safety' },
    { id: 'sig_bd', s: 'pin', expr: 'D_max/(d_p*t_p)', unit: 'MPa', label: 'Bearing stress on diagonal plate' },
    { id: 'n_bd', s: 'pin', expr: 'Sy_d/sig_bd', unit: '', label: 'Plate bearing factor of safety' },
    { id: 'sig_bk', s: 'pin', expr: 'F_pin/(d_p*t_br)', unit: 'MPa', label: 'Bearing stress on aluminum bracket' },
    { id: 'n_bk', s: 'pin', expr: 'Sy_br/sig_bk', unit: '', label: 'Bracket bearing factor of safety' },
    { id: 'L_grip', s: 'pin', expr: 'w+2*max(t_br,t_p)', unit: 'in', label: 'Grip needed for a through pin' },
    // each pin on its own (the checks above are the worst of the three)
    { id: 'F_pW', s: 'pin', expr: 'max(F_WF,F_WR)', unit: 'N', label: 'Wall pin: larger of its front and rear force' },
    { id: 'tau_pW', s: 'pin', expr: 'F_pW/(m_sh*A_p)', unit: 'MPa', label: 'Wall pin: shear stress' },
    { id: 'sig_pW', s: 'pin', expr: '32*M_pW/(pi*d_p^3)', unit: 'MPa', label: 'Wall pin: bending stress' },
    { id: 'sig_bbW', s: 'pin', expr: 'F_pW/(d_p*t_cb)', unit: 'MPa', label: 'Wall pin: bearing stress on the beam' },
    { id: 'sig_bkW', s: 'pin', expr: 'F_pW/(d_p*t_br)', unit: 'MPa', label: 'Wall pin: bearing stress on the wall bracket' },
    { id: 'tau_pD', s: 'pin', expr: 'D_max/(m_sh*A_p)', unit: 'MPa', label: 'Diagonal-to-beam pin: shear stress' },
    { id: 'sig_pD', s: 'pin', expr: '32*M_pD/(pi*d_p^3)', unit: 'MPa', label: 'Diagonal-to-beam pin: bending stress' },
    { id: 'sig_bbD', s: 'pin', expr: 'D_max/(d_p*t_cb)', unit: 'MPa', label: 'Diagonal-to-beam pin: bearing stress on the beam' },
    { id: 'sig_bdD', s: 'pin', expr: 'D_max/(d_p*t_p)', unit: 'MPa', label: 'Diagonal-to-beam pin: bearing stress on the diagonal plate' },
    { id: 'tau_pT', s: 'pin', expr: 'D_max/(m_sh*A_p)', unit: 'MPa', label: 'Diagonal-to-structure pin: shear stress' },
    { id: 'sig_pT', s: 'pin', expr: '32*M_pT/(pi*d_p^3)', unit: 'MPa', label: 'Diagonal-to-structure pin: bending stress' },
    { id: 'sig_bdT', s: 'pin', expr: 'D_max/(d_p*t_p)', unit: 'MPa', label: 'Diagonal-to-structure pin: bearing stress on the diagonal plate' },
    { id: 'sig_bkT', s: 'pin', expr: 'D_max/(d_p*t_br)', unit: 'MPa', label: 'Diagonal-to-structure pin: bearing stress on the structure bracket' },
    // 9 · deflection (post-solve)
    { id: 'delta_CG', s: 'defl', expr: 'sqrt(dx_CG^2+dy_CG^2+dz_CG^2)', unit: 'mm', label: 'Total CG deflection magnitude' },
  ];

  // Applied loads. Points/vectors are expressions; x is also where the load enters the beam.
  const LOADS = [
    { id: 'WR', name: 'Rotor assembly weight', tex: 'Rotor_W', x: '-X_r', y: 'y_G', z: '0', Fx: '0', Fy: '-W_R', Fz: '0', note: 'At the CG on the rotor axis (Req. 8). Includes the shaft box (Piazza @12).' },
    { id: 'FD', name: 'Water drag', tex: 'Rotor_Drag', x: '-X_r', y: 'y_P', z: '0', Fx: '0', Fy: '0', Fz: 'F_D', note: 'At the COP (Req. 5, Fig. 2).' },
    { id: 'C1', name: 'Chain on rotor sprocket', tex: 'Chain_Frotor', x: '-X_r', y: 'y_c', z: '0', Fx: 'F_cx', Fy: '0', Fz: 'F_cz', note: 'Placed on the shaft axis: the tangent-point offset couple cancels the water torque inside the rotor FBD.' },
    { id: 'WC1', name: 'Chain weight at rotor sprocket', tex: 'Chain_Wrotor', x: '-X_r', y: 'y_c', z: '0', Fx: '0', Fy: '-W_ch1', Fz: '0', on: false, note: 'Neglected (Piazza @10: justified in the report). ANSI #40 at 0.42 lb/ft: wrap + half of each strand.' },
    { id: 'WG', name: 'Generator weight', tex: 'Gen_W', x: '-X_g', y: 'h/2', z: '0', Fx: '0', Fy: '-W_G', Fz: '0', note: 'On the generator shaft axis (Req. 8).' },
    { id: 'C2', name: 'Chain on generator sprocket', tex: 'Chain_Fgen', x: '-X_g', y: 'y_c', z: '0', Fx: '-F_cx', Fy: '0', Fz: '-F_cz', Mx: '0', My: 'M_cg', Mz: '0', note: 'Moved from the rear tangent point to the axis, adding the couple M_cg about +y.' },
    { id: 'WC2', name: 'Chain weight at generator sprocket', tex: 'Chain_Wgen', x: '-X_g', y: 'y_c', z: '0', Fx: '0', Fy: '-W_ch2', Fz: '0', on: false, note: 'Neglected (Piazza @10: justified in the report).' },
  ];
  // Beam self-weight: uniform, handled as a distributed load from x_L to x_E.
  const DIST = { id: 'WB', name: 'Beam self-weight', tex: 'Beam_q', x0: 'x_L', x1: 'x_E', q: 'q_b' };

  // Unknown reactions: unit direction and point, as expressions.
  const UNKNOWNS = [
    { id: 'R_xF', name: 'Wall pin, front, x', x: '0', y: '0', z: 's_P', ux: '1', uy: '0', uz: '0' },
    { id: 'R_yF', name: 'Wall pin, front, y', x: '0', y: '0', z: 's_P', ux: '0', uy: '1', uz: '0' },
    { id: 'R_xR', name: 'Wall pin, rear, x', x: '0', y: '0', z: '-s_P', ux: '1', uy: '0', uz: '0' },
    { id: 'R_yR', name: 'Wall pin, rear, y', x: '0', y: '0', z: '-s_P', ux: '0', uy: '1', uz: '0' },
    { id: 'R_z', name: 'Wall thrust (bracket face)', x: '0', y: '0', z: '0', ux: '0', uy: '0', uz: '1' },
    { id: 'D_F', name: 'Front diagonal (+ tension)', x: '-a', y: '0', z: 's_D', ux: 'u_x', uy: 'u_y', uz: '0' },
    { id: 'D_R', name: 'Rear diagonal (+ tension)', x: '-a', y: '0', z: '-s_D', ux: 'u_x', uy: 'u_y', uz: '0' },
  ];
  const CONSTRAINT = 'R_yF - R_yR';

  // Named moment points (expressions); "custom" uses numeric mm values.
  const POINTS = [
    { id: 'O', name: 'O · wall pin (origin)', x: '0', y: '0', z: '0' },
    { id: 'D', name: 'Diagonal pin line (x = −a)', x: '-a', y: '0', z: '0' },
    { id: 'R', name: 'Rotor axis on beam', x: '-X_r', y: '0', z: '0' },
    { id: 'G', name: 'Generator axis on beam', x: '-X_g', y: '0', z: '0' },
    { id: 'CG', name: 'Rotor CG', x: '-X_r', y: 'y_G', z: '0' },
    { id: 'COP', name: 'Drag COP', x: '-X_r', y: 'y_P', z: '0' },
    { id: 'DF', name: 'Front diagonal pin', x: '-a', y: '0', z: 's_D' },
    { id: 'T', name: 'Diagonal top pin line', x: 'x_T', y: 'H_D', z: '0' },
  ];

  const ENGINE_OUT = ['R_xF', 'R_yF', 'R_xR', 'R_yR', 'R_z', 'D_F', 'D_R', 'dx_CG', 'dy_CG', 'dz_CG',
    'N_pk', 'Vy_pk', 'Vz_pk', 'T_pk', 'My_pk', 'Mz_pk', 'vm_pk', 'n_b'];

  const RX = renameExpr;
  function defaultModel() {
    const rn = (o, keys) => { const c = { ...o }; keys.forEach(k => { if (c[k] != null) c[k] = RX(c[k]); }); return c; };
    return {
      inputs: INPUTS.map(i => ({ ...i, id: nameOf(i.id) })),
      defs: DEFS.map(d => { const e = RX(d.expr); return { ...d, id: nameOf(d.id), expr: e, def: e }; }),
      loads: LOADS.map(l => rn({ Mx: '0', My: '0', Mz: '0', on: true, ...l }, ['x', 'y', 'z', 'Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz'])),
      dist: rn({ ...DIST, on: true }, ['x0', 'x1', 'q']),
      unknowns: UNKNOWNS.map(u => rn({ ...u, id: nameOf(u.id) }, ['x', 'y', 'z', 'ux', 'uy', 'uz'])),
      constraint: RX(CONSTRAINT),
      point: { id: 'O', x: 0, y: 0, z: 0 },
    };
  }

  // ---------------------------------------------------------------- compile + evaluate scalar model
  const astCache = new Map();
  function cparse(expr) {
    let r = astCache.get(expr);
    if (!r) {
      try { const ast = parse(expr); r = { ast, deps: deps(ast) }; }
      catch (e) { r = { err: e.message }; }
      astCache.set(expr, r);
    }
    return r;
  }
  function ev(expr, scope) {
    const c = cparse(expr);
    if (c.err) throw new Error(c.err);
    return evalAst(c.ast, scope);
  }

  // Splits defs into pre-solve and post-solve groups and orders each topologically.
  function plan(model) {
    const byId = new Map(model.defs.map(d => [d.id, d]));
    const errors = {};
    const engineSet = new Set([...ENGINE_OUT, ...ENGINE_OUT.map(nameOf)]);
    const post = new Set();
    const depOf = (d) => { const c = cparse(d.expr); if (c.err) { errors[d.id] = c.err; return new Set(); } return c.deps; };
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of model.defs) {
        if (post.has(d.id)) continue;
        for (const x of depOf(d)) if (engineSet.has(x) || post.has(x)) { post.add(d.id); changed = true; break; }
      }
    }
    const order = [], state = {};
    function visit(id, stack) {
      if (state[id] === 2) return;
      if (state[id] === 1) { errors[id] = `Circular definition (${[...stack, id].join(' → ')})`; return; }
      state[id] = 1;
      const d = byId.get(id);
      for (const x of depOf(d)) if (byId.has(x)) visit(x, [...stack, id]);
      state[id] = 2;
      order.push(id);
    }
    model.defs.forEach(d => visit(d.id, []));
    const pre = order.filter(id => !post.has(id));
    // Which old/new name pairs each stage of a solve can change, so run() syncs only those instead of all
    // of them every time: inputs, then pre-solve definitions, then everything written after the statics.
    const early = new Set([...(model.inputs || []).map(i => i.id), ...pre]), late = new Set([...engineSet, ...post]);
    for (const u of model.unknowns || []) for (const k of [u.id, NAMES[u.id], NEW2OLD[u.id]]) if (k) late.add(k);
    const inIds = new Set((model.inputs || []).map(i => i.id)), preIds = new Set(pre);
    const hit = (set, pr) => set.has(pr[0]) || set.has(pr[1]);
    const al = {
      in: NAME_PAIRS.filter(pr => hit(inIds, pr)), pre: NAME_PAIRS.filter(pr => hit(preIds, pr)),
      late: NAME_PAIRS.filter(pr => hit(late, pr) || !hit(early, pr) || (early.has(pr[0]) && early.has(pr[1]))),
    };
    return { pre, post: order.filter(id => post.has(id)), errors, byId, al };
  }

  function evalDefs(ids, plan_, scope, errors) {
    for (const id of ids) {
      const d = plan_.byId.get(id);
      if (errors[id]) { scope[id] = NaN; continue; }
      try { scope[id] = ev(d.expr, scope); }
      catch (e) { errors[id] = e.message; scope[id] = NaN; }
    }
  }

  // A search passes the same scope object back in (opts.scope) so it is cleared, not rebuilt, each solve.
  function inputScope(model, reuse, pairs) {
    const s = reuse || {};
    if (reuse) for (const k in s) s[k] = undefined;
    for (const i of model.inputs) s[i.id] = toSI(+i.v, i.unit);
    return alias(s, pairs);
  }

  // ---------------------------------------------------------------- vector helpers
  const cross = (r, f) => [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

  function solveLinear(Ain, bin) {
    const n = bin.length, Am = Ain.map((r, i) => [...r, bin[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(Am[r][c]) > Math.abs(Am[p][c])) p = r;
      if (Math.abs(Am[p][c]) < 1e-12) throw new Error('The equilibrium system is singular: the supports cannot carry these loads (check the constraint and unknown directions).');
      [Am[c], Am[p]] = [Am[p], Am[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = Am[r][c] / Am[c][c];
        for (let k = c; k <= n; k++) Am[r][k] -= f * Am[c][k];
      }
    }
    return Am.map((r, i) => r[n] / r[i]);
  }

  // Evaluates loads into numeric vectors.
  function evalLoads(model, s) {
    const loads = [];
    for (const l of model.loads) {
      if (!l.on) continue;
      const r = [ev(l.x, s), ev(l.y, s), ev(l.z, s)];
      const F = [ev(l.Fx, s), ev(l.Fy, s), ev(l.Fz, s)];
      const M = [ev(l.Mx || '0', s), ev(l.My || '0', s), ev(l.Mz || '0', s)];
      loads.push({ ...l, r, F, M, ax: r[0] });
    }
    let dist = null;
    if (model.dist && model.dist.on) {
      const x0 = ev(model.dist.x0, s), x1 = ev(model.dist.x1, s), q = ev(model.dist.q, s);
      dist = { ...model.dist, x0n: x0, x1n: x1, qn: q, W: q * (x1 - x0) };
      loads.push({ id: 'WB', name: model.dist.name, tex: 'Beam_W', r: [(x0 + x1) / 2, 0, 0], F: [0, -dist.W, 0], M: [0, 0, 0], ax: (x0 + x1) / 2, isDist: true });
    }
    const unknowns = model.unknowns.map(u => ({
      ...u, r: [ev(u.x, s), ev(u.y, s), ev(u.z, s)], u: [ev(u.ux, s), ev(u.uy, s), ev(u.uz, s)],
    }));
    return { loads, dist, unknowns };
  }

  function pointOf(model, s) {
    const p = model.point || { id: 'O' };
    if (p.id === 'custom') return [p.x / 1000, p.y / 1000, p.z / 1000];
    const def = POINTS.find(q => q.id === p.id) || POINTS[0];
    return [ev(RX(def.x), s), ev(RX(def.y), s), ev(RX(def.z), s)];
  }

  // 6 equilibrium equations about P + one constraint → 7 unknowns.
  function statics(model, s, L) {
    const P = pointOf(model, s);
    const n = L.unknowns.length;
    const A = [], b = [];
    const known = [0, 0, 0, 0, 0, 0];
    const contrib = L.loads.map(l => {
      const m = cross(sub3(l.r, P), l.F);
      const v = [l.F[0], l.F[1], l.F[2], m[0] + l.M[0], m[1] + l.M[1], m[2] + l.M[2]];
      v.forEach((x, i) => (known[i] += x));
      return v;
    });
    for (let i = 0; i < 6; i++) A.push(new Array(n).fill(0));
    L.unknowns.forEach((u, j) => {
      const m = cross(sub3(u.r, P), u.u);
      [u.u[0], u.u[1], u.u[2], m[0], m[1], m[2]].forEach((x, i) => (A[i][j] = x));
    });
    for (let i = 0; i < 6; i++) b.push(-known[i]);
    // constraint, linear in the unknowns
    const names = L.unknowns.map(u => u.id);
    const cs = (vals) => { const sc = Object.create(s); names.forEach((nm, k) => (sc[nm] = vals[k])); return ev(model.constraint, sc); };
    const z = new Array(n).fill(0);
    const c0 = cs(z);
    const crow = names.map((_, k) => { const e = z.slice(); e[k] = 1; return cs(e) - c0; });
    const lincheck = cs(names.map((_, k) => k + 1.7)) - (c0 + crow.reduce((acc, c, k) => acc + c * (k + 1.7), 0));
    if (Math.abs(lincheck) > 1e-6 * (1 + Math.abs(c0))) throw new Error('The extra relation must be linear in the reactions.');
    const rows = n - 6;
    if (rows !== 1) throw new Error(`Need exactly one extra relation for ${n} unknowns.`);
    A.push(crow); b.push(-c0);
    const x = solveLinear(A, b);
    const R = {};
    names.forEach((nm, k) => (R[nm] = x[k]));
    alias(R);
    // residuals about P and about O
    const resid = (Q) => {
      const r = [0, 0, 0, 0, 0, 0];
      const add = (pt, F, M) => { const m = cross(sub3(pt, Q), F); [F[0], F[1], F[2], m[0] + M[0], m[1] + M[1], m[2] + M[2]].forEach((v, i) => (r[i] += v)); };
      L.loads.forEach(l => add(l.r, l.F, l.M));
      L.unknowns.forEach(u => add(u.r, u.u.map(c => c * R[u.id]), [0, 0, 0]));
      return r;
    };
    return { P, A, b, x, R, names, contrib, known, constraintRow: crow, constraintC0: c0, residP: resid(P), residO: resid([0, 0, 0]), residFar: resid([1.234, -0.77, 0.51]) };
  }

  // Internal loads on the +x face of the segment left of the cut at xc.
  function internalAt(xc, L, R, side = 0) {
    const C = [xc, 0, 0];
    let F = [0, 0, 0], M = [0, 0, 0];
    const add = (pt, f, m) => {
      const mm = cross(sub3(pt, C), f);
      for (let i = 0; i < 3; i++) { F[i] += f[i]; M[i] += mm[i] + m[i]; }
    };
    const left = (ax) => (side < 0 ? ax < xc - 1e-12 : side > 0 ? ax <= xc + 1e-12 : ax < xc);
    for (const l of L.loads) { if (l.isDist) continue; if (left(l.ax)) add(l.r, l.F, l.M); }
    for (const u of L.unknowns) if (left(u.r[0])) add(u.r, u.u.map(c => c * R[u.id]), [0, 0, 0]);
    if (L.dist) {
      const a = L.dist.x0n, b = Math.min(xc, L.dist.x1n);
      if (b > a) add([(a + b) / 2, 0, 0], [0, -L.dist.qn * (b - a), 0], [0, 0, 0]);
    }
    return { N: -F[0], Vy: -F[1], Vz: -F[2], T: -M[0], My: -M[1], Mz: -M[2] };
  }

  // The seven reactions as formulas in the loads, built from the model's own load list (moments about O).
  // Valid for the default supports (two diagonals, wall pin front/rear, bracket thrust) and Req. 10's relation.
  function symbolicReactions(model) {
    const base = defaultModel();
    if (JSON.stringify(model.unknowns) !== JSON.stringify(base.unknowns) || model.constraint !== base.constraint) return null;
    const P_ = (e) => cparse(e).ast, V_ = (n) => ({ t: 'var', n: nameOf(n) }), par = (a) => ({ t: 'paren', a });
    const K = { Fx: [], Fy: [], Fz: [], Mx: [], My: [], Mz: [] };
    const put = (k, term) => { if (!isZero(term)) K[k].push(term); };
    const loads = model.loads.filter(l => l.on).map(l => ({ r: [l.x, l.y, l.z].map(P_), F: [l.Fx, l.Fy, l.Fz].map(P_), M: [l.Mx || '0', l.My || '0', l.Mz || '0'].map(P_) }));
    if (model.dist && model.dist.on) loads.push({ r: [A.neg(V_('X_b')), A.num(0), A.num(0)], F: [A.num(0), A.neg(V_('W_b')), A.num(0)], M: [0, 0, 0].map(A.num) });
    for (const { r, F, M } of loads) {
      put('Fx', F[0]); put('Fy', F[1]); put('Fz', F[2]);
      put('Mx', A.mul(r[1], F[2])); put('Mx', A.neg(A.mul(r[2], F[1]))); put('Mx', M[0]);
      put('My', A.mul(r[2], F[0])); put('My', A.neg(A.mul(r[0], F[2]))); put('My', M[1]);
      put('Mz', A.mul(r[0], F[1])); put('Mz', A.neg(A.mul(r[1], F[0]))); put('Mz', M[2]);
    }
    // drop pairs that cancel exactly (the two chain pulls)
    for (const k in K) {
      const tx = K[k].map(tm => toTeX(tm, { plain: true }).trim()), dead = new Set();
      tx.forEach((a, i) => { if (dead.has(i)) return; const j = tx.findIndex((b, q) => q !== i && !dead.has(q) && (b === '-' + a || a === '-' + b)); if (j >= 0) { dead.add(i); dead.add(j); } });
      K[k] = K[k].filter((_, i) => !dead.has(i));
    }
    const sum = (terms) => terms.length ? terms.reduce((a, b) => A.add(a, b)) : A.num(0);
    const S = Object.fromEntries(Object.keys(K).map(k => [k, par(sum(K[k]))]));
    const div = (a, b) => (isZero(strip(a)) ? A.num(0) : { t: 'bin', op: '/', a, b }), half = (a) => (isZero(strip(a)) ? A.num(0) : A.mul({ t: 'bin', op: '/', a: A.num(1), b: A.num(2) }, par(a)));
    const a = V_('a'), H = V_('H_D'), Ld = V_('L_D'), Lx = par(P_(model.defs.find(d => d.id === nameOf('L_x')).expr)), sD = V_('s_D'), sP = V_('s_P');
    const mzA = div(S.Mz, a), mxD = div(S.Mx, sD), LH = div(Ld, A.mul(A.num(2), H)), LxH = div(Lx, H);
    const xSum = A.add(S.Fx, A.mul(LxH, mzA)), xDif = A.mul({ t: 'bin', op: '/', a: A.num(1), b: sP }, par(A.add(S.My, A.mul(LxH, S.Mx))));
    const steps = [
      { id: 'R_z', from: ['Fz'], ast: A.neg(S.Fz) },
      { id: 'D_R', from: ['Mz', 'Mx'], ast: A.mul(LH, par(A.sub(mzA, mxD))) },
      { id: 'D_F', from: ['Mz', 'Mx'], ast: A.mul(LH, par(A.add(mzA, mxD))) },
      { id: 'R_yF', from: ['Fy'], also: 'R_yR', ast: A.neg(half(A.add(S.Fy, mzA))) },
      { id: 'R_xF', from: ['Fx', 'My'], ast: A.sub(A.neg(half(xSum)), half(xDif)) },
      { id: 'R_xR', from: ['Fx', 'My'], ast: A.add(A.neg(half(xSum)), half(xDif)) },
    ].map(o => ({ ...o, id: nameOf(o.id), also: o.also && nameOf(o.also) }));
    return { K, S, steps };
  }

  // The same internal loads as internalAt, as symbols: what each station adds to N, Vy, Vz, T, My, Mz
  // on the cut face at x once the cut has passed it. Built from the model's own loads and unknowns.
  function symbolicInternal(model, s) {
    const X = { t: 'var', n: 'x' }, P_ = (e) => cparse(e).ast, par = (a) => ({ t: 'paren', a });
    const items = model.loads.filter(l => l.on).map(l => ({ r: [l.x, l.y, l.z], F: [l.Fx, l.Fy, l.Fz].map(P_), M: [l.Mx || '0', l.My || '0', l.Mz || '0'].map(P_) }));
    for (const u of model.unknowns) items.push({ r: [u.x, u.y, u.z], F: [u.ux, u.uy, u.uz].map(e => A.mul(P_(e), { t: 'var', n: u.id })), M: [0, 0, 0].map(A.num) });
    const st = new Map();
    for (const it of items) {
      const xn = ev(it.r[0], s), k = Math.round(xn * 1e7), xi = strip(P_(it.r[0])), y = P_(it.r[1]), z = P_(it.r[2]), F = it.F;
      const d = isZero(xi) ? X : par(xi.t === 'neg' ? A.add(X, xi.a) : A.sub(X, xi)); // x − x_i
      if (!st.has(k)) st.set(k, { x: xn, xAst: xi, d, N: [], Vy: [], Vz: [], T: [], My: [], Mz: [] });
      const o = st.get(k), put = (key, term) => { if (!isZero(term)) o[key].push(term); };
      put('N', A.neg(F[0])); put('Vy', A.neg(F[1])); put('Vz', A.neg(F[2]));
      put('T', A.neg(A.mul(y, F[2]))); put('T', A.mul(z, F[1])); put('T', A.neg(it.M[0]));
      put('My', A.neg(A.mul(z, F[0]))); put('My', A.neg(A.mul(d, F[2]))); put('My', A.neg(it.M[1]));
      put('Mz', A.mul(d, F[1])); put('Mz', A.mul(y, F[0])); put('Mz', A.neg(it.M[2]));
    }
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const stations = [...st.values()].sort((a, b) => a.x - b.x);
    stations.forEach(o => { o.name = near(o.x, -s.X_r) ? 'Rotor' : near(o.x, -s.a) ? 'Diagonal pins' : near(o.x, -s.X_g) ? 'Generator' : near(o.x, 0) ? 'Wall pin' : 'Load'; });
    // uniform self-weight from x0: Vy = q (x − x0), Mz = −q (x − x0)² / 2
    let dist = null;
    if (model.dist && model.dist.on) {
      const q = P_(model.dist.q), dx = par(A.sub(X, P_(model.dist.x0)));
      dist = { Vy: [A.mul(q, dx)], Mz: [A.neg({ t: 'bin', op: '/', a: A.mul(q, { t: 'bin', op: '^', a: dx, b: A.num(2) }), b: A.num(2) })] };
    }
    return { stations, dist };
  }

  // ---- AST helpers used to show the solver's own formulas
  // replace variables by other ASTs (map: name → AST)
  function subst(n, map) {
    if (!n || typeof n !== 'object') return n;
    if (n.t === 'var') return n.n in map ? { t: 'paren', a: map[n.n] } : n;
    const c = { ...n };
    for (const k of ['a', 'b']) if (c[k]) c[k] = subst(c[k], map);
    if (c.args) c.args = c.args.map(x => subst(x, map));
    return c;
  }
  // replace named definitions by their expressions, repeatedly, and take the live branch of every if()
  function expandDefs(n, model, s, ids) {
    const want = new Set(ids.map(nameOf));
    const go = (m, depth) => {
      if (!m || typeof m !== 'object') return m;
      if (m.t === 'var' && want.has(m.n) && depth < 6) {
        const d = model.defs.find(x => x.id === m.n);
        if (d) return { t: 'paren', a: go(cparse(d.expr).ast, depth + 1) };
      }
      if (m.t === 'call' && m.f === 'if' && m.args.length === 3) {
        try { return go(evalAst(m.args[0], s) ? m.args[1] : m.args[2], depth); } catch { /* keep the if */ }
      }
      const c = { ...m };
      for (const k of ['a', 'b']) if (c[k]) c[k] = go(c[k], depth);
      if (c.args) c.args = c.args.map(x => go(x, depth));
      return c;
    };
    return go(n, 0);
  }

  // The stress formulas, written once. sectionStress evaluates exactly these, and the page prints them.
  // Cut_* are the six internal loads at the cut; Sec_* are the area and second moments there (full section,
  // or the net section at a pin hole).
  const STRESS_FORMS = {
    sN: 'abs(Cut_N)/Sec_A', sMz: 'abs(Cut_Mz)*(h/2)/Sec_Iz', sMy: 'abs(Cut_My)*(w/2)/Sec_Iy',
    tT: 'abs(Cut_T)*k_T', tVy: 'abs(Cut_Vy)*Q_z/(I_z*b_z)', tVz: 'abs(Cut_Vz)*Q_y/(I_y*b_y)',
    sig: 'Str_sN+Str_sMz+Str_sMy', tau: 'Str_tT+Str_tVy+Str_tVz', vm: 'sqrt(Str_sig^2+3*Str_tau^2)',
  };
  // The deflection formulas, written once (same idea as the stress forms). Cut_* are the loads at a cut.
  // Def_* are results of earlier steps: stretch of each diagonal, drop of each beam pin, the rigid twist and
  // pitch they cause, and the beam's own elastic stretch, slope, sag, sideways bow and twist at the rotor.
  const DEFL_FORMS = {
    // what the beam does per unit length at a cut
    kap_v: 'Cut_Mz/(E_b*I_z)', kap_w: '-Cut_My/(E_b*I_y)', twist: 'Cut_T/(G_b*J_b)', strain: 'Cut_N/(E_b*A_b)',
    // diagonals stretch, so the beam's diagonal pins drop
    dF: 'D_F*L_D/(E_d*b_p*t_p)', dR: 'D_R*L_D/(E_d*b_p*t_p)',
    // each diagonal pin also moves along x: the beam's stretch there, plus the sideways-bow slope times the
    // pin's distance from the centerline (opposite sign front and rear)
    uF: 'Def_uA-s_D*Def_bowSlopeA', uR: 'Def_uA+s_D*Def_bowSlopeA',
    vF: '-(Def_dF+Def_uF*u_x)/u_y', vR: '-(Def_dR+Def_uR*u_x)/u_y',
    thx: '(Def_vR-Def_vF)/(2*s_D)', thz: '-(Def_vF+Def_vR)/(2*a)',
    // carry everything to the rotor CG
    dx: 'Def_uRot-(Def_thz+Def_slopeRot)*y_G', dy: 'Def_sagRot-Def_thz*X_r', dz: 'Def_bowRot+(Def_thx+Def_twistRot)*y_G',
  };
  const DEFL_AST = {};
  // every named deflection quantity: the formulas above plus the sums taken along the beam
  const DEFL_NAMES = ['dF', 'dR', 'uF', 'uR', 'vF', 'vR', 'thx', 'thz', 'dx', 'dy', 'dz', 'uA', 'bowSlopeA', 'uRot', 'slopeRot', 'sagRot', 'bowRot', 'twistRot'];
  const deflForm = (k) => DEFL_AST[k] || (DEFL_AST[k] = parse(renameExpr(DEFL_FORMS[k])));
  const STRESS_AST = {};
  const stressForm = (k) => STRESS_AST[k] || (STRESS_AST[k] = parse(renameExpr(STRESS_FORMS[k])));
  const SEC_OF = (net) => (net ? { Sec_A: 'A_n', Sec_Iz: 'I_zn', Sec_Iy: 'I_yn' } : { Sec_A: 'A_b', Sec_Iz: 'I_z', Sec_Iy: 'I_y' });

  // Section stress at a station, using gross or net properties.
  function sectionStress(f, s, net) {
    const sc = Object.create(s), sec = SEC_OF(net);
    for (const k of ['N', 'Vy', 'Vz', 'T', 'My', 'Mz']) sc['Cut_' + k] = f[k];
    for (const k in sec) sc[k] = s[sec[k]];
    const out = { net };
    for (const k of Object.keys(STRESS_FORMS)) out[k] = sc['Str_' + k] = evalAst(stressForm(k), sc);
    return out;
  }

  // σ_x at a point (y,z) of the section (signed), for the section map.
  function sigmaAt(f, s, y, z, net) {
    const A = net ? s.A_n : s.A_b, Iz = net ? s.I_zn : s.I_z, Iy = net ? s.I_yn : s.I_y;
    return f.N / A - f.Mz * y / Iz + f.My * z / Iy;
  }

  function cumtrapz(x, y, i0) {
    // integral from x[i0] to x[i], signed
    const out = new Array(x.length).fill(0);
    for (let i = i0 + 1; i < x.length; i++) out[i] = out[i - 1] + 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
    for (let i = i0 - 1; i >= 0; i--) out[i] = out[i + 1] - 0.5 * (y[i] + y[i + 1]) * (x[i + 1] - x[i]);
    return out;
  }

  function buildGrid(s, n, specials) {
    const pts = new Set();
    for (let i = 0; i <= n; i++) pts.add(+(s.x_L + (s.x_E - s.x_L) * i / n).toFixed(9));
    specials.forEach(p => { if (p >= s.x_L && p <= s.x_E) pts.add(+p.toFixed(9)); });
    return [...pts].sort((a, b) => a - b);
  }

  // Full analysis along the beam.
  function beamAnalysis(s, L, R, n = 400) {
    const holes = [-s.a, 0];
    const specials = [...L.loads.filter(l => !l.isDist).map(l => l.ax), ...L.unknowns.map(u => u.r[0]), -s.X_r];
    const grid = buildGrid(s, n, specials);
    // diagram samples: left/right limits at discontinuities
    const xs = [], F = [];
    const jumps = new Set(specials.map(v => +v.toFixed(9)));
    for (const x of grid) {
      if (jumps.has(+x.toFixed(9))) {
        xs.push(x, x); F.push(internalAt(x, L, R, -1), internalAt(x, L, R, +1));
      } else { xs.push(x); F.push(internalAt(x, L, R, 0)); }
    }
    const S = F.map((f, i) => {
      const net = holes.some(hx => Math.abs(xs[i] - hx) <= s.d_h / 2 + 1e-9);
      return sectionStress(f, s, net);
    });
    // peaks
    const peak = (key, absval = true) => {
      let best = -1, at = 0, val = 0;
      F.forEach((f, i) => { const v = absval ? Math.abs(f[key]) : f[key]; if (v > best) { best = v; at = xs[i]; val = f[key]; } });
      return { mag: best, x: at, val };
    };
    let vmPk = { v: -1, x: 0, i: 0 };
    S.forEach((st, i) => { if (st.vm > vmPk.v) vmPk = { v: st.vm, x: xs[i], i }; });

    // deflection on the grid (unique x, right-limit loads for integration — measure zero difference)
    const gx = grid, gF = gx.map(x => internalAt(x, L, R, 0));
    const i0 = gx.findIndex(x => Math.abs(x) < 1e-9);
    const iA = gx.findIndex(x => Math.abs(x + s.a) < 1e-9);
    const iR = gx.findIndex(x => Math.abs(x + s.X_r) < 1e-9);
    // every number below comes from DEFL_FORMS, the same formulas the page prints
    const at = (f) => { const sc = Object.create(s); for (const k of ['N', 'Vy', 'Vz', 'T', 'My', 'Mz']) sc['Cut_' + k] = f[k]; return sc; };
    const per = (k) => gF.map(f => evalAst(deflForm(k), at(f)));
    const kz = per('kap_v'), ky = per('kap_w'), kt = per('twist'), ka = per('strain');
    // y-bending, elastic part: v(0)=0, v(-a)=0
    const slope0 = cumtrapz(gx, kz, i0);
    const v0 = cumtrapz(gx, slope0, i0);
    const c = iA >= 0 ? v0[iA] / s.a : 0; // v0(-a) + c(-a) = 0
    const ve = v0.map((v, i) => v + c * gx[i]);
    const vpe = slope0.map(sl => sl + c);
    // z-bending: w(0)=0, w'(0)=0 (yaw held by rigid brackets through the wall-pin couple)
    const wsl = cumtrapz(gx, ky, i0);
    const we = cumtrapz(gx, wsl, i0);
    // axial
    const ue = cumtrapz(gx, ka, i0);
    // twist relative to the diagonal station
    const th = cumtrapz(gx, kt, iA >= 0 ? iA : i0);
    // rigid motion from diagonal stretch, then everything carried to the CG
    const ds = Object.create(s);
    Object.assign(ds, { D_F: R.D_F, D_R: R.D_R, Diag_Front: R.D_F, Diag_Rear: R.D_R, Def_uA: iA >= 0 ? ue[iA] : 0, Def_bowSlopeA: iA >= 0 ? wsl[iA] : 0, Def_uRot: ue[iR], Def_slopeRot: vpe[iR], Def_sagRot: ve[iR], Def_bowRot: we[iR], Def_twistRot: th[iR] });
    for (const k of ['dF', 'dR', 'uF', 'uR', 'vF', 'vR', 'thx', 'thz', 'dx', 'dy', 'dz']) ds['Def_' + k] = evalAst(deflForm(k), ds);
    const dF = ds.Def_dF, dR = ds.Def_dR, vF = ds.Def_vF, vR = ds.Def_vR, thx = ds.Def_thx, thz = ds.Def_thz;
    const v = ve.map((vv, i) => vv + thz * gx[i]);
    const thetaX = th.map(t => t + thx);
    const yc = s.y_G, xr = -s.X_r;
    // the part of the rigid twist that comes from the beam's yaw at the diagonal pins, not from diagonal stretch
    const thYaw = -ds.Def_bowSlopeA * s.u_x / s.u_y;
    const comp = {
      diag: [-thz * yc, thz * xr, (thx - thYaw) * yc],
      yaw: [0, 0, thYaw * yc],
      bendY: [-vpe[iR] * yc, ve[iR], 0],
      bendZ: [0, 0, we[iR]],
      twist: [0, 0, th[iR] * yc],
      axial: [ue[iR], 0, 0],
    };
    const tot = [ds.Def_dx, ds.Def_dy, ds.Def_dz];
    return {
      xs, F, S, grid: gx, defl: { v, w: we, theta: thetaX, u: ue, ve, vpe },
      peaks: { N: peak('N'), Vy: peak('Vy'), Vz: peak('Vz'), T: peak('T'), My: peak('My'), Mz: peak('Mz'), vm: vmPk },
      diag: { dF, dR, vF, vR, thx, thz },
      cg: { comp, tot, mag: Math.hypot(...tot) },
      def: Object.fromEntries(DEFL_NAMES.map(k => ['Def_' + k, ds['Def_' + k]])),
    };
  }

  // ---------------------------------------------------------------- run everything
  function run(model, opts = {}) {
    const errors = {};
    const p = opts.plan || plan(model); // the plan depends only on the expressions, so a search can reuse it
    const s = inputScope(model, opts.scope, p.al.in);
    if (!opts.plan) classify(model);
    Object.assign(errors, p.errors);
    evalDefs(p.pre, p, s, errors);
    alias(s, p.al.pre);
    let L = null, st = null, beam = null, fatal = null;
    try {
      L = evalLoads(model, s);
      st = statics(model, s, L);
      Object.assign(s, st.R);
      // opts.light skips the along-the-beam work; everything that needs it comes out NaN
      if (opts.light) ENGINE_OUT.forEach(k => { if (s[k] === undefined) s[k] = NaN; });
      else {
        beam = beamAnalysis(s, L, st.R, opts.n || 400);
        s.dx_CG = beam.cg.tot[0]; s.dy_CG = beam.cg.tot[1]; s.dz_CG = beam.cg.tot[2];
        const pk = beam.peaks;
        s.N_pk = pk.N.mag; s.Vy_pk = pk.Vy.mag; s.Vz_pk = pk.Vz.mag; s.T_pk = pk.T.mag; s.My_pk = pk.My.mag; s.Mz_pk = pk.Mz.mag;
        s.vm_pk = pk.vm.v; s.n_b = s.Sy_b / pk.vm.v;
      }
      alias(s, p.al.late);
    } catch (e) {
      fatal = e.message;
      ENGINE_OUT.forEach(k => { if (s[k] === undefined) s[k] = NaN; });
    }
    evalDefs(p.post, p, s, errors);
    for (let i = 0; i < p.al.late.length; i++) { const v = s[p.al.late[i][1]]; if (v !== undefined) s[p.al.late[i][0]] = v; }
    const checks = buildChecks(s);
    return { scope: s, errors, plan: p, L, st, beam, fatal, checks, pass: !fatal && checks.every(c => c.ok) };
  }

  function buildChecks(s, trace) {
    const C = [];
    const add = (id, sec, label, val, lim, kind, unit, req) => {
      if (trace) trace(id);
      const ok = isFinite(val) && (kind === '>=' ? val >= lim - 1e-12 : val <= lim + 1e-12);
      C.push({ id, sec, label, val, lim, kind, unit, ok, req, ratio: kind === '>=' ? lim / val : val / lim });
    };
    add('cg', 'defl', 'CG deflection', s.delta_CG, s.delta_a, '<=', 'mm', 'Req. 12');
    add('nb', 'beam', 'Beam von Mises factor of safety', s.n_b, s.n_d, '>=', '', 'Req. 11');
    add('ndy', 'diag', 'Diagonal yield factor of safety', s.n_dy, s.n_d, '>=', '', 'Req. 11');
    add('ndk', 'diag', 'Diagonal buckling factor of safety', s.n_dk, s.n_d, '>=', '', 'Req. 11');
    add('nps', 'pin', 'Pin shear factor of safety', s.n_ps, s.n_d, '>=', '', 'Req. 11');
    add('npb', 'pin', 'Pin bending factor of safety', s.n_pb, s.n_d, '>=', '', 'Req. 11');
    if (s.F_brk > 0) add('nbr', 'pin', 'Pin rated breaking strength ÷ pin force (McMaster rating)', s.F_brk * s.m_sh / Math.max(s.F_pin, 1e-9), s.n_d, '>=', '', 'Req. 11');
    add('nbb', 'pin', 'Beam bearing factor of safety', s.n_bb, s.n_d, '>=', '', 'Req. 11');
    add('nbd', 'pin', 'Plate bearing factor of safety', s.n_bd, s.n_d, '>=', '', 'Req. 11');
    add('nbk', 'pin', 'Bracket bearing factor of safety', s.n_bk, s.n_d, '>=', '', 'Req. 10–11');
    add('w', 'geom', 'Beam width ≥ 4 in', s.w, s.w_min, '>=', 'in', 'Req. 13');
    add('a', 'geom', 'Diagonal attach distance ≤ 800 mm', s.a, s.a_max, '<=', 'mm', 'Fig. 2');
    add('eb', 'geom', 'Beam hole edge distance (h/2 ≥ 2d)', s.h / 2, s.k_e * s.d_h, '>=', 'mm', 'Req. 9');
    add('ee', 'geom', 'Wall-pin hole to beam end (50 mm ≥ 2d)', s.x_E, s.k_e * s.d_h, '>=', 'mm', 'Req. 9, Fig. 2');
    add('ep', 'geom', 'Plate hole edge distance (b/2 ≥ 2d)', s.b_p / 2, s.k_e * s.d_h, '>=', 'mm', 'Req. 9');
    add('cl', 'hole', 'Minimum pin clearance > 0', s.c_min, 0, '>=', 'in', 'Req. 9');
    add('t', 'geom', 'Wall thickness ≤ min(w,h)/2', s.t, Math.min(s.w, s.h) / 2, '<=', 'in', 'Geometry');
    return C;
  }

  // ---------------------------------------------------------------- placeholder catalog
  // Real standard stock sizes; part numbers and prices are PLACEHOLDERS until replaced with McMaster data.
  const MATERIALS = {
    '6061-T6 aluminum': { E: 68.9, G: 26.0, Sy: 276, rho: 2700, perKg: 14 },
    '304 stainless': { E: 190, G: 73.1, Sy: 276, rho: 8000, perKg: 11 },
    // McMaster stock. E and G for 6061 and 6063: alloy-specific handbook values (ASM / MatWeb data sheets), not Shigley's
    // one value for all aluminum alloys (71.7 / 26.9). Stainless E and G: Shigley Table A-5. Sy for 6061 and 304: the value McMaster lists (35 and 30 ksi).
    // Sy for 6063 (McMaster gives only a 10-20 ksi range) and 316 (not listed) are assumed and should be confirmed.
    '6061': { E: 68.9, G: 26.0, Sy: 241, rho: 2700, name: '6061 aluminum' },
    '6063': { E: 68.9, G: 25.8, Sy: 110, rho: 2700, name: '6063 aluminum', assumed: 'yield strength' },
    '304': { E: 190, G: 73.1, Sy: 207, rho: 8000, name: '304 stainless' },
    '316': { E: 190, G: 73.1, Sy: 207, rho: 8000, name: '316 stainless', assumed: 'yield strength' },
  };
  // Pin yield strength by alloy. McMaster lists breaking strength and hardness, not yield, so these are
  // values. 18-8 (the 304 family): Shigley Table A-22, 304 stainless annealed, Sy = 276 MPa (40 kpsi); McMaster lists
  // HRB 85 min hardness, consistent with annealed. ASTM A276 guarantees only 30 ksi (205 MPa) for annealed bar over 1/2 in.
  // 316 and 17-4 PH (H1150) are assumed and should be confirmed.
  const PIN_SY = { '18-8': 276, '316': 207, '17-4': 724 };
  const PIN_NAME = { '18-8': '18-8 stainless', '316': '316 stainless', '17-4': '17-4 PH stainless' };
  // The real catalog, from the McMaster database (src/mcdata.js).
  function mcmasterCatalog(D) {
    const L = (a) => a.map(([ft, price]) => ({ ft, price }));
    const beams = [];
    for (const b of D.beams) {
      const t = b.type === 'tube' ? b.t : Math.min(b.w, b.h) / 2;
      beams.push({ id: b.part, part: b.part, mat: b.mat, type: b.type, w: b.w, h: b.h, t, lengths: L(b.lengths), url: b.url });
      // the same stock stood on its narrow side, when that side is still wide enough (Req. 13)
      if (b.h >= 4 && b.h !== b.w) beams.push({ id: b.part + '-r', part: b.part, mat: b.mat, type: b.type, w: b.h, h: b.w, t, lengths: L(b.lengths), url: b.url });
    }
    const plates = D.plates.map(p => ({ id: p.part, part: p.part, mat: p.mat, b: p.b, t: p.t, lengths: L(p.lengths), url: p.url }));
    const pins = D.pins.map(p => ({ id: p.part, part: p.part, matKey: p.mat, mat: `${PIN_NAME[p.mat]} ${p.family.toLowerCase()}`, d: p.d, grip: p.grip, Sy: PIN_SY[p.mat], long: !!p.long,
      price: +(p.packPrice / p.pack).toFixed(2), pack: p.pack, packPrice: p.packPrice, brk: p.brk, url: p.url }));
    return { beams, plates, pins, real: true, note: `McMaster-Carr stock and prices read ${D.retrieved}.` };
  }
  // Grip a pin needs: one long pin through the whole stack (beam width plus the thicker outer part each side).
  const N_PINS = 3;
  function gripNeed(B, Pl) {
    return (B ? B.w : 0) + 2 * Math.max(0.5, Pl ? Pl.t : 0);
  }
  // Cheapest pin of the chosen diameter (and alloy, if one is chosen) that is long enough.
  function pickPin(cat, sel, gripIn) {
    const ok = cat.pins.filter(p => p.d === sel.pinD && p.grip >= gripIn - 1e-9 && (!sel.pinMat || sel.pinMat === 'any' || !p.matKey || p.matKey === sel.pinMat));
    return ok.sort((a, b) => a.price - b.price || a.grip - b.grip)[0] || null;
  }
  function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; }
  function prices(key, kg) {
    const out = [];
    for (const ft of [1, 2, 3, 4, 6, 8]) {
      const jitter = 0.9 + 0.2 * hash(key + ft);
      out.push({ ft, price: +((9 + kg * ft * 0.3048 * (ft <= 2 ? 1.25 : 1)) * jitter).toFixed(2) });
    }
    return out;
  }
  function makeCatalog() {
    const beams = [], plates = [], pins = [];
    let k = 1;
    const tube = [[4, 2, 0.125], [4, 2, 0.25], [4, 3, 0.125], [4, 3, 0.25], [4, 4, 0.125], [4, 4, 0.25], [5, 2, 0.25], [5, 3, 0.25], [5, 5, 0.25], [6, 2, 0.25], [6, 3, 0.25], [6, 4, 0.25], [6, 6, 0.25], [8, 2, 0.25], [8, 4, 0.25], [4, 6, 0.25]];
    const ss = [[4, 2, 0.12], [4, 2, 0.188], [4, 3, 0.12], [4, 4, 0.12], [4, 4, 0.188], [5, 3, 0.188], [6, 2, 0.188], [6, 3, 0.12], [6, 3, 0.188], [6, 4, 0.188], [6, 6, 0.188]];
    const bars = [[4, 0.5], [4, 0.75], [4, 1], [4, 1.5], [4, 2], [5, 1], [5, 2], [6, 0.75], [6, 1], [6, 2]];
    const addBeam = (mat, type, w, h, t) => {
      const m = MATERIALS[mat], A = (w * h - (w - 2 * t) * (h - 2 * t)) * IN * IN, kgm = A * m.rho * m.perKg;
      const id = `B${String(k++).padStart(2, '0')}`;
      beams.push({ id, part: `PLACEHOLDER-${id}`, mat, type, w, h, t, lengths: prices(id + mat, kgm) });
    };
    tube.forEach(([w, h, t]) => addBeam('6061-T6 aluminum', 'tube', w, h, t));
    ss.forEach(([w, h, t]) => addBeam('304 stainless', 'tube', w, h, t));
    bars.forEach(([w, h]) => addBeam('6061-T6 aluminum', 'bar', w, h, Math.min(w, h) / 2));
    k = 1;
    for (const mat of Object.keys(MATERIALS)) {
      for (const b of [1, 1.5, 2, 2.5, 3, 4]) for (const t of [0.125, 0.1875, 0.25, 0.375, 0.5, 0.625, 0.75]) {
        if (t >= b) continue;
        const m = MATERIALS[mat], kgm = b * t * IN * IN * m.rho * m.perKg;
        const id = `P${String(k++).padStart(2, '0')}`;
        plates.push({ id, part: `PLACEHOLDER-${id}`, mat, b, t, lengths: prices(id + mat, kgm) });
      }
    }
    k = 1;
    for (const d of [0.25, 0.3125, 0.375, 0.5, 0.625, 0.75]) for (const grip of [2, 3, 4, 5, 6, 7, 8, 10]) {
      const id = `N${String(k++).padStart(2, '0')}`;
      pins.push({ id, part: `PLACEHOLDER-${id}`, mat: '17-4 PH stainless ball-lock pin', d, grip, Sy: 724, price: +((24 + 30 * d * d * 4 + 2.2 * grip) * (0.92 + 0.16 * hash(id))).toFixed(2) });
    }
    return { beams, plates, pins, note: 'Sizes are standard stock; part numbers and prices are placeholders.' };
  }

  // Applies catalog choices to the model inputs.
  function applySelection(model, cat, sel) {
    const set = (id, v) => { const i = model.inputs.find(x => x.id === nameOf(id)); if (i) i.v = v; };
    const conv = (v, from, to) => fromSI(toSI(v, from), to);
    const unitOf = (id) => model.inputs.find(x => x.id === nameOf(id)).unit;
    const B = cat.beams.find(b => b.id === sel.beam);
    if (B) {
      const m = MATERIALS[B.mat];
      set('tube', B.type === 'tube' ? 1 : 0);
      set('w', conv(B.w, 'in', unitOf('w'))); set('h', conv(B.h, 'in', unitOf('h'))); set('t', conv(B.t, 'in', unitOf('t')));
      set('E_b', conv(m.E, 'GPa', unitOf('E_b'))); set('G_b', conv(m.G, 'GPa', unitOf('G_b')));
      set('Sy_b', conv(m.Sy, 'MPa', unitOf('Sy_b'))); set('rho_b', m.rho);
    }
    const Pl = cat.plates.find(p => p.id === sel.plate);
    if (Pl) {
      const m = MATERIALS[Pl.mat];
      set('b_p', conv(Pl.b, 'in', unitOf('b_p'))); set('t_p', conv(Pl.t, 'in', unitOf('t_p')));
      set('E_d', conv(m.E, 'GPa', unitOf('E_d'))); set('Sy_d', conv(m.Sy, 'MPa', unitOf('Sy_d'))); set('rho_d', m.rho);
    }
    if (sel.pinD) {
      set('d_p', conv(sel.pinD, 'in', unitOf('d_p')));
      const pn = pickPin(cat, sel, gripNeed(B, Pl)) || cat.pins.find(p => p.d === sel.pinD);
      if (pn) { set('Sy_p', conv(pn.Sy, 'MPa', unitOf('Sy_p'))); set('F_brk', pn.brk || 0); }
    }
    if (sel.a != null) set('a', conv(sel.a, 'mm', unitOf('a')));
  }

  // Everything a search result depends on, as a short key: two searches with the same key give the same
  // designs, so a saved result can be shown instead of searching again. The inputs a search sets itself for
  // every candidate (SEARCH_SETS, what applySelection writes) are left out, so loading a design does not
  // change the key. Bump SEARCH_VER when the search or the solver's numbers change.
  const SEARCH_VER = 3;
  const SEARCH_SETS = ['tube', 'w', 'h', 't', 'E_b', 'G_b', 'Sy_b', 'rho_b', 'b_p', 't_p', 'E_d', 'Sy_d', 'rho_d', 'd_p', 'Sy_p', 'F_brk', 'a'];
  function searchKey(model, cat, opts) {
    const set = new Set(SEARCH_SETS.map(nameOf));
    const str = JSON.stringify([SEARCH_VER, opts.step, opts.maxCost, model.inputs.map(i => (set.has(i.id) ? [i.id, i.unit] : [i.id, i.unit, i.v])),
      model.defs.map(d => [d.id, d.expr]), model.loads, model.dist, model.unknowns, model.constraint, model.point, cat.beams, cat.plates, cat.pins]);
    let h1 = 2166136261, h2 = 5381;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (Math.imul(h2, 33) + c) | 0; }
    return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36) + '-' + str.length.toString(36);
  }

  function shortestStock(item, need) {
    if (!item) return null;
    const ok = item.lengths.filter(l => l.ft * 0.3048 >= need - 1e-9).sort((a, b) => a.ft - b.ft);
    return ok.length ? ok[0] : null;
  }

  function costOf(cat, sel, s) {
    const B = cat.beams.find(b => b.id === sel.beam), Pl = cat.plates.find(p => p.id === sel.plate);
    const bs = shortestStock(B, s.L_b), ps = shortestStock(Pl, s.L_dst);
    const gripIn = gripNeed(B, Pl);
    const pin = pickPin(cat, sel, gripIn);
    const lines = [
      { item: 'Support beam', qty: 1, part: B ? B.part : '—', desc: B ? `${(MATERIALS[B.mat] || {}).name || B.mat} ${B.type === 'tube' ? 'rect. tube' : 'bar'} ${B.w}″ × ${B.h}″${B.type === 'tube' ? ` × ${B.t}″ wall` : ''}, ${bs ? bs.ft + ' ft' : 'no stock long enough'}` : 'custom section', unit: bs ? bs.price : NaN },
      { item: 'Diagonal stock (cut into 2)', qty: 1, part: Pl ? Pl.part : '—', desc: Pl ? `${(MATERIALS[Pl.mat] || {}).name || Pl.mat} bar ${Pl.b}″ × ${Pl.t}″, ${ps ? ps.ft + ' ft' : 'no stock long enough'}` : 'custom plate', unit: ps ? ps.price : NaN },
      { item: 'Pins', qty: N_PINS, part: pin ? pin.part : '—', desc: pin ? `${pin.mat}, Ø${pin.d}″, ${pin.grip}″ grip` : `no Ø${sel.pinD}″ pin with ≥ ${gripIn.toFixed(2)}″ grip`, unit: pin ? pin.price : NaN },
    ];
    lines.forEach(l => (l.total = l.qty * l.unit));
    return { lines, total: lines.reduce((a, l) => a + l.total, 0), beamStock: bs, plateStock: ps, pin };
  }

  // For each check that is settled without the along-the-beam work: the inputs its numbers depend on,
  // traced through the definitions and the statics. Two candidates that agree on those inputs get the same
  // verdict on that check, so the search solves the first and skips the rest.
  function checkInputs(m, pl) {
    const inputs = new Map(m.inputs.map(i => [i.id, i]));
    const names = (x) => [x, NAMES[x], NEW2OLD[x]].filter(Boolean);
    const react = new Set(m.unknowns.flatMap(u => names(u.id))), engine = new Set(ENGINE_OUT.flatMap(names));
    const seen = new Map();
    // null means "needs the along-the-beam results"
    const join = (sets) => { const out = new Set(); for (const x of sets) { if (!x) return null; x.forEach(i => out.add(i)); } return out; };
    const ofExpr = (expr, skip) => { const c = cparse(String(expr)); return c.err ? new Set() : join([...c.deps].filter(x => !(skip && skip.has(x))).map(of)); };
    let stat;
    const statics_ = () => {
      if (stat !== undefined) return stat;
      stat = new Set();
      const ex = [];
      for (const l of m.loads) ex.push(l.x, l.y, l.z, l.Fx, l.Fy, l.Fz, l.Mx || '0', l.My || '0', l.Mz || '0');
      if (m.dist && m.dist.on) ex.push(m.dist.x0, m.dist.x1, m.dist.q);
      for (const u of m.unknowns) ex.push(u.x, u.y, u.z, u.ux, u.uy, u.uz);
      const p = m.point || { id: 'O' };
      if (p.id !== 'custom') { const d = POINTS.find(q => q.id === p.id) || POINTS[0]; ex.push(RX(d.x), RX(d.y), RX(d.z)); }
      return (stat = join([...ex.map(e => ofExpr(e)), ofExpr(m.constraint, react)]));
    };
    function of(x) {
      if (seen.has(x)) return seen.get(x);
      seen.set(x, new Set());
      const parts = [];
      for (const k of names(x)) {
        if (inputs.has(k)) parts.push(new Set([inputs.get(k)]));
        if (pl.byId.has(k)) parts.push(ofExpr(pl.byId.get(k).expr));
        if (react.has(k)) parts.push(statics_());
        else if (engine.has(k)) parts.push(null);
      }
      const out = join(parts);
      seen.set(x, out);
      return out;
    }
    const reads = [];
    let cur = [];
    buildChecks(new Proxy(run(m, { light: true, plan: pl }).scope, { get: (t, k) => { cur.push(k); return t[k]; } }), (id) => { reads.push([id, cur]); cur = []; });
    return reads.map(([id, ks]) => ({ id, ins: join(ks.map(of)) })).filter(c => c.ins).map(c => ({ id: c.id, ins: [...c.ins] }));
  }

  // Cheapest passing design, and among equally cheap ones the smallest CG deflection.
  // Every beam x plate x pin diameter is a part set. Its cost only changes with the attach point a when
  // the diagonal needs the next stock length, so each part set is split into groups of a values that cost
  // the same. Groups are tried cheapest first; the search stops after the cheapest cost that has a pass.
  // With opts.maxCost it keeps going up to that budget and returns every design worth considering
  // (opts.front): each one has less CG deflection than everything cheaper than it.
  // opts.part = [k, n] searches only every n-th beam and pin diameter pairing, starting at the k-th, so n
  // copies of the search can run side by side (one per processor core) and searchMerge puts their results
  // together. A pairing stays in one copy because that is where candidates repeat each other's checks.
  function* optimize(baseModel, cat, opts = {}) {
    const step = opts.step || 5, aMin = opts.aMin || 250, aMax = opts.aMax || 800;
    const deflMax = opts.deflMax > 0 ? opts.deflMax : Infinity; // optional tighter CG deflection target (m)
    const aList = opts.aList || Array.from({ length: Math.floor((aMax - aMin) / step) + 1 }, (_, k) => aMin + k * step);
    const pinDs = [...new Set(cat.pins.map(p => p.d))];
    const groups = [];
    const maxCost = opts.maxCost > 0 ? opts.maxCost : 0;
    const m = JSON.parse(JSON.stringify(baseModel)), pl = plan(m), scope = {};
    const ia = m.inputs.find(x => x.id === nameOf('a'));
    // per check: which inputs decide it, and the input values already seen to fail it
    const memo = checkInputs(m, pl).map(c => ({ id: c.id, ins: c.ins.filter(i => i !== ia), a: c.ins.includes(ia), fails: new Map(), cur: null }));
    let total = 0;
    for (const B of cat.beams) for (const Pl of cat.plates) for (const d of pinDs) {
      const bi = cat.beams.indexOf(B), di = pinDs.indexOf(d);
      if (opts.part && (bi * pinDs.length + di) % opts.part[1] !== opts.part[0]) continue;
      if (B.w < 4 - 1e-9) continue;
      const dh = d * IN + itol(d * IN, 8);
      if (B.h * IN / 2 < 2 * dh || Pl.b * IN / 2 < 2 * dh) continue;
      const bs = shortestStock(B, 1.35);
      if (!bs) continue;
      const pin = pickPin(cat, { pinD: d }, gripNeed(B, Pl));
      if (!pin) continue;
      const byStock = new Map();
      for (const a of aList) {
        // cheap cost estimate with geometry only
        const LD = Math.hypot(a / 1000, 0.5), ps = shortestStock(Pl, 2 * (LD + 4 * dh) + 0.003);
        if (!ps) continue;
        total++;
        const cost = bs.price + ps.price + N_PINS * pin.price;
        if (maxCost && cost > maxCost + 1e-9) continue; // over budget: counted, never solved
        // seq: where this group falls in the unsplit search among groups of equal cost
        if (!byStock.has(ps.ft)) byStock.set(ps.ft, { seq: ((bi * cat.plates.length + cat.plates.indexOf(Pl)) * pinDs.length + di) * 1000 + byStock.size, sel: { beam: B.id, plate: Pl.id, pinD: d, pinMat: 'any' }, as: [], cost });
        byStock.get(ps.ft).as.push(a);
      }
      groups.push(...byStock.values());
    }
    groups.sort((x, y) => x.cost - y.cost);
    const front = [], all = []; // all: every passing design seen
    let tried = 0, best = null, lastYield = 0;
    for (const g of groups) {
      if (maxCost ? g.cost > maxCost + 1e-9 : best && g.cost > best.cost + 1e-9) break;
      let gb = null;
      applySelection(m, cat, { ...g.sel, a: g.as[0] });
      for (const c of memo) {
        const key = c.ins.map(i => i.v).join();
        if (!c.fails.has(key)) c.fails.set(key, new Set());
        c.cur = c.fails.get(key);
      }
      for (const a of g.as) {
        tried++;
        // already known to fail a check with these same inputs
        if (memo.some(c => c.cur.has(c.a ? a : 0))) continue;
        ia.v = fromSI(a / 1000, ia.unit);
        // cheap checks first: anything that fails without the along-the-beam work is out already
        const pre = run(m, { light: true, plan: pl, scope });
        if (pre.fatal) continue;
        const bad = pre.checks.filter(k => isFinite(k.val) && !k.ok);
        for (const k of bad) { const c = memo.find(x => x.id === k.id); if (c) c.cur.add(c.a ? a : 0); }
        if (bad.length) continue;
        const r = run(m, { n: 120, plan: pl, scope });
        if (r.pass) all.push({ g: g.sel, a, cost: g.cost, defl: r.scope.delta_CG, seq: g.seq });
        if (r.pass && r.scope.delta_CG <= deflMax && (!gb || r.scope.delta_CG < gb.defl)) gb = { sel: { ...g.sel, a }, cost: g.cost, defl: r.scope.delta_CG };
      }
      if (gb) {
        const last = front[front.length - 1];
        if (!last || gb.defl < last.defl - 1e-9) { if (last && Math.abs(last.cost - gb.cost) < 1e-9) front.pop(); front.push(gb); }
        if (!best || (Math.abs(gb.cost - best.cost) < 1e-9 && gb.defl < best.defl)) best = gb;
      }
      if (tried - lastYield >= 400) { lastYield = tried; yield { done: false, tried, total, front, passing: all.length }; }
    }
    yield { done: true, found: best, front, all, tried, total };
  }
  // Joins the finished results of a search that was split with opts.part (needs opts.maxCost, so every
  // part searched up to the same budget). Same answer as one unsplit search.
  function searchMerge(parts) {
    const all = parts.flatMap(p => p.all).sort((x, y) => x.cost - y.cost || x.seq - y.seq || x.a - y.a);
    const front = [];
    let best = null;
    for (let i = 0; i < all.length;) {
      let j = i, gb = null;
      for (; j < all.length && all[j].seq === all[i].seq; j++) if (!gb || all[j].defl < gb.defl) gb = all[j];
      gb = { sel: { ...gb.g, a: gb.a }, cost: gb.cost, defl: gb.defl };
      const last = front[front.length - 1];
      if (!last || gb.defl < last.defl - 1e-9) { if (last && Math.abs(last.cost - gb.cost) < 1e-9) front.pop(); front.push(gb); }
      if (!best || (Math.abs(gb.cost - best.cost) < 1e-9 && gb.defl < best.defl)) best = gb;
      i = j;
    }
    return { done: true, found: best, front, all, tried: parts.reduce((n, p) => n + p.tried, 0), total: parts.reduce((n, p) => n + p.total, 0) };
  }

  return {
    UNITS, toSI, fromSI, itol, parse, evalAst, deps, toTeX, symTeX, fmtNum, A, isZero, cparse, ev,
    defaultModel, run, plan, evalLoads, statics, internalAt, symbolicInternal, symbolicReactions, subst, expandDefs, stressForm, STRESS_FORMS, deflForm, DEFL_FORMS, sectionStress, sigmaAt, beamAnalysis,
    setHover, POINTS, ENGINE_OUT, MATERIALS, NAMES, nameOf, renameExpr, classify, classOf, CLASS_COLOR, makeCatalog, mcmasterCatalog, pickPin, gripNeed, N_PINS, PIN_NAME, applySelection, costOf, shortestStock, optimize, searchMerge, searchKey, IN, TEX_OVERRIDE,
  };
})();
if (typeof module !== 'undefined') module.exports = DP1;
