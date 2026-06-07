// Check if Object.fromEntries result is assignable to Partial<Record<SpawnAgentCli, boolean>>

// According to TypeScript:
// Partial<Record<SpawnAgentCli, boolean>> expands to:
// { claude?: boolean; codex?: boolean; opencode?: boolean }

// Object.fromEntries returns: { [k: string]: any }
// In the context of:
// const results: Array<[SpawnAgentCli, boolean]> = [['claude', true], ...]
// Object.fromEntries(results) is typed as: { [k: string]: boolean }

// The question: is { [k: string]: boolean } assignable to 
// { claude?: boolean; codex?: boolean; opencode?: boolean }?

// Answer: YES, because:
// 1. { [k: string]: boolean } is an index signature that matches ANY string key
// 2. { claude?: boolean; codex?: boolean; opencode?: boolean } only uses specific keys
// 3. Any value with an index signature { [k: string]: T } satisfies a type with specific optional properties

console.log("Type check analysis:");
console.log("Object.fromEntries(results) type: { [k: string]: boolean }");
console.log("setCliAvailability expects: Partial<Record<SpawnAgentCli, boolean>>");
console.log("Which expands to: { claude?: boolean; codex?: boolean; opencode?: boolean }");
console.log("");
console.log("TypeScript assignability: YES - index signature types are assignable to property-specific types");
