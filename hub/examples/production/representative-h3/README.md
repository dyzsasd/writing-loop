# Representative MiniMax H3 production bundle

This installable example couples an owner-only production runtime config with one immutable
MiniMax H3 `fl2va` Comfy API-format template. The config is deterministically derived from the
executable runtime fixture in the Phase 3C AI-SPEC; its workflow and parameter digests are then
calculated by the same canonical H3 implementation used at runtime.

It contains no real credential value and the smoke performs no network request. The config contains
only a credential environment-variable **name** and example-only service origins. `smoke.mjs`
copies the config/template to private `0600` files, injects fake ports and a throwaway in-memory
placeholder, parses the strict config, materializes one template→bound receipt, assembles the
runtime, and takes the worker `--once` path over an empty workspace.

From an installed npm package:

```sh
node node_modules/@dyzsasd/writing-loop/examples/production/representative-h3/smoke.mjs
```

The graph is a narrow representative contract fixture. It has **not** passed a live ComfyUI
`/prompt`, does not install model weights, and is not an H3 deployment claim. Before deployment,
copy the files outside `node_modules`, replace the example origins, credential env names, model
aliases and artifact attestations with operator-owned values, recalculate all canonical digests,
run a pinned live compatibility probe, and keep the runtime config/template owner-only.
