/* tslint:disable */
/* eslint-disable */

/**
 * JavaScript-facing result of CANT parsing
 */
export class CantParseResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly addresses: string[];
    readonly body: string;
    readonly directive: string | undefined;
    readonly directive_type: string;
    readonly header_raw: string;
    readonly tags: string[];
    readonly task_refs: string[];
}

/**
 * Classify a directive verb
 */
export function cant_classify_directive(verb: string): string;

/**
 * Parse a CANT message from JavaScript
 */
export function cant_parse(content: string): CantParseResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_cantparseresult_free: (a: number, b: number) => void;
    readonly cantparseresult_directive: (a: number) => [number, number];
    readonly cantparseresult_directive_type: (a: number) => [number, number];
    readonly cantparseresult_addresses: (a: number) => [number, number];
    readonly cantparseresult_task_refs: (a: number) => [number, number];
    readonly cantparseresult_tags: (a: number) => [number, number];
    readonly cantparseresult_header_raw: (a: number) => [number, number];
    readonly cantparseresult_body: (a: number) => [number, number];
    readonly cant_parse: (a: number, b: number) => number;
    readonly cant_classify_directive: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
