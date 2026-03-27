// Auto-generated from conformance-profiles.json
// Do not edit manually - run: node scripts/generate-json-types.mjs

export interface ConformanceProfilesSchema {
  $schema: string;
  version: string;
  tiers: {
    core: string[];
    standard: string[];
    complete: string[];
  };
}

declare const schema: ConformanceProfilesSchema;
export default schema;
