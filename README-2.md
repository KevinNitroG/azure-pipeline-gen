# Monorepo pipeline

```
azure-pipelines.yml                         triggers, parameters, resources  ->  extends:
.azure-pipelines/
├─ config/
│  ├─ monorepo.graph.json                   project dependency graph (single source of truth)
│  └─ variables.yml                         shared variables (toolchain versions, cache paths, ACR)
├─ scripts/
│  ├─ lib/graph.js                          graph loading, closures, glob matching
│  ├─ detect-changes.js                     git diff -> affected / needed / matrices
│  ├─ validate-graph.js                     graph vs package.json + csproj drift check
│  ├─ compute-version.sh                    conventional-commit semver
│  ├─ helm-deploy.sh                        stable | canary-* | rollback | verify
│  └─ notify-teams.sh
├─ pipelines/
│  └─ docs-scheduled.yml                    2nd pipeline, consumes CI artifacts via resources.pipelines
└─ templates/
   ├─ extends/monorepo.yml                  the stage graph + environment topology
   ├─ stages/   detect codegen quality build-test integration docs package e2e deploy-env release notify
   ├─ jobs/     node-package dotnet-service go-service deploy-service deploy-web
   └─ steps/    checkout setup-node setup-dotnet setup-go download-generated build-docs helm-step
```

## Stage flow



```
Detect ─► Codegen ─┬─► Quality ───────────────┐
                   ├─► BuildTest ─► Integration ─┴─► Package ─► E2E ─► DeployDev ─► DeployStaging ─► DeployProd ─► Release
                   └─► Docs (PR preview / main publish)                                                           Notify (always)
```

## How the cross-references work

| Reference           | Mechanism                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| project → project   | `monorepo.graph.json` `dependsOn` (transitive). Verified against `package.json` / `*.csproj` by `validate-graph.js` in the Quality stage.        |
| change → work to do | `detect-changes.js` emits `affected_<p>` (test/deploy) and `needed_<p>` (build = affected ∪ their deps) as step outputs.                         |
| stage → stage data  | `dependencies.Detect.outputs['Plan.plan.x']` in stage conditions, `stageDependencies.Detect.Plan.outputs['plan.x']` in job conditions/variables. |
| dynamic fan-out     | `matrix_node`, `matrix_dotnet`, `matrix_go`, `matrix_image` -> `strategy.matrix: $[ ... ]`.                                                      |
| package → package   | each node job publishes `pkg-<name>`; dependents download those into `<dep>/dist` instead of rebuilding.                                         |
| codegen → everyone  | `generated` artifact fanned out by `steps/download-generated.yml` to TS / C# / Go / proto / OpenAPI locations.                                   |
| build → deploy      | `image-manifest-*` (digest), `pkg-web`, `ef-bundle`, `svc-*` artifacts. Build once, promote the same bits.                                       |
| pipeline → pipeline | `docs-scheduled.yml` triggers on CI, downloads its artifacts, and checks out `resources.pipeline.ci.sourceCommit`.                               |
| file → file         | `steps/build-docs.yml` and `steps/download-generated.yml` are shared by both pipelines.                                                          |

## Things you must provide in the repo

- `package.json` scripts: `build`, `test:ci` (writes `test-results/junit.xml`, `coverage/cobertura-coverage.xml`), `size` (web), `docs:typedoc` (root), `codegen:*` as used by generators
- `.dependency-cruiser.cjs`, `eslint.config.*`, `.prettierrc`, `packages/contracts/openapi/api.yaml`, `packages/contracts/buf.gen.yaml`
- `services/api`: `Acme.Api.sln`, Dockerfile that copies `publish/`; `/healthz`; tests tagged `Category=Integration`
- `services/worker`: `go.work` including `packages/contracts/generated/go`, `cmd/worker`, Dockerfile that copies `publish/`
- `deploy/charts/service` (supports `image.repository`, `image.digest`, `canary.enabled`, `canary.weight`, `stableService`), `deploy/values/<env>/<service>.yaml`, `deploy/compose/e2e.yml`
- `infra/main.bicep`, `infra/params/<env>.bicepparam`; `tests/e2e` (Playwright with a `smoke` project); `tests/load/baseline.js`; `docs/` (Docusaurus, `docs/dotnet/docfx.json`)

## Things you must create in Azure DevOps

- Variable groups: `acme-platform-shared` (`teamsWebhookUrl`, `docsSwaToken`), `acme-platform-dev|staging|prod` (`swaToken`)
- Service connections: `sc-acme-acr`, `sc-acme-dev|staging|prod`
- Environments: `acme-dev`, `acme-staging`, `acme-prod` (+ `-infra` variants), `acme-docs-production` (put approvals/checks on staging/prod)
- Build service permissions: Contribute + Create tag (Release stage tags the repo); Reader on the Azure Artifacts feeds
- Rename `source: acme-platform-ci` in `docs-scheduled.yml` to your CI pipeline's name

## Design notes

- Every stage lists _all_ upstream stages in `dependsOn`, and uses `not(failed())` rather than `succeeded()`. A stage skipped by change detection is therefore treated as "nothing to do", while a failure anywhere still blocks promotion.
- On PRs the pipeline stops after Quality / BuildTest / Integration / Docs preview; images are built and scanned but not pushed.
- `needed` but not `affected` projects (unchanged dependencies) are built but not tested; E2E-affecting changes rebuild all three deployables so E2E always runs against images from the same run.

## References

- https://github.com/microsoft/MSBuildSdks/blob/eeadbd0c1d4fecbd95f5c6d4c8194726998508bc/azure-pipelines.yml#L4
- https://github.com/microsoft/azure-pipelines-tasks
- https://github.com/microsoft/azure-pipelines-tasks/blob/master/azure-pipelines.yml
