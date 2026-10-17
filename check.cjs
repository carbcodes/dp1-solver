// Engine checks: node "Tools/DP1 Solver/check.cjs"
const assert = require('node:assert');
const E = require('./src/engine.js');
const cat = E.makeCatalog();
const m = E.defaultModel();
E.applySelection(m, cat, { beam: 'B15', plate: 'P24', pinD: 0.375, a: 250 });
const r = E.run(m);
assert.ok(!r.fatal, r.fatal);
assert.deepStrictEqual(r.errors, {});
const s = r.scope;
// power and chain
assert.ok(Math.abs(s.P_f - 1953.125) < 1e-6);
assert.ok(Math.abs(s.P_e - 480.47) < 0.01);
assert.ok(Math.abs(s.T_c - 161.80) < 0.01);
assert.ok(Math.abs(s.p_c / 0.0254 - 0.5) < 1e-3, 'chain pitch 0.5 in');
// equilibrium residuals ≈ 0 about P, O and an arbitrary point
for (const v of [...r.st.residP, ...r.st.residO, ...r.st.residFar]) assert.ok(Math.abs(v) < 1e-8);
// reactions independent of moment point
for (const p of E.POINTS) {
  const r2 = E.run({ ...m, point: { id: p.id } });
  for (const k of Object.keys(r.st.R)) assert.ok(Math.abs(r2.st.R[k] - r.st.R[k]) < 1e-6, `${k} about ${p.id}`);
}
// closed form about O equals the matrix solve
for (const [a, b] of [['D_F', 'D_Fc'], ['D_R', 'D_Rc'], ['R_yF', 'R_yc'], ['R_xF', 'R_xFc'], ['R_xR', 'R_xRc'], ['R_z', 'R_zc']])
  assert.ok(Math.abs(s[a] - s[b]) < 1e-6 * (1 + Math.abs(s[a])), `${a} closed form`);
