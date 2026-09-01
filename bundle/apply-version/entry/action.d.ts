/**
 * Bundle entry point for the pull request action.
 *
 * Each action gets a file whose only job is to invoke its run function. The
 * modules themselves stay side-effect free, because ncc collapses every module
 * it bundles into one file with one `import.meta.url` — so a `process.argv[1]
 * === import.meta.url` guard inside a shared module fires in every bundle that
 * transitively imports it, not just its own.
 */
export {};
//# sourceMappingURL=action.d.ts.map