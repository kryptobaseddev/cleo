/* @ts-self-types="./lafs_core.d.ts" */

/**
 * LAFS envelope - the main response type.
 */
export class WasmLafsEnvelope {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmLafsEnvelope.prototype);
        obj.__wbg_ptr = ptr;
        WasmLafsEnvelopeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmLafsEnvelopeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmlafsenvelope_free(ptr, 0);
    }
    /**
     * Create an error envelope.
     *
     * # Arguments
     * * `code` - Error code string
     * * `message` - Error message
     * * `meta` - LAFS metadata
     * @param {string} code
     * @param {string} message
     * @param {WasmLafsMeta} meta
     * @returns {WasmLafsEnvelope}
     */
    static createError(code, message, meta) {
        const ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        _assertClass(meta, WasmLafsMeta);
        var ptr2 = meta.__destroy_into_raw();
        const ret = wasm.wasmlafsenvelope_createError(ptr0, len0, ptr1, len1, ptr2);
        return WasmLafsEnvelope.__wrap(ret);
    }
    /**
     * Create a success envelope.
     *
     * # Arguments
     * * `data` - JSON string of the result data
     * * `meta` - LAFS metadata
     * @param {string} data
     * @param {WasmLafsMeta} meta
     * @returns {WasmLafsEnvelope}
     */
    static createSuccess(data, meta) {
        const ptr0 = passStringToWasm0(data, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(meta, WasmLafsMeta);
        var ptr1 = meta.__destroy_into_raw();
        const ret = wasm.wasmlafsenvelope_createSuccess(ptr0, len0, ptr1);
        return WasmLafsEnvelope.__wrap(ret);
    }
    /**
     * Get the error as a JSON string.
     * @returns {string}
     */
    get error_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmlafsenvelope_error_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the metadata as a JSON string.
     * @returns {string}
     */
    get meta_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmlafsenvelope_meta_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the result as a JSON string.
     * @returns {string}
     */
    get result_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmlafsenvelope_result_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Check if the envelope represents success.
     * @returns {boolean}
     */
    get success() {
        const ret = wasm.wasmlafsenvelope_success(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) WasmLafsEnvelope.prototype[Symbol.dispose] = WasmLafsEnvelope.prototype.free;

/**
 * LAFS metadata for envelope.
 */
export class WasmLafsMeta {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmLafsMetaFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmlafsmeta_free(ptr, 0);
    }
    /**
     * Create new LAFS metadata.
     *
     * # Arguments
     * * `operation` - The operation name (e.g., "tasks.list")
     * * `transport` - Transport type string ("cli", "http", "grpc", "sdk")
     * @param {string} operation
     * @param {string} transport
     */
    constructor(operation, transport) {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(transport, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.wasmlafsmeta_new(ptr0, len0, ptr1, len1);
        this.__wbg_ptr = ret >>> 0;
        WasmLafsMetaFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get the operation name.
     * @returns {string}
     */
    get operation() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmlafsmeta_operation(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the schema version.
     * @returns {string}
     */
    get schema_version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmlafsmeta_schema_version(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the LAFS spec version.
     * @returns {string}
     */
    get spec_version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmlafsmeta_spec_version(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the transport type as a string.
     * @returns {string}
     */
    get transport() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmlafsmeta_transport(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) WasmLafsMeta.prototype[Symbol.dispose] = WasmLafsMeta.prototype.free;

/**
 * The transport mechanism used to deliver a LAFS envelope.
 */
export class WasmLafsTransport {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmLafsTransport.prototype);
        obj.__wbg_ptr = ptr;
        WasmLafsTransportFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmLafsTransportFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmlafstransport_free(ptr, 0);
    }
    /**
     * Create a CLI transport variant.
     * @returns {WasmLafsTransport}
     */
    static Cli() {
        const ret = wasm.wasmlafstransport_Cli();
        return WasmLafsTransport.__wrap(ret);
    }
    /**
     * Create a gRPC transport variant.
     * @returns {WasmLafsTransport}
     */
    static Grpc() {
        const ret = wasm.wasmlafstransport_Grpc();
        return WasmLafsTransport.__wrap(ret);
    }
    /**
     * Create an HTTP transport variant.
     * @returns {WasmLafsTransport}
     */
    static Http() {
        const ret = wasm.wasmlafstransport_Http();
        return WasmLafsTransport.__wrap(ret);
    }
    /**
     * Create an SDK transport variant.
     * @returns {WasmLafsTransport}
     */
    static Sdk() {
        const ret = wasm.wasmlafstransport_Sdk();
        return WasmLafsTransport.__wrap(ret);
    }
    /**
     * Get the transport as a string.
     * @returns {string}
     */
    get as_string() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmlafstransport_as_string(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) WasmLafsTransport.prototype[Symbol.dispose] = WasmLafsTransport.prototype.free;

/**
 * Helper function to create a transport enum.
 *
 * # Arguments
 * * `transport` - Transport type string ("cli", "http", "grpc", "sdk")
 * @param {string} transport
 * @returns {WasmLafsTransport}
 */
export function create_transport(transport) {
    const ptr0 = passStringToWasm0(transport, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.create_transport(ptr0, len0);
    return WasmLafsTransport.__wrap(ret);
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_getRandomValues_a1cf2e70b003a59d: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getTime_1dad7b5386ddd2d9: function(arg0) {
            const ret = arg0.getTime();
            return ret;
        },
        __wbg_new_0_1dcafdf5e786e876: function() {
            const ret = new Date();
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./lafs_core_bg.js": import0,
    };
}

const WasmLafsEnvelopeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmlafsenvelope_free(ptr >>> 0, 1));
const WasmLafsMetaFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmlafsmeta_free(ptr >>> 0, 1));
const WasmLafsTransportFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmlafstransport_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('lafs_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
