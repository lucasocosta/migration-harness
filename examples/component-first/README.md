# Executable component-first example (P6 case)

Synthetic Angular (source) and React (target) applications that exercise the two P6
capabilities the other examples do not: a **component without its own route** driven through
authorized host routes, and **two units ordered by dependency** (`formulario-pedido`
consumes `seletor-quantidade`). Dependencies come from the installed harness workspace;
each app is an independent esbuild bundle inside the example, like `examples/validation-first`.

The committed destination is **implemented**. A fresh session should verify PASS.
The historical exercise implemented Unit A before its first verification and then
repaired Unit B; that earlier incomplete state is described below as history.

| Unit | Scenario ids | Source (Angular :4210) | Target (React :5175) |
| --- | --- | --- | --- |
| A `seletor-quantidade` (no route) | `seletor-incrementar-ate-maximo`, `seletor-decrementar-ate-minimo`, `seletor-teclado`, `seletor-callback-host` | `/host/seletor` implemented | `/host/seletor` bounds, keyboard and `onChange` implemented |
| B `formulario-pedido` (uses A) | `pedido-fluxo-completo` | `/host/pedido` total + confirm | `/host/pedido` total and confirmation implemented |

## Layout

```
migration.json            profile "standard", 5 scenarios, 11 unit-scoped requirements
angular/                  main.ts (hosts + path switch), seletor-quantidade.ts, formulario-pedido.ts,
                          design-system.ts, design-system.css, build.mjs, package.json
react/                    App.tsx (hosts), SeletorQuantidade.tsx, FormularioPedido.tsx,
                          design-system.mjs + design-system.test.mjs (protected), build.mjs, package.json
fixtures/README.md        no mocks: both hosts are static, so nothing is fetched
```

Routes are resolved from `window.location.pathname` in each app; the managed static server
already falls back to `index.html` for extensionless paths, so `/host/*` works with a normal
build and no router dependency. The only shared "shell" is the index route listing the hosts.

## Build locally

```bash
npm run build --prefix examples/component-first/angular
npm run build --prefix examples/component-first/react
npm test --prefix examples/component-first/react      # protected design-system regression
```

Both apps are self-contained: `build.mjs` bundles the app and copies `design-system.css` to
`dist/styles.css`. `dist/` is disposable managed build output and must stay out of scope edits.

## Verify the implemented example

Ports 4210/5175 must be free; the harness owns and closes both servers. Use a fresh
`--artifact-path` for preparation, and never reset a session to dodge a budget.

```bash
node packages/cli/dist/index.js prepare-migration \
  --config examples/component-first/migration.json --workspace-root . \
  --artifact-path artifacts/component-first/prepared --allow-project-commands
node packages/cli/dist/index.js start-migration-session \
  --config examples/component-first/migration.json --workspace-root . \
  --preparation artifacts/component-first/prepared/preparation.json
# The committed components are implemented; verify the complete integrated suite:
node packages/cli/dist/index.js verify-migration \
  --config examples/component-first/migration.json --workspace-root . --allow-project-commands
node packages/cli/dist/index.js migration-session-status \
  --config examples/component-first/migration.json --workspace-root .
```

If this workspace already has a session, inspect it with `migration-session-status`
and continue it within its remaining budget. For an independent automated check,
run `node --test tests/browser/component-first.test.mjs` after building the harness;
the test copies the example and creates its own isolated session.

Recorded sequence (2026-09-12 session `16afbd43dd389ed382272b9939e73dae`): run 0000
was INCONCLUSIVE with Unit A's four scenarios already PASS (Unit A was implemented
before the first verification) and `pedido-fluxo-completo` failing at `ajustar-dois`
because the Unit B integration was still the placeholder; the harness requested
REPAIR_IMPLEMENTATION, the session implemented the Unit B total/confirm integration,
and run 0001 passed the full integrated suite (5/5 scenarios, 11/11 requirements,
zero diagnostics). The point of the example stands: `pedido-fluxo-completo` is only
satisfiable once the migrated `SeletorQuantidade` is wired into `FormularioPedido` —
the total and the confirm payload depend on the migrated component. That dependency
ordering is why A and B are separate `unitId`s instead of one scenario set, and it is
declared in [SPEC.md](SPEC.md).

## What is observable, and what is not

- No network: both hosts are static, so `NO_REQUEST` on `/api/pedido` documents that the
  confirm effect is DOM-only. Output capture for callbacks works by the host rendering the
  payload as text (`role="alert"` / `role="status"`), no new schema is involved.
- Keyboard coverage uses `press` on the focused button (Playwright focuses then presses), which
  is what `Tab`+`Enter`/`Space` mean for a native `<button>`; the ARIA `disabled` state at the
  min/max bounds is asserted with unit-scoped `NODE_PRESENT` claims inside `unitScope`
  `{"role":"main"}`, so destination shell differences around the unit stay irrelevant.
- Design-system integration is structural: both sides render the same accessible nodes with the
  same `ds-*` classes, and the React component must import `designTokens`/`formatarMoeda` from
  the protected `design-system.mjs` rather than restyle or reimplement them. Class names are not
  part of the ARIA tree, so no requirement claims them; the protected native regression check is
  what pins those tokens.
- Everything here is invented (labels, prices, ranges). No value derives from a trace.

Preparation fixes source behavior but does not approve a migration, and a verification PASS
covers only the declared suite, requirements and native checks: two happy-ish paths plus four
unit-scope states, not exhaustive input ranges or visual parity.
