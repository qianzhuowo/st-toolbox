# Imported source provenance

`features/tomatojuice/optimizers` derives from local SillyTavern extension `cocktail` version 0.1.17, author **Limerence** (as declared in its manifest).

`features/tomatojuice/client` and `server-plugin/st-toolbox-server/modules/tomatojuice` derive from local `cocktail-plus` version 0.1.24, author **Limerence** (as declared in its manifest).

This integration's display brand is **茄汁 / tomatojuice**. The upstream names above identify the real sources and must not be relabeled as tomatojuice.

Original algorithm comments have been retained (with integration-specific branding and identifiers updated). This migration changes namespace, settings integration, routes, cache safety, save-conflict behavior, explicit installation/update workflow and diagnostics. The generated `runtime.js` is built from the included TypeScript client source using esbuild.

## Intentional legacy names and compatibility identifiers

- `features/tomatojuice/client/settings.ts`: `extensionSettings['cocktail-plus']` is read only to seed the new `st-toolbox.tomatojuice.backend` settings when absent; future writes use the new namespace.
- `features/tomatojuice/index.js`: `__cocktailPlusEarlyBridge`, `/third-party/(cocktail|cocktail-plus)/`, and `/api/plugins/cocktail-plus/` detect old scripts/bridges/service workers. The associated conflict warnings intentionally name the old extensions so users know what to disable.
- Server `early-management.js`: `cocktail-plus`, the old `/api/plugins/cocktail-plus` route and `data-cp-module-proxy-original` HTML marker detect incompatible legacy HTML. Do not rename them: that would bypass the safety check.
- Server early bridge, service worker and module proxy still read `x-cocktail-cache`; the fast handler still emits it alongside the new header for legacy response compatibility. It is not a display brand.
- The `cp` client UI prefix and server `cp-*` DOM/CSS identifiers are shared existing implementation hooks, not a product name. They remain paired to avoid breaking the client panel and early-loading overlay; they are not aliases for new optimizer subpanel APIs.
- Upstream names, versions and author attribution in this notice, the README and migration guide describe provenance or migration/conflict handling, not the current product name. Historical optimizer storage keys (`st-*`) remain unchanged to retain existing user preferences.

New optimizer subpanel exports use `registerTomatojuiceSubpanel`, `listTomatojuiceSubpanels` and `onTomatojuiceSubpanelsChanged`; optimizer DOM/CSS classes use `tomatojuice-*`. The registry debug hook is `__tomatojuiceSubpanels`. No obsolete API alias is needed because all in-project callers were migrated together.

No standalone LICENSE file was present in either supplied local source snapshot. This notice records provenance and does not assert a license grant or relicense those sources under this repository's LICENSE. Confirm upstream redistribution permissions before publishing the combined code publicly.
