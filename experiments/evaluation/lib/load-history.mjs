/**
 * Re-export shim.
 *
 * The loader itself now lives in `packages/ingest-claude/load-history.mjs` so
 * that the production importer and the evaluation probes share exactly one copy
 * of the population definition. Every probe in this directory still imports it
 * from here; this file exists so none of them had to change.
 */
export * from "../../../packages/ingest-claude/load-history.mjs";
