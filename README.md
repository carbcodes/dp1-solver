# DP1 Solver — Microhydro Rotor Support Structure

Calculation engine for ME 3180 Design Problem #1 (Fall 2026): power and chain loads, statics and pin reactions, beam internal loads and stresses, pin and diagonal checks, and rotor CG deflection (numerical integration, trapezoid rule).

## Files

- `src/engine.js` — the solver: model, equations, statics, internal loads, stresses, deflection, cost.
- `src/mcdata.js` — McMaster-Carr stock and pin data used for part selection (retrieved 2026-10-10).
- `check.cjs` — checks on the engine (power, chain force, equilibrium residuals, closed form vs. matrix solve).

## Run

Requires Node.js.

```
node check.cjs
```