// a = 800, w = 4, h = 2, no self/chain weight, pin loads at the beam faces (Piazza @37):
// Delta_D = F_D·|y_P|/(s_D·u_y) = 560·0.5254/(0.0508·0.530) = 10.93 kN → D_R ≈ +5.70 kN, D_F ≈ −5.22 kN
const m3 = E.defaultModel();
const set = (id, v) => (m3.inputs.find(i => i.id === E.nameOf(id)).v = v);
set('a', 800); set('w', 4); set('h', 2); set('inc_bw', 0); set('inc_ch', 0); set('t_p', 0.25);
const r3 = E.run(m3);
assert.ok(Math.abs(r3.st.R.D_R - 5704) < 5 && Math.abs(r3.st.R.D_F + 5224) < 5);
// internal loads vanish past the free left end and balance at the wall end
const left = E.internalAt(s.x_L + 1e-6, r.L, r.st.R);
for (const k of ['N', 'Vy', 'Vz', 'T', 'My', 'Mz']) assert.ok(Math.abs(left[k]) < 1e-2, k);
const right = E.internalAt(s.x_E - 1e-6, r.L, r.st.R);
for (const k of ['N', 'Vy', 'Vz', 'T', 'My', 'Mz']) assert.ok(Math.abs(right[k]) < 1, `right ${k} = ${right[k]}`);
// symbolic internal loads evaluate to the numeric ones everywhere along the beam
{
  const si = E.symbolicInternal(m, s);
  for (const xc of [-1.25, -1.0, -0.6, -0.22, -0.1, 0.03]) {
    const sc = Object.assign(Object.create(s), r.st.R, { x: xc }), num = E.internalAt(xc, r.L, r.st.R);
    for (const k of ['N', 'Vy', 'Vz', 'T', 'My', 'Mz']) {
      let v = 0;
      for (const o of si.stations) if (o.x < xc) for (const tm of o[k]) v += E.evalAst(tm, sc);
      if (si.dist && si.dist[k]) for (const tm of si.dist[k]) v += E.evalAst(tm, sc);
      assert.ok(Math.abs(v - num[k]) < 1e-6 * (1 + Math.abs(num[k])), `symbolic ${k} at x = ${xc}: ${v} vs ${num[k]}`);
    }
  }
}
// generated reaction formulas equal the matrix solve, also after adding a load
{
  const chk = (mm, tag) => {
    const rr = E.run(mm), sr = E.symbolicReactions(mm);
    assert.ok(sr, 'symbolic reactions available');
    for (const st of sr.steps) for (const id of [st.id, st.also].filter(Boolean)) {
      const v = E.evalAst(st.ast, rr.scope), ref = rr.st.R[id];
      assert.ok(Math.abs(v - ref) < 1e-6 * (1 + Math.abs(ref)), `${tag}: ${id} formula ${v} vs solve ${ref}`);
    }
  };
  chk(m, 'default');
  const m4 = JSON.parse(JSON.stringify(m));
  m4.loads.push({ id: 'LX', name: 'extra', tex: 'F_{new}', x: '-0.7', y: '-0.2', z: '0.03', Fx: '40', Fy: '-75', Fz: '22', Mx: '3', My: '-5', Mz: '7', on: true });
  chk(m4, 'extra load');
}
// the stress formulas the page prints are the ones the solver evaluates, and match the textbook form
{
  const f = E.internalAt(-0.6, r.L, r.st.R), st = E.sectionStress(f, s, false), stn = E.sectionStress(f, s, true);
  const ref = { sN: Math.abs(f.N) / s.A_b, sMz: Math.abs(f.Mz) * (s.h / 2) / s.I_z, sMy: Math.abs(f.My) * (s.w / 2) / s.I_y, tT: s.k_T * Math.abs(f.T), tVy: Math.abs(f.Vy) * s.Q_z / (s.I_z * s.b_z), tVz: Math.abs(f.Vz) * s.Q_y / (s.I_y * s.b_y) };
  for (const k in ref) assert.ok(Math.abs(st[k] - ref[k]) < 1e-9 * (1 + ref[k]), 'stress ' + k);
  assert.ok(Math.abs(st.vm - Math.hypot(ref.sN + ref.sMz + ref.sMy, Math.sqrt(3) * (ref.tT + ref.tVy + ref.tVz))) < 1e-6 * st.vm);
  assert.ok(Math.abs(stn.sN - Math.abs(f.N) / s.A_n) < 1e-9 * (1 + stn.sN) && stn.sMy > st.sMy);
}
// CG deflection from the printed formulas equals the sum of its contributions
{
  const cg = r.beam.cg, sum = [0, 0, 0];
  Object.values(cg.comp).forEach(cv => cv.forEach((x, i) => (sum[i] += x)));
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(sum[i] - cg.tot[i]) < 1e-12 + 1e-9 * Math.abs(sum[i]), `CG component ${i}: ${cg.tot[i]} vs ${sum[i]}`);
  assert.ok(Math.abs(s.delta_CG - Math.hypot(...sum)) < 1e-12, 'delta_CG');
}
// CG deflection agrees with an independent unit-load (virtual work) calculation in x, y and z
{
  const N = 4000, k = s.L_D / (s.E_d * s.b_p * s.t_p);
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((dir, i) => {
    const mv = JSON.parse(JSON.stringify(m));
    mv.loads = [{ id: 'U', name: 'unit', x: '-Rotor_x', y: 'RotorCG_y', z: '0', Fx: String(dir[0]), Fy: String(dir[1]), Fz: String(dir[2]), Mx: '0', My: '0', Mz: '0', on: true }];
    mv.dist.on = false;
    const Lv = E.evalLoads(mv, s), Rv = E.statics(mv, s, Lv).R;
    let d = (r.st.R.D_F * Rv.D_F + r.st.R.D_R * Rv.D_R) * k;
    for (let j = 0; j < N; j++) {
      const dx = (s.x_E - s.x_L) / N, x = s.x_L + dx * (j + 0.5), F = E.internalAt(x, r.L, r.st.R), f = E.internalAt(x, Lv, Rv);
      d += (F.My * f.My / (s.E_b * s.I_y) + F.Mz * f.Mz / (s.E_b * s.I_z) + F.T * f.T / (s.G_b * s.J_b) + F.N * f.N / (s.E_b * s.A_b)) * dx;
    }
    assert.ok(Math.abs(d - r.beam.cg.tot[i]) < 2e-6 + 0.01 * Math.abs(d), `CG ${'xyz'[i]}: unit-load ${d} vs solver ${r.beam.cg.tot[i]}`);
  });
}
// expression language
assert.strictEqual(E.ev('if(2>1, 3, 4) + max(1,5)^2', {}), 28);
assert.ok(r.pass, 'default design passes');
// design search: the skipping search, and the same search split in three and merged, both find exactly
// the designs that pass when every candidate is solved in full
{
  const sub = { ...cat, beams: cat.beams.filter((_, i) => i % 7 === 0), plates: cat.plates.filter(p => E.MATERIALS[p.mat].perKg).filter((_, i) => i % 5 === 0) };
  const aList = [300, 550, 800], opts = { aList, maxCost: 1e9 }, key = (p) => [p.g.beam, p.g.plate, p.g.pinD, p.a].join('|');
  const last = (gen) => { let x; for (x of gen); return x; };
  const m2 = E.defaultModel(), want = [];
  for (const B of sub.beams) for (const Pl of sub.plates) for (const d of new Set(sub.pins.map(p => p.d))) for (const a of aList) {
    const sel = { beam: B.id, plate: Pl.id, pinD: d, pinMat: 'any', a };
    E.applySelection(m2, sub, sel);
    const r2 = E.run(m2, { n: 120 });
    if (r2.pass && isFinite(E.costOf(sub, sel, r2.scope).total)) want.push(key({ g: sel, a }));
  }
  const one = last(E.optimize(E.defaultModel(), sub, opts));
  const split = E.searchMerge([0, 1, 2].map(k => last(E.optimize(E.defaultModel(), sub, { ...opts, part: [k, 3] }))));
  assert.ok(want.length > 20, 'search test has passing designs');
  assert.deepStrictEqual(one.all.map(key).sort(), want.sort(), 'search finds exactly the passing designs');
  const bare = (x) => ({ ...x, all: x.all.map(({ seq, ...p }) => p) });
  assert.deepStrictEqual(bare(split), bare(one), 'split search equals unsplit search');
  // a saved search may be reused when the key matches: loading another design must not change the key or the result
  const m3 = E.defaultModel();
  E.applySelection(m3, sub, { beam: sub.beams[2].id, plate: sub.plates[5].id, pinD: 0.75, pinMat: 'any', a: 640 });
  assert.strictEqual(E.searchKey(m3, sub, opts), E.searchKey(E.defaultModel(), sub, opts), 'search key ignores the loaded design');
  assert.deepStrictEqual(last(E.optimize(m3, sub, opts)), one, 'search result does not depend on the loaded design');
  m3.inputs.find(i => i.id === E.nameOf('n_d')).v += 0.5;
  assert.notStrictEqual(E.searchKey(m3, sub, opts), E.searchKey(E.defaultModel(), sub, opts), 'search key changes with a requirement');
  assert.notStrictEqual(E.searchKey(E.defaultModel(), sub, { ...opts, maxCost: 500 }), E.searchKey(E.defaultModel(), sub, opts), 'search key changes with the budget');
}
console.log('All engine checks passed.');
