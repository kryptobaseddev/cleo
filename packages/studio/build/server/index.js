import { c as coalesce_to_error, g as get_status, a as get_message, t as text_decoder, p as parse, _ as __commonJSMin, o as options, s as set_private_env, b as set_public_env, d as get_hooks, n as noop, h as has_resolution_suffix, e as has_data_suffix, f as base, i as strip_resolution_suffix, j as strip_data_suffix, T as TRAILING_SLASH_PARAM, I as INVALIDATED_PARAM, k as decode_pathname, l as add_data_suffix, m as add_resolution_suffix, q as find_route, r as normalize_path, u as disable_search, v as public_env, w as validate_layout_server_exports, x as validate_layout_exports, y as validate_page_server_exports, z as validate_page_exports, A as noop_span, B as app_dir, C as create_remote_key, D as assets, E as hash, F as text_encoder, G as compact, H as once, J as normalize_error, K as resolve, L as parse_remote_arg, M as stringify, N as make_trackable, O as stringify$1, P as read_implementation, Q as split_remote_key, R as get_relative_path, S as base64_encode, U as override, V as reset, W as set_read_implementation } from './chunks/internal-CwKA1UI_.js';
import 'node:module';
import { json, text, error, isRedirect } from '@sveltejs/kit';
import { HttpError, SvelteKitError, Redirect, ActionFailure } from '@sveltejs/kit/internal';
import { with_request_store, merge_tracing } from '@sveltejs/kit/internal/server';
import { u as uneval, w as writable, r as readable } from './chunks/dev-BGytRnSO.js';

var ENDPOINT_METHODS = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
	"HEAD"
];
var PAGE_METHODS = [
	"GET",
	"POST",
	"HEAD"
];
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/form-utils.js
/** @import { RemoteForm } from '@sveltejs/kit' */
/** @import { BinaryFormMeta, InternalRemoteFormIssue } from 'types' */
/** @import { StandardSchemaV1 } from '@standard-schema/spec' */
/**
* Sets a value in a nested object using a path string, mutating the original object
* @param {Record<string, any>} object
* @param {string} path_string
* @param {any} value
*/
function set_nested_value(object, path_string, value) {
	if (path_string.startsWith("n:")) {
		path_string = path_string.slice(2);
		value = value === "" ? void 0 : parseFloat(value);
	} else if (path_string.startsWith("b:")) {
		path_string = path_string.slice(2);
		value = value === "on";
	}
	deep_set(object, split_path(path_string), value);
}
/**
* Convert `FormData` into a POJO
* @param {FormData} data
*/
function convert_formdata(data) {
	/** @type {Record<string, any>} */
	const result = {};
	for (let key of data.keys()) {
		const is_array = key.endsWith("[]");
		/** @type {any[]} */
		let values = data.getAll(key);
		if (is_array) key = key.slice(0, -2);
		if (values.length > 1 && !is_array) throw new Error(`Form cannot contain duplicated keys — "${key}" has ${values.length} values`);
		values = values.filter((entry) => typeof entry === "string" || entry.name !== "" || entry.size > 0);
		if (key.startsWith("n:")) {
			key = key.slice(2);
			values = values.map((v) => v === "" ? void 0 : parseFloat(v));
		} else if (key.startsWith("b:")) {
			key = key.slice(2);
			values = values.map((v) => v === "on");
		}
		set_nested_value(result, key, is_array ? values : values[0]);
	}
	return result;
}
var BINARY_FORM_CONTENT_TYPE = "application/x-sveltekit-formdata";
var BINARY_FORM_VERSION = 0;
var HEADER_BYTES = 7;
/**
* @param {Request} request
* @returns {Promise<{ data: Record<string, any>; meta: BinaryFormMeta; form_data: FormData | null }>}
*/
async function deserialize_binary_form(request) {
	if (request.headers.get("content-type") !== "application/x-sveltekit-formdata") {
		const form_data = await request.formData();
		return {
			data: convert_formdata(form_data),
			meta: {},
			form_data
		};
	}
	if (!request.body) throw deserialize_error("no body");
	const content_length = parseInt(request.headers.get("content-length") ?? "");
	if (Number.isNaN(content_length)) throw deserialize_error("invalid Content-Length header");
	const reader = request.body.getReader();
	/** @type {Array<Promise<Uint8Array<ArrayBuffer> | undefined>>} */
	const chunks = [];
	/**
	* @param {number} index
	* @returns {Promise<Uint8Array<ArrayBuffer> | undefined>}
	*/
	function get_chunk(index) {
		if (index in chunks) return chunks[index];
		let i = chunks.length;
		while (i <= index) {
			chunks[i] = reader.read().then((chunk) => chunk.value);
			i++;
		}
		return chunks[index];
	}
	/**
	* @param {number} offset
	* @param {number} length
	* @returns {Promise<Uint8Array | null>}
	*/
	async function get_buffer(offset, length) {
		/** @type {Uint8Array} */
		let start_chunk;
		let chunk_start = 0;
		/** @type {number} */
		let chunk_index;
		for (chunk_index = 0;; chunk_index++) {
			const chunk = await get_chunk(chunk_index);
			if (!chunk) return null;
			const chunk_end = chunk_start + chunk.byteLength;
			if (offset >= chunk_start && offset < chunk_end) {
				start_chunk = chunk;
				break;
			}
			chunk_start = chunk_end;
		}
		if (offset + length <= chunk_start + start_chunk.byteLength) return start_chunk.subarray(offset - chunk_start, offset + length - chunk_start);
		const chunks = [start_chunk.subarray(offset - chunk_start)];
		let cursor = start_chunk.byteLength - offset + chunk_start;
		while (cursor < length) {
			chunk_index++;
			let chunk = await get_chunk(chunk_index);
			if (!chunk) return null;
			if (chunk.byteLength > length - cursor) chunk = chunk.subarray(0, length - cursor);
			chunks.push(chunk);
			cursor += chunk.byteLength;
		}
		const buffer = new Uint8Array(length);
		cursor = 0;
		for (const chunk of chunks) {
			buffer.set(chunk, cursor);
			cursor += chunk.byteLength;
		}
		return buffer;
	}
	const header = await get_buffer(0, HEADER_BYTES);
	if (!header) throw deserialize_error("too short");
	if (header[0] !== BINARY_FORM_VERSION) throw deserialize_error(`got version ${header[0]}, expected version ${BINARY_FORM_VERSION}`);
	const header_view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const data_length = header_view.getUint32(1, true);
	if (HEADER_BYTES + data_length > content_length) throw deserialize_error("data overflow");
	const file_offsets_length = header_view.getUint16(5, true);
	if (HEADER_BYTES + data_length + file_offsets_length > content_length) throw deserialize_error("file offset table overflow");
	const data_buffer = await get_buffer(HEADER_BYTES, data_length);
	if (!data_buffer) throw deserialize_error("data too short");
	/** @type {Array<number | undefined>} */
	let file_offsets;
	/** @type {number} */
	let files_start_offset;
	if (file_offsets_length > 0) {
		const file_offsets_buffer = await get_buffer(HEADER_BYTES + data_length, file_offsets_length);
		if (!file_offsets_buffer) throw deserialize_error("file offset table too short");
		const parsed_offsets = JSON.parse(text_decoder.decode(file_offsets_buffer));
		if (!Array.isArray(parsed_offsets) || parsed_offsets.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0)) throw deserialize_error("invalid file offset table");
		file_offsets = parsed_offsets;
		files_start_offset = HEADER_BYTES + data_length + file_offsets_length;
	}
	/** @type {Array<{ offset: number, size: number }>} */
	const file_spans = [];
	const [data, meta] = parse(text_decoder.decode(data_buffer), { File: ([name, type, size, last_modified, index]) => {
		if (typeof name !== "string" || typeof type !== "string" || typeof size !== "number" || typeof last_modified !== "number" || typeof index !== "number") throw deserialize_error("invalid file metadata");
		let offset = file_offsets[index];
		if (offset === void 0) throw deserialize_error("duplicate file offset table index");
		file_offsets[index] = void 0;
		offset += files_start_offset;
		if (offset + size > content_length) throw deserialize_error("file data overflow");
		file_spans.push({
			offset,
			size
		});
		return new Proxy(new LazyFile(name, type, size, last_modified, get_chunk, offset), { getPrototypeOf() {
			return File.prototype;
		} });
	} });
	file_spans.sort((a, b) => a.offset - b.offset || a.size - b.size);
	for (let i = 1; i < file_spans.length; i++) {
		const previous = file_spans[i - 1];
		const current = file_spans[i];
		const previous_end = previous.offset + previous.size;
		if (previous_end < current.offset) throw deserialize_error("gaps in file data");
		if (previous_end > current.offset) throw deserialize_error("overlapping file data");
	}
	(async () => {
		let has_more = true;
		while (has_more) has_more = !!await get_chunk(chunks.length);
	})();
	return {
		data,
		meta,
		form_data: null
	};
}
/**
* @param {string} message
*/
function deserialize_error(message) {
	return new SvelteKitError(400, "Bad Request", `Could not deserialize binary form: ${message}`);
}
/** @implements {File} */
var LazyFile = class LazyFile {
	/** @type {(index: number) => Promise<Uint8Array<ArrayBuffer> | undefined>} */
	#get_chunk;
	/** @type {number} */
	#offset;
	/**
	* @param {string} name
	* @param {string} type
	* @param {number} size
	* @param {number} last_modified
	* @param {(index: number) => Promise<Uint8Array<ArrayBuffer> | undefined>} get_chunk
	* @param {number} offset
	*/
	constructor(name, type, size, last_modified, get_chunk, offset) {
		this.name = name;
		this.type = type;
		this.size = size;
		this.lastModified = last_modified;
		this.webkitRelativePath = "";
		this.#get_chunk = get_chunk;
		this.#offset = offset;
		this.arrayBuffer = this.arrayBuffer.bind(this);
		this.bytes = this.bytes.bind(this);
		this.slice = this.slice.bind(this);
		this.stream = this.stream.bind(this);
		this.text = this.text.bind(this);
	}
	/** @type {ArrayBuffer | undefined} */
	#buffer;
	async arrayBuffer() {
		this.#buffer ??= await new Response(this.stream()).arrayBuffer();
		return this.#buffer;
	}
	async bytes() {
		return new Uint8Array(await this.arrayBuffer());
	}
	/**
	* @param {number=} start
	* @param {number=} end
	* @param {string=} contentType
	*/
	slice(start = 0, end = this.size, contentType = this.type) {
		if (start < 0) start = Math.max(this.size + start, 0);
		else start = Math.min(start, this.size);
		if (end < 0) end = Math.max(this.size + end, 0);
		else end = Math.min(end, this.size);
		const size = Math.max(end - start, 0);
		return new LazyFile(this.name, contentType, size, this.lastModified, this.#get_chunk, this.#offset + start);
	}
	stream() {
		let cursor = 0;
		let chunk_index = 0;
		return new ReadableStream({
			start: async (controller) => {
				let chunk_start = 0;
				/** @type {Uint8Array} */
				let start_chunk;
				for (chunk_index = 0;; chunk_index++) {
					const chunk = await this.#get_chunk(chunk_index);
					if (!chunk) return null;
					const chunk_end = chunk_start + chunk.byteLength;
					if (this.#offset >= chunk_start && this.#offset < chunk_end) {
						start_chunk = chunk;
						break;
					}
					chunk_start = chunk_end;
				}
				if (this.#offset + this.size <= chunk_start + start_chunk.byteLength) {
					controller.enqueue(start_chunk.subarray(this.#offset - chunk_start, this.#offset + this.size - chunk_start));
					controller.close();
				} else {
					controller.enqueue(start_chunk.subarray(this.#offset - chunk_start));
					cursor = start_chunk.byteLength - this.#offset + chunk_start;
				}
			},
			pull: async (controller) => {
				chunk_index++;
				let chunk = await this.#get_chunk(chunk_index);
				if (!chunk) {
					controller.error("incomplete file data");
					controller.close();
					return;
				}
				if (chunk.byteLength > this.size - cursor) chunk = chunk.subarray(0, this.size - cursor);
				controller.enqueue(chunk);
				cursor += chunk.byteLength;
				if (cursor >= this.size) controller.close();
			}
		});
	}
	async text() {
		return text_decoder.decode(await this.arrayBuffer());
	}
};
var path_regex = /^[a-zA-Z_$]\w*(\.[a-zA-Z_$]\w*|\[\d+\])*$/;
/**
* @param {string} path
*/
function split_path(path) {
	if (!path_regex.test(path)) throw new Error(`Invalid path ${path}`);
	return path.split(/\.|\[|\]/).filter(Boolean);
}
/**
* Check if a property key is dangerous and could lead to prototype pollution
* @param {string} key
*/
function check_prototype_pollution(key) {
	if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`Invalid key "${key}"`);
}
/**
* Sets a value in a nested object using an array of keys, mutating the original object.
* @param {Record<string, any>} object
* @param {string[]} keys
* @param {any} value
*/
function deep_set(object, keys, value) {
	let current = object;
	for (let i = 0; i < keys.length - 1; i += 1) {
		const key = keys[i];
		check_prototype_pollution(key);
		const is_array = /^\d+$/.test(keys[i + 1]);
		const exists = Object.hasOwn(current, key);
		const inner = current[key];
		if (exists && is_array !== Array.isArray(inner)) throw new Error(`Invalid array key ${keys[i + 1]}`);
		if (!exists) current[key] = is_array ? [] : {};
		current = current[key];
	}
	const final_key = keys[keys.length - 1];
	check_prototype_pollution(final_key);
	current[final_key] = value;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/utils/http.js
/**
* Given an Accept header and a list of possible content types, pick
* the most suitable one to respond with
* @param {string} accept
* @param {string[]} types
*/
function negotiate(accept, types) {
	/** @type {Array<{ type: string, subtype: string, q: number, i: number }>} */
	const parts = [];
	accept.split(",").forEach((str, i) => {
		const match = /([^/ \t]+)\/([^; \t]+)[ \t]*(?:;[ \t]*q=([0-9.]+))?/.exec(str);
		if (match) {
			const [, type, subtype, q = "1"] = match;
			parts.push({
				type,
				subtype,
				q: +q,
				i
			});
		}
	});
	parts.sort((a, b) => {
		if (a.q !== b.q) return b.q - a.q;
		if (a.subtype === "*" !== (b.subtype === "*")) return a.subtype === "*" ? 1 : -1;
		if (a.type === "*" !== (b.type === "*")) return a.type === "*" ? 1 : -1;
		return a.i - b.i;
	});
	let accepted;
	let min_priority = Infinity;
	for (const mimetype of types) {
		const [type, subtype] = mimetype.split("/");
		const priority = parts.findIndex((part) => (part.type === type || part.type === "*") && (part.subtype === subtype || part.subtype === "*"));
		if (priority !== -1 && priority < min_priority) {
			accepted = mimetype;
			min_priority = priority;
		}
	}
	return accepted;
}
/**
* Returns `true` if the request contains a `content-type` header with the given type
* @param {Request} request
* @param  {...string} types
*/
function is_content_type(request, ...types) {
	const type = request.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
	return types.includes(type.toLowerCase());
}
/**
* @param {Request} request
*/
function is_form_content_type(request) {
	return is_content_type(request, "application/x-www-form-urlencoded", "multipart/form-data", "text/plain", BINARY_FORM_CONTENT_TYPE);
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/utils/misc.js
var s = JSON.stringify;
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/utils/escape.js
/**
* When inside a double-quoted attribute value, only `&` and `"` hold special meaning.
* @see https://html.spec.whatwg.org/multipage/parsing.html#attribute-value-(double-quoted)-state
* @type {Record<string, string>}
*/
var escape_html_attr_dict = {
	"&": "&amp;",
	"\"": "&quot;"
};
/**
* @type {Record<string, string>}
*/
var escape_html_dict = {
	"&": "&amp;",
	"<": "&lt;"
};
var escape_html_attr_regex = new RegExp(`[${Object.keys(escape_html_attr_dict).join("")}]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|[\\ud800-\\udbff][\\udc00-\\udfff]|[\\udc00-\\udfff]`, "g");
var escape_html_regex = new RegExp(`[${Object.keys(escape_html_dict).join("")}]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|[\\ud800-\\udbff][\\udc00-\\udfff]|[\\udc00-\\udfff]`, "g");
/**
* Escapes unpaired surrogates (which are allowed in js strings but invalid in HTML) and
* escapes characters that are special.
*
* @param {string} str
* @param {boolean} [is_attr]
* @returns {string} escaped string
* @example const html = `<tag data-value="${escape_html('value', true)}">...</tag>`;
*/
function escape_html(str, is_attr) {
	const dict = is_attr ? escape_html_attr_dict : escape_html_dict;
	return str.replace(is_attr ? escape_html_attr_regex : escape_html_regex, (match) => {
		if (match.length === 2) return match;
		return dict[match] ?? `&#${match.charCodeAt(0)};`;
	});
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/utils.js
/**
* @param {Partial<Record<import('types').HttpMethod, any>>} mod
* @param {import('types').HttpMethod} method
*/
function method_not_allowed(mod, method) {
	return text(`${method} method not allowed`, {
		status: 405,
		headers: { allow: allowed_methods(mod).join(", ") }
	});
}
/** @param {Partial<Record<import('types').HttpMethod, any>>} mod */
function allowed_methods(mod) {
	const allowed = ENDPOINT_METHODS.filter((method) => method in mod);
	if ("GET" in mod && !("HEAD" in mod)) allowed.push("HEAD");
	return allowed;
}
/**
* @param {import('types').SSROptions} options
*/
function get_global_name(options) {
	return `__sveltekit_${options.version_hash}`;
}
/**
* Return as a response that renders the error.html
*
* @param {import('types').SSROptions} options
* @param {number} status
* @param {string} message
*/
function static_error_page(options, status, message) {
	return text(options.templates.error({
		status,
		message: escape_html(message)
	}), {
		headers: { "content-type": "text/html; charset=utf-8" },
		status
	});
}
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} state
* @param {import('types').SSROptions} options
* @param {unknown} error
*/
async function handle_fatal_error(event, state, options, error) {
	error = error instanceof HttpError ? error : coalesce_to_error(error);
	const status = get_status(error);
	const body = await handle_error_and_jsonify(event, state, options, error);
	const type = negotiate(event.request.headers.get("accept") || "text/html", ["application/json", "text/html"]);
	if (event.isDataRequest || type === "application/json") return json(body, { status });
	return static_error_page(options, status, body.message);
}
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} state
* @param {import('types').SSROptions} options
* @param {any} error
* @returns {Promise<App.Error>}
*/
async function handle_error_and_jsonify(event, state, options, error) {
	if (error instanceof HttpError) return {
		message: "Unknown Error",
		...error.body
	};
	const status = get_status(error);
	const message = get_message(error);
	return await with_request_store({
		event,
		state
	}, () => options.hooks.handleError({
		error,
		event,
		status,
		message
	})) ?? { message };
}
/**
* @param {number} status
* @param {string} location
*/
function redirect_response(status, location) {
	return new Response(void 0, {
		status,
		headers: { location }
	});
}
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {Error & { path: string }} error
*/
function clarify_devalue_error(event, error) {
	if (error.path) return `Data returned from \`load\` while rendering ${event.route.id} is not serializable: ${error.message} (${error.path}). If you need to serialize/deserialize custom types, use transport hooks: https://svelte.dev/docs/kit/hooks#Universal-hooks-transport.`;
	if (error.path === "") return `Data returned from \`load\` while rendering ${event.route.id} is not a plain object`;
	return error.message;
}
/**
* @param {import('types').ServerDataNode} node
*/
function serialize_uses(node) {
	const uses = {};
	if (node.uses && node.uses.dependencies.size > 0) uses.dependencies = Array.from(node.uses.dependencies);
	if (node.uses && node.uses.search_params.size > 0) uses.search_params = Array.from(node.uses.search_params);
	if (node.uses && node.uses.params.size > 0) uses.params = Array.from(node.uses.params);
	if (node.uses?.parent) uses.parent = 1;
	if (node.uses?.route) uses.route = 1;
	if (node.uses?.url) uses.url = 1;
	return uses;
}
/**
* Returns `true` if the given path was prerendered
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @param {string} pathname Should include the base and be decoded
*/
function has_prerendered_path(manifest, pathname) {
	return manifest._.prerendered_routes.has(pathname) || pathname.at(-1) === "/" && manifest._.prerendered_routes.has(pathname.slice(0, -1));
}
/**
* Formats the error into a nice message with sanitized stack trace
* @param {number} status
* @param {Error} error
* @param {import('@sveltejs/kit').RequestEvent} event
*/
function format_server_error(status, error, event) {
	const formatted_text = `\n\x1b[1;31m[${status}] ${event.request.method} ${event.url.pathname}\x1b[0m`;
	if (status === 404) return formatted_text;
	return `${formatted_text}\n${error.stack}`;
}
/**
* Returns the filename without the extension. e.g., `+page.server`, `+page`, etc.
* @param {string | undefined} node_id
* @returns {string}
*/
function get_node_type(node_id) {
	const filename = (node_id?.split("/"))?.at(-1);
	if (!filename) return "unknown";
	return filename.split(".").slice(0, -1).join(".");
}

//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/utils/promise.js
/** @see https://github.com/microsoft/TypeScript/blob/904e7dd97dc8da1352c8e05d70829dff17c73214/src/lib/es2024.promise.d.ts */
/**
* @template T
* @typedef {{
*   promise: Promise<T>;
*   resolve: (value: T | PromiseLike<T>) => void;
*   reject: (reason?: any) => void;
* }} PromiseWithResolvers<T>
*/
/**
* TODO: Whenever Node >21 is minimum supported version, we can use `Promise.withResolvers` to avoid this ceremony
*
* @template T
* @returns {PromiseWithResolvers<T>}
*/
function with_resolvers() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/constants.js
var NULL_BODY_STATUS = [
	101,
	103,
	204,
	205,
	304
];
var IN_WEBCONTAINER = !!globalThis.process?.versions?.webcontainer;
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/endpoint.js
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} event_state
* @param {import('types').SSREndpoint} mod
* @param {import('types').SSRState} state
* @returns {Promise<Response>}
*/
async function render_endpoint(event, event_state, mod, state) {
	const method = event.request.method;
	let handler = mod[method] || mod.fallback;
	if (method === "HEAD" && !mod.HEAD && mod.GET) handler = mod.GET;
	if (!handler) return method_not_allowed(mod, method);
	const prerender = mod.prerender ?? state.prerender_default;
	if (prerender && (mod.POST || mod.PATCH || mod.PUT || mod.DELETE)) throw new Error("Cannot prerender endpoints that have mutative methods");
	if (state.prerendering && !state.prerendering.inside_reroute && !prerender) if (state.depth > 0) throw new Error(`${event.route.id} is not prerenderable`);
	else return new Response(void 0, { status: 204 });
	try {
		const response = await with_request_store({
			event,
			state: event_state
		}, () => handler(event));
		if (!(response instanceof Response)) throw new Error(`Invalid response from route ${event.url.pathname}: handler should return a Response object`);
		if (state.prerendering && (!state.prerendering.inside_reroute || prerender)) {
			const cloned = new Response(response.clone().body, {
				status: response.status,
				statusText: response.statusText,
				headers: new Headers(response.headers)
			});
			cloned.headers.set("x-sveltekit-prerender", String(prerender));
			if (state.prerendering.inside_reroute && prerender) {
				cloned.headers.set("x-sveltekit-routeid", encodeURI(event.route.id));
				state.prerendering.dependencies.set(event.url.pathname, {
					response: cloned,
					body: null
				});
			} else return cloned;
		}
		return response;
	} catch (e) {
		if (e instanceof Redirect) return new Response(void 0, {
			status: e.status,
			headers: { location: e.location }
		});
		throw e;
	}
}
/**
* @param {import('@sveltejs/kit').RequestEvent} event
*/
function is_endpoint_request(event) {
	const { method, headers } = event.request;
	if (ENDPOINT_METHODS.includes(method) && !PAGE_METHODS.includes(method)) return true;
	if (method === "POST" && headers.get("x-sveltekit-action") === "true") return false;
	return negotiate(event.request.headers.get("accept") ?? "*/*", ["*", "text/html"]) !== "text/html";
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/telemetry/record_span.js
/** @import { RecordSpan } from 'types' */
/** @type {RecordSpan} */
async function record_span({ name, attributes, fn }) {
	return fn(noop_span);
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/actions.js
/** @import { RequestEvent, ActionResult, Actions } from '@sveltejs/kit' */
/** @import { SSROptions, SSRNode, ServerNode, ServerHooks } from 'types' */
/** @param {RequestEvent} event */
function is_action_json_request(event) {
	return negotiate(event.request.headers.get("accept") ?? "*/*", ["application/json", "text/html"]) === "application/json" && event.request.method === "POST";
}
/**
* @param {RequestEvent} event
* @param {import('types').RequestState} event_state
* @param {SSROptions} options
* @param {SSRNode['server'] | undefined} server
*/
async function handle_action_json_request(event, event_state, options, server) {
	const actions = server?.actions;
	if (!actions) {
		const no_actions_error = new SvelteKitError(405, "Method Not Allowed", `POST method not allowed. No form actions exist for this page`);
		return action_json({
			type: "error",
			error: await handle_error_and_jsonify(event, event_state, options, no_actions_error)
		}, {
			status: no_actions_error.status,
			headers: { allow: "GET" }
		});
	}
	check_named_default_separate(actions);
	try {
		const data = await call_action(event, event_state, actions);
		if (data instanceof ActionFailure) return action_json({
			type: "failure",
			status: data.status,
			data: stringify_action_response(data.data, event.route.id, options.hooks.transport)
		});
		else return action_json({
			type: "success",
			status: data ? 200 : 204,
			data: stringify_action_response(data, event.route.id, options.hooks.transport)
		});
	} catch (e) {
		const err = normalize_error(e);
		if (err instanceof Redirect) return action_json_redirect(err);
		return action_json({
			type: "error",
			error: await handle_error_and_jsonify(event, event_state, options, check_incorrect_fail_use(err))
		}, { status: get_status(err) });
	}
}
/**
* @param {HttpError | Error} error
*/
function check_incorrect_fail_use(error) {
	return error instanceof ActionFailure ? /* @__PURE__ */ new Error("Cannot \"throw fail()\". Use \"return fail()\"") : error;
}
/**
* @param {Redirect} redirect
*/
function action_json_redirect(redirect) {
	return action_json({
		type: "redirect",
		status: redirect.status,
		location: redirect.location
	});
}
/**
* @param {ActionResult} data
* @param {ResponseInit} [init]
*/
function action_json(data, init) {
	return json(data, init);
}
/**
* @param {RequestEvent} event
*/
function is_action_request(event) {
	return event.request.method === "POST";
}
/**
* @param {RequestEvent} event
* @param {import('types').RequestState} event_state
* @param {SSRNode['server'] | undefined} server
* @returns {Promise<ActionResult>}
*/
async function handle_action_request(event, event_state, server) {
	const actions = server?.actions;
	if (!actions) {
		event.setHeaders({ allow: "GET" });
		return {
			type: "error",
			error: new SvelteKitError(405, "Method Not Allowed", `POST method not allowed. No form actions exist for this page`)
		};
	}
	check_named_default_separate(actions);
	try {
		const data = await call_action(event, event_state, actions);
		if (data instanceof ActionFailure) return {
			type: "failure",
			status: data.status,
			data: data.data
		};
		else return {
			type: "success",
			status: 200,
			data
		};
	} catch (e) {
		const err = normalize_error(e);
		if (err instanceof Redirect) return {
			type: "redirect",
			status: err.status,
			location: err.location
		};
		return {
			type: "error",
			error: check_incorrect_fail_use(err)
		};
	}
}
/**
* @param {Actions} actions
*/
function check_named_default_separate(actions) {
	if (actions.default && Object.keys(actions).length > 1) throw new Error("When using named actions, the default action cannot be used. See the docs for more info: https://svelte.dev/docs/kit/form-actions#named-actions");
}
/**
* @param {RequestEvent} event
* @param {import('types').RequestState} event_state
* @param {NonNullable<ServerNode['actions']>} actions
* @throws {Redirect | HttpError | SvelteKitError | Error}
*/
async function call_action(event, event_state, actions) {
	const url = new URL(event.request.url);
	let name = "default";
	for (const param of url.searchParams) if (param[0].startsWith("/")) {
		name = param[0].slice(1);
		if (name === "default") throw new Error("Cannot use reserved action name \"default\"");
		break;
	}
	const action = actions[name];
	if (!action) throw new SvelteKitError(404, "Not Found", `No action with name '${name}' found`);
	if (!is_form_content_type(event.request)) throw new SvelteKitError(415, "Unsupported Media Type", `Form actions expect form-encoded data — received ${event.request.headers.get("content-type")}`);
	return record_span({
		name: "sveltekit.form_action",
		attributes: {
			"http.route": event.route.id || "unknown"
		},
		fn: async (current) => {
			const traced_event = merge_tracing(event, current);
			const result = await with_request_store({
				event: traced_event,
				state: event_state
			}, () => action(traced_event));
			if (result instanceof ActionFailure) current.setAttributes({
				"sveltekit.form_action.result.type": "failure",
				"sveltekit.form_action.result.status": result.status
			});
			return result;
		}
	});
}
/**
* Try to `devalue.uneval` the data object, and if it fails, return a proper Error with context
* @param {any} data
* @param {string} route_id
* @param {ServerHooks['transport']} transport
*/
function uneval_action_response(data, route_id, transport) {
	const replacer = (thing) => {
		for (const key in transport) {
			const encoded = transport[key].encode(thing);
			if (encoded) return `app.decode('${key}', ${uneval(encoded, replacer)})`;
		}
	};
	return try_serialize(data, (value) => uneval(value, replacer), route_id);
}
/**
* Try to `devalue.stringify` the data object, and if it fails, return a proper Error with context
* @param {any} data
* @param {string} route_id
* @param {ServerHooks['transport']} transport
*/
function stringify_action_response(data, route_id, transport) {
	const encoders = Object.fromEntries(Object.entries(transport).map(([key, value]) => [key, value.encode]));
	return try_serialize(data, (value) => stringify$1(value, encoders), route_id);
}
/**
* @param {any} data
* @param {(data: any) => string} fn
* @param {string} route_id
*/
function try_serialize(data, fn, route_id) {
	try {
		return fn(data);
	} catch (e) {
		const error = e;
		if (data instanceof Response) throw new Error(`Data returned from action inside ${route_id} is not serializable. Form actions need to return plain objects or fail(). E.g. return { success: true } or return fail(400, { message: "invalid" });`, { cause: e });
		if ("path" in error) {
			let message = `Data returned from action inside ${route_id} is not serializable: ${error.message}`;
			if (error.path !== "") message += ` (data.${error.path})`;
			throw new Error(message, { cause: e });
		}
		throw error;
	}
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/utils/streaming.js
/**
* Create an async iterator and a function to push values into it
* @template T
* @returns {{
*   iterate: (transform?: (input: T) => T) => AsyncIterable<T>;
*   add: (promise: Promise<T>) => void;
* }}
*/
function create_async_iterator() {
	let resolved = -1;
	let returned = -1;
	/** @type {import('./promise.js').PromiseWithResolvers<T>[]} */
	const deferred = [];
	return {
		iterate: (transform = (x) => x) => {
			return { [Symbol.asyncIterator]() {
				return { next: async () => {
					const next = deferred[++returned];
					if (!next) return {
						value: null,
						done: true
					};
					return {
						value: transform(await next.promise),
						done: false
					};
				} };
			} };
		},
		add: (promise) => {
			deferred.push(with_resolvers());
			promise.then((value) => {
				deferred[++resolved].resolve(value);
			});
		}
	};
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/data_serializer.js
/**
* If the serialized data contains promises, `chunks` will be an
* async iterable containing their resolutions
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} event_state
* @param {import('types').SSROptions} options
* @returns {import('./types.js').ServerDataSerializer}
*/
function server_data_serializer(event, event_state, options) {
	let promise_id = 1;
	let max_nodes = -1;
	const iterator = create_async_iterator();
	const global = get_global_name(options);
	/** @param {number} index */
	function get_replacer(index) {
		/** @param {any} thing */
		return function replacer(thing) {
			if (typeof thing?.then === "function") {
				const id = promise_id++;
				const promise = thing.then(
					/** @param {any} data */
					(data) => ({ data })
				).catch(
					/** @param {any} error */
					async (error) => ({ error: await handle_error_and_jsonify(event, event_state, options, error) })
				).then(
					/**
					* @param {{data: any; error: any}} result
					*/
					async ({ data, error }) => {
						let str;
						try {
							str = uneval(error ? [, error] : [data], replacer);
						} catch {
							error = await handle_error_and_jsonify(event, event_state, options, /* @__PURE__ */ new Error(`Failed to serialize promise while rendering ${event.route.id}`));
							str = uneval([, error], replacer);
						}
						return {
							index,
							str: `${global}.resolve(${id}, ${str.includes("app.decode") ? `(app) => ${str}` : `() => ${str}`})`
						};
					}
				);
				iterator.add(promise);
				return `${global}.defer(${id})`;
			} else for (const key in options.hooks.transport) {
				const encoded = options.hooks.transport[key].encode(thing);
				if (encoded) return `app.decode('${key}', ${uneval(encoded, replacer)})`;
			}
		};
	}
	const strings = [];
	return {
		set_max_nodes(i) {
			max_nodes = i;
		},
		add_node(i, node) {
			try {
				if (!node) {
					strings[i] = "null";
					return;
				}
				/** @type {any} */
				const payload = {
					type: "data",
					data: node.data,
					uses: serialize_uses(node)
				};
				if (node.slash) payload.slash = node.slash;
				strings[i] = uneval(payload, get_replacer(i));
			} catch (e) {
				e.path = e.path.slice(1);
				throw new Error(clarify_devalue_error(event, e), { cause: e });
			}
		},
		get_data(csp) {
			const open = `<script${csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : ""}>`;
			const close = `<\/script>\n`;
			return {
				data: `[${compact(max_nodes > -1 ? strings.slice(0, max_nodes) : strings).join(",")}]`,
				chunks: promise_id > 1 ? iterator.iterate(({ index, str }) => {
					if (max_nodes > -1 && index >= max_nodes) return "";
					return open + str + close;
				}) : null
			};
		}
	};
}
/**
* If the serialized data contains promises, `chunks` will be an
* async iterable containing their resolutions
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} event_state
* @param {import('types').SSROptions} options
* @returns {import('./types.js').ServerDataSerializerJson}
*/
function server_data_serializer_json(event, event_state, options) {
	let promise_id = 1;
	const iterator = create_async_iterator();
	const reducers = {
		...Object.fromEntries(Object.entries(options.hooks.transport).map(([key, value]) => [key, value.encode])),
		Promise: (thing) => {
			if (typeof thing?.then !== "function") return;
			const id = promise_id++;
			/** @type {'data' | 'error'} */
			let key = "data";
			const promise = thing.catch(
				/** @param {any} e */
				async (e) => {
					key = "error";
					return handle_error_and_jsonify(event, event_state, options, e);
				}
			).then(
				/** @param {any} value */
				async (value) => {
					let str;
					try {
						str = stringify$1(value, reducers);
					} catch {
						const error = await handle_error_and_jsonify(event, event_state, options, /* @__PURE__ */ new Error(`Failed to serialize promise while rendering ${event.route.id}`));
						key = "error";
						str = stringify$1(error, reducers);
					}
					return `{"type":"chunk","id":${id},"${key}":${str}}\n`;
				}
			);
			iterator.add(promise);
			return id;
		}
	};
	const strings = [];
	return {
		add_node(i, node) {
			try {
				if (!node) {
					strings[i] = "null";
					return;
				}
				if (node.type === "error" || node.type === "skip") {
					strings[i] = JSON.stringify(node);
					return;
				}
				strings[i] = `{"type":"data","data":${stringify$1(node.data, reducers)},"uses":${JSON.stringify(serialize_uses(node))}${node.slash ? `,"slash":${JSON.stringify(node.slash)}` : ""}}`;
			} catch (e) {
				e.path = "data" + e.path;
				throw new Error(clarify_devalue_error(event, e), { cause: e });
			}
		},
		get_data() {
			return {
				data: `{"type":"data","nodes":[${strings.join(",")}]}\n`,
				chunks: promise_id > 1 ? iterator.iterate() : null
			};
		}
	};
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/load_data.js
/**
* Calls the user's server `load` function.
* @param {{
*   event: import('@sveltejs/kit').RequestEvent;
*   event_state: import('types').RequestState;
*   state: import('types').SSRState;
*   node: import('types').SSRNode | undefined;
*   parent: () => Promise<Record<string, any>>;
* }} opts
* @returns {Promise<import('types').ServerDataNode | null>}
*/
async function load_server_data({ event, event_state, state, node, parent }) {
	if (!node?.server) return null;
	let is_tracking = true;
	const uses = {
		dependencies: /* @__PURE__ */ new Set(),
		params: /* @__PURE__ */ new Set(),
		parent: false,
		route: false,
		url: false,
		search_params: /* @__PURE__ */ new Set()
	};
	const load = node.server.load;
	const slash = node.server.trailingSlash;
	if (!load) return {
		type: "data",
		data: null,
		uses,
		slash
	};
	const url = make_trackable(event.url, () => {
		if (is_tracking) uses.url = true;
	}, (param) => {
		if (is_tracking) uses.search_params.add(param);
	});
	if (state.prerendering) disable_search(url);
	return {
		type: "data",
		data: await record_span({
			name: "sveltekit.load",
			attributes: {
				"sveltekit.load.node_id": node.server_id || "unknown",
				"sveltekit.load.node_type": get_node_type(node.server_id),
				"http.route": event.route.id || "unknown"
			},
			fn: async (current) => {
				const traced_event = merge_tracing(event, current);
				return await with_request_store({
					event: traced_event,
					state: event_state
				}, () => load.call(null, {
					...traced_event,
					fetch: (info, init) => {
						new URL(info instanceof Request ? info.url : info, event.url);
						return event.fetch(info, init);
					},
					depends: (...deps) => {
						for (const dep of deps) {
							const { href } = new URL(dep, event.url);
							uses.dependencies.add(href);
						}
					},
					params: new Proxy(event.params, { get: (target, key) => {
						if (is_tracking) uses.params.add(key);
						return target[key];
					} }),
					parent: async () => {
						if (is_tracking) uses.parent = true;
						return parent();
					},
					route: new Proxy(event.route, { get: (target, key) => {
						if (is_tracking) uses.route = true;
						return target[key];
					} }),
					url,
					untrack(fn) {
						is_tracking = false;
						try {
							return fn();
						} finally {
							is_tracking = true;
						}
					}
				}));
			}
		}) ?? null,
		uses,
		slash
	};
}
/**
* Calls the user's `load` function.
* @param {{
*   event: import('@sveltejs/kit').RequestEvent;
*   event_state: import('types').RequestState;
*   fetched: import('./types.js').Fetched[];
*   node: import('types').SSRNode | undefined;
*   parent: () => Promise<Record<string, any>>;
*   resolve_opts: import('types').RequiredResolveOptions;
*   server_data_promise: Promise<import('types').ServerDataNode | null>;
*   state: import('types').SSRState;
*   csr: boolean;
* }} opts
* @returns {Promise<Record<string, any | Promise<any>> | null>}
*/
async function load_data({ event, event_state, fetched, node, parent, server_data_promise, state, resolve_opts, csr }) {
	const server_data_node = await server_data_promise;
	const load = node?.universal?.load;
	if (!load) return server_data_node?.data ?? null;
	return await record_span({
		name: "sveltekit.load",
		attributes: {
			"sveltekit.load.node_id": node.universal_id || "unknown",
			"sveltekit.load.node_type": get_node_type(node.universal_id),
			"http.route": event.route.id || "unknown"
		},
		fn: async (current) => {
			const traced_event = merge_tracing(event, current);
			return await with_request_store({
				event: traced_event,
				state: {
					...event_state,
					is_in_universal_load: true
				}
			}, () => load.call(null, {
				url: event.url,
				params: event.params,
				data: server_data_node?.data ?? null,
				route: event.route,
				fetch: create_universal_fetch(event, state, fetched, csr, resolve_opts),
				setHeaders: event.setHeaders,
				depends: noop,
				parent,
				untrack: (fn) => fn(),
				tracing: traced_event.tracing
			}));
		}
	}) ?? null;
}
/**
* @param {Pick<import('@sveltejs/kit').RequestEvent, 'fetch' | 'url' | 'request' | 'route'>} event
* @param {import('types').SSRState} state
* @param {import('./types.js').Fetched[]} fetched
* @param {boolean} csr
* @param {Pick<Required<import('@sveltejs/kit').ResolveOptions>, 'filterSerializedResponseHeaders'>} resolve_opts
* @returns {typeof fetch}
*/
function create_universal_fetch(event, state, fetched, csr, resolve_opts) {
	/**
	* @param {URL | RequestInfo} input
	* @param {RequestInit} [init]
	*/
	const universal_fetch = async (input, init) => {
		const cloned_body = input instanceof Request && input.body ? input.clone().body : null;
		const cloned_headers = input instanceof Request && [...input.headers].length ? new Headers(input.headers) : init?.headers;
		let response = await event.fetch(input, init);
		const url = new URL(input instanceof Request ? input.url : input, event.url);
		const same_origin = url.origin === event.url.origin;
		/** @type {import('types').PrerenderDependency} */
		let dependency;
		if (same_origin) {
			if (state.prerendering) {
				dependency = {
					response,
					body: null
				};
				state.prerendering.dependencies.set(url.pathname, dependency);
			}
		} else if (url.protocol === "https:" || url.protocol === "http:") if ((input instanceof Request ? input.mode : init?.mode ?? "cors") === "no-cors") response = new Response("", {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
		else {
			const acao = response.headers.get("access-control-allow-origin");
			if (!acao || acao !== event.url.origin && acao !== "*") throw new Error(`CORS error: ${acao ? "Incorrect" : "No"} 'Access-Control-Allow-Origin' header is present on the requested resource`);
		}
		/** @type {ReadableStream<Uint8Array>} */
		let teed_body;
		const proxy = new Proxy(response, { get(response, key, receiver) {
			/**
			* @param {string | undefined} body
			* @param {boolean} is_b64
			*/
			async function push_fetched(body, is_b64) {
				const status_number = Number(response.status);
				if (isNaN(status_number)) throw new Error(`response.status is not a number. value: "${response.status}" type: ${typeof response.status}`);
				fetched.push({
					url: same_origin ? url.href.slice(event.url.origin.length) : url.href,
					method: event.request.method,
					request_body: input instanceof Request && cloned_body ? await stream_to_string(cloned_body) : init?.body,
					request_headers: cloned_headers,
					response_body: body,
					response,
					is_b64
				});
			}
			if (key === "body") {
				if (response.body === null) return null;
				if (teed_body) return teed_body;
				const [a, b] = response.body.tee();
				(async () => {
					let result = new Uint8Array();
					for await (const chunk of a) {
						const combined = new Uint8Array(result.length + chunk.length);
						combined.set(result, 0);
						combined.set(chunk, result.length);
						result = combined;
					}
					if (dependency) dependency.body = new Uint8Array(result);
					push_fetched(base64_encode(result), true);
				})();
				return teed_body = b;
			}
			if (key === "arrayBuffer") return async () => {
				const buffer = await response.arrayBuffer();
				const bytes = new Uint8Array(buffer);
				if (dependency) dependency.body = bytes;
				if (buffer instanceof ArrayBuffer) await push_fetched(base64_encode(bytes), true);
				return buffer;
			};
			async function text() {
				const body = await response.text();
				if (body === "" && NULL_BODY_STATUS.includes(response.status)) {
					await push_fetched(void 0, false);
					return;
				}
				if (!body || typeof body === "string") await push_fetched(body, false);
				if (dependency) dependency.body = body;
				return body;
			}
			if (key === "text") return text;
			if (key === "json") return async () => {
				const body = await text();
				return body ? JSON.parse(body) : void 0;
			};
			const value = Reflect.get(response, key, response);
			if (value instanceof Function) return Object.defineProperties(
				/**
				* @this {any}
				*/
				function() {
					return Reflect.apply(value, this === receiver ? response : this, arguments);
				},
				{
					name: { value: value.name },
					length: { value: value.length }
				}
			);
			return value;
		} });
		if (csr) {
			const get = response.headers.get;
			response.headers.get = (key) => {
				const lower = key.toLowerCase();
				const value = get.call(response.headers, lower);
				if (value && !lower.startsWith("x-sveltekit-")) {
					if (!resolve_opts.filterSerializedResponseHeaders(lower, value)) throw new Error(`Failed to get response header "${lower}" — it must be included by the \`filterSerializedResponseHeaders\` option: https://svelte.dev/docs/kit/hooks#Server-hooks-handle (at ${event.route.id})`);
				}
				return value;
			};
		}
		return proxy;
	};
	return (input, init) => {
		const response = universal_fetch(input, init);
		response.catch(noop);
		return response;
	};
}
/**
* @param {ReadableStream<Uint8Array>} stream
*/
async function stream_to_string(stream) {
	let result = "";
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		result += text_decoder.decode(value);
	}
	return result;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/serialize_data.js
/**
* Inside a script element, only `<\/script` and `<!--` hold special meaning to the HTML parser.
*
* The first closes the script element, so everything after is treated as raw HTML.
* The second disables further parsing until `-->`, so the script element might be unexpectedly
* kept open up until an unrelated HTML comment in the page.
*
* U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are escaped for the sake of pre-2018
* browsers.
*
* @see tests for unsafe parsing examples.
* @see https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
* @see https://html.spec.whatwg.org/multipage/syntax.html#cdata-rcdata-restrictions
* @see https://html.spec.whatwg.org/multipage/parsing.html#script-data-state
* @see https://html.spec.whatwg.org/multipage/parsing.html#script-data-double-escaped-state
* @see https://github.com/tc39/proposal-json-superset
* @type {Record<string, string>}
*/
var replacements = {
	"<": "\\u003C",
	"\u2028": "\\u2028",
	"\u2029": "\\u2029"
};
var pattern = new RegExp(`[${Object.keys(replacements).join("")}]`, "g");
/**
* Generates a raw HTML string containing a safe script element carrying data and associated attributes.
*
* It escapes all the special characters needed to guarantee the element is unbroken, but care must
* be taken to ensure it is inserted in the document at an acceptable position for a script element,
* and that the resulting string isn't further modified.
*
* @param {import('./types.js').Fetched} fetched
* @param {(name: string, value: string) => boolean} filter
* @param {boolean} [prerendering]
* @returns {string} The raw HTML of a script element carrying the JSON payload.
* @example const html = serialize_data('/data.json', null, { foo: 'bar' });
*/
function serialize_data(fetched, filter, prerendering = false) {
	/** @type {Record<string, string>} */
	const headers = {};
	let cache_control = null;
	let age = null;
	let varyAny = false;
	for (const [key, value] of fetched.response.headers) {
		if (filter(key, value)) headers[key] = value;
		if (key === "cache-control") cache_control = value;
		else if (key === "age") age = value;
		else if (key === "vary" && value.trim() === "*") varyAny = true;
	}
	const payload = {
		status: fetched.response.status,
		statusText: fetched.response.statusText,
		headers,
		body: fetched.response_body
	};
	const safe_payload = JSON.stringify(payload).replace(pattern, (match) => replacements[match]);
	const attrs = [
		"type=\"application/json\"",
		"data-sveltekit-fetched",
		`data-url="${escape_html(fetched.url, true)}"`
	];
	if (fetched.is_b64) attrs.push("data-b64");
	if (fetched.request_headers || fetched.request_body) {
		/** @type {import('types').StrictBody[]} */
		const values = [];
		if (fetched.request_headers) values.push([...new Headers(fetched.request_headers)].join(","));
		if (fetched.request_body) values.push(fetched.request_body);
		attrs.push(`data-hash="${hash(...values)}"`);
	}
	if (!prerendering && fetched.method === "GET" && cache_control && !varyAny) {
		const match = /s-maxage=(\d+)/g.exec(cache_control) ?? /max-age=(\d+)/g.exec(cache_control);
		if (match) {
			const ttl = +match[1] - +(age ?? "0");
			attrs.push(`data-ttl="${ttl}"`);
		}
	}
	return `<script ${attrs.join(" ")}>${safe_payload}<\/script>`;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/crypto.js
/**
* SHA-256 hashing function adapted from https://bitwiseshiftleft.github.io/sjcl
* modified and redistributed under BSD license
* @param {string} data
*/
function sha256(data) {
	if (!key[0]) precompute();
	const out = init.slice(0);
	const array = encode(data);
	for (let i = 0; i < array.length; i += 16) {
		const w = array.subarray(i, i + 16);
		let tmp;
		let a;
		let b;
		let out0 = out[0];
		let out1 = out[1];
		let out2 = out[2];
		let out3 = out[3];
		let out4 = out[4];
		let out5 = out[5];
		let out6 = out[6];
		let out7 = out[7];
		for (let i = 0; i < 64; i++) {
			if (i < 16) tmp = w[i];
			else {
				a = w[i + 1 & 15];
				b = w[i + 14 & 15];
				tmp = w[i & 15] = (a >>> 7 ^ a >>> 18 ^ a >>> 3 ^ a << 25 ^ a << 14) + (b >>> 17 ^ b >>> 19 ^ b >>> 10 ^ b << 15 ^ b << 13) + w[i & 15] + w[i + 9 & 15] | 0;
			}
			tmp = tmp + out7 + (out4 >>> 6 ^ out4 >>> 11 ^ out4 >>> 25 ^ out4 << 26 ^ out4 << 21 ^ out4 << 7) + (out6 ^ out4 & (out5 ^ out6)) + key[i];
			out7 = out6;
			out6 = out5;
			out5 = out4;
			out4 = out3 + tmp | 0;
			out3 = out2;
			out2 = out1;
			out1 = out0;
			out0 = tmp + (out1 & out2 ^ out3 & (out1 ^ out2)) + (out1 >>> 2 ^ out1 >>> 13 ^ out1 >>> 22 ^ out1 << 30 ^ out1 << 19 ^ out1 << 10) | 0;
		}
		out[0] = out[0] + out0 | 0;
		out[1] = out[1] + out1 | 0;
		out[2] = out[2] + out2 | 0;
		out[3] = out[3] + out3 | 0;
		out[4] = out[4] + out4 | 0;
		out[5] = out[5] + out5 | 0;
		out[6] = out[6] + out6 | 0;
		out[7] = out[7] + out7 | 0;
	}
	const bytes = new Uint8Array(out.buffer);
	reverse_endianness(bytes);
	return btoa(String.fromCharCode(...bytes));
}
/** The SHA-256 initialization vector */
var init = new Uint32Array(8);
/** The SHA-256 hash key */
var key = new Uint32Array(64);
/** Function to precompute init and key. */
function precompute() {
	/** @param {number} x */
	function frac(x) {
		return (x - Math.floor(x)) * 4294967296;
	}
	let prime = 2;
	for (let i = 0; i < 64; prime++) {
		let is_prime = true;
		for (let factor = 2; factor * factor <= prime; factor++) if (prime % factor === 0) {
			is_prime = false;
			break;
		}
		if (is_prime) {
			if (i < 8) init[i] = frac(prime ** (1 / 2));
			key[i] = frac(prime ** (1 / 3));
			i++;
		}
	}
}
/** @param {Uint8Array} bytes */
function reverse_endianness(bytes) {
	for (let i = 0; i < bytes.length; i += 4) {
		const a = bytes[i + 0];
		const b = bytes[i + 1];
		const c = bytes[i + 2];
		const d = bytes[i + 3];
		bytes[i + 0] = d;
		bytes[i + 1] = c;
		bytes[i + 2] = b;
		bytes[i + 3] = a;
	}
}
/** @param {string} str */
function encode(str) {
	const encoded = text_encoder.encode(str);
	const length = encoded.length * 8;
	const size = 512 * Math.ceil((length + 65) / 512);
	const bytes = new Uint8Array(size / 8);
	bytes.set(encoded);
	bytes[encoded.length] = 128;
	reverse_endianness(bytes);
	const words = new Uint32Array(bytes.buffer);
	words[words.length - 2] = Math.floor(length / 4294967296);
	words[words.length - 1] = length;
	return words;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/csp.js
var array = new Uint8Array(16);
function generate_nonce() {
	crypto.getRandomValues(array);
	return btoa(String.fromCharCode(...array));
}
var quoted = new Set([
	"self",
	"unsafe-eval",
	"unsafe-hashes",
	"unsafe-inline",
	"none",
	"strict-dynamic",
	"report-sample",
	"wasm-unsafe-eval",
	"script"
]);
var crypto_pattern = /^(nonce|sha\d\d\d)-/;
var BaseProvider = class {
	/** @type {boolean} */
	#use_hashes;
	/** @type {boolean} */
	#script_needs_csp;
	/** @type {boolean} */
	#script_src_needs_csp;
	/** @type {boolean} */
	#script_src_elem_needs_csp;
	/** @type {boolean} */
	#style_needs_csp;
	/** @type {boolean} */
	#style_src_needs_csp;
	/** @type {boolean} */
	#style_src_attr_needs_csp;
	/** @type {boolean} */
	#style_src_elem_needs_csp;
	/** @type {import('types').CspDirectives} */
	#directives;
	/** @type {Set<import('types').Csp.Source>} */
	#script_src;
	/** @type {Set<import('types').Csp.Source>} */
	#script_src_elem;
	/** @type {Set<import('types').Csp.Source>} */
	#style_src;
	/** @type {Set<import('types').Csp.Source>} */
	#style_src_attr;
	/** @type {Set<import('types').Csp.Source>} */
	#style_src_elem;
	/** @type {boolean} */
	script_needs_nonce;
	/** @type {boolean} */
	style_needs_nonce;
	/** @type {boolean} */
	script_needs_hash;
	/** @type {string} */
	#nonce;
	/**
	* @param {boolean} use_hashes
	* @param {import('types').CspDirectives} directives
	* @param {string} nonce
	*/
	constructor(use_hashes, directives, nonce) {
		this.#use_hashes = use_hashes;
		this.#directives = directives;
		const d = this.#directives;
		this.#script_src = /* @__PURE__ */ new Set();
		this.#script_src_elem = /* @__PURE__ */ new Set();
		this.#style_src = /* @__PURE__ */ new Set();
		this.#style_src_attr = /* @__PURE__ */ new Set();
		this.#style_src_elem = /* @__PURE__ */ new Set();
		const effective_script_src = d["script-src"] || d["default-src"];
		const script_src_elem = d["script-src-elem"];
		const effective_style_src = d["style-src"] || d["default-src"];
		const style_src_attr = d["style-src-attr"];
		const style_src_elem = d["style-src-elem"];
		/** @param {(import('types').Csp.Source | import('types').Csp.ActionSource)[] | undefined} directive */
		const style_needs_csp = (directive) => !!directive && !directive.some((value) => value === "unsafe-inline");
		/** @param {(import('types').Csp.Source | import('types').Csp.ActionSource)[] | undefined} directive */
		const script_needs_csp = (directive) => !!directive && (!directive.some((value) => value === "unsafe-inline") || directive.some((value) => value === "strict-dynamic"));
		this.#script_src_needs_csp = script_needs_csp(effective_script_src);
		this.#script_src_elem_needs_csp = script_needs_csp(script_src_elem);
		this.#style_src_needs_csp = style_needs_csp(effective_style_src);
		this.#style_src_attr_needs_csp = style_needs_csp(style_src_attr);
		this.#style_src_elem_needs_csp = style_needs_csp(style_src_elem);
		this.#script_needs_csp = this.#script_src_needs_csp || this.#script_src_elem_needs_csp;
		this.#style_needs_csp = this.#style_src_needs_csp || this.#style_src_attr_needs_csp || this.#style_src_elem_needs_csp;
		this.script_needs_nonce = this.#script_needs_csp && !this.#use_hashes;
		this.style_needs_nonce = this.#style_needs_csp && !this.#use_hashes;
		this.script_needs_hash = this.#script_needs_csp && this.#use_hashes;
		this.#nonce = nonce;
	}
	/** @param {string} content */
	add_script(content) {
		if (!this.#script_needs_csp) return;
		/** @type {`nonce-${string}` | `sha256-${string}`} */
		const source = this.#use_hashes ? `sha256-${sha256(content)}` : `nonce-${this.#nonce}`;
		if (this.#script_src_needs_csp) this.#script_src.add(source);
		if (this.#script_src_elem_needs_csp) this.#script_src_elem.add(source);
	}
	/** @param {`sha256-${string}`[]} hashes */
	add_script_hashes(hashes) {
		for (const hash of hashes) {
			if (this.#script_src_needs_csp) this.#script_src.add(hash);
			if (this.#script_src_elem_needs_csp) this.#script_src_elem.add(hash);
		}
	}
	/** @param {string} content */
	add_style(content) {
		if (!this.#style_needs_csp) return;
		/** @type {`nonce-${string}` | `sha256-${string}`} */
		const source = this.#use_hashes ? `sha256-${sha256(content)}` : `nonce-${this.#nonce}`;
		if (this.#style_src_needs_csp) this.#style_src.add(source);
		if (this.#style_src_attr_needs_csp) this.#style_src_attr.add(source);
		if (this.#style_src_elem_needs_csp) {
			const sha256_empty_comment_hash = "sha256-9OlNO0DNEeaVzHL4RZwCLsBHA8WBQ8toBp/4F5XV2nc=";
			const d = this.#directives;
			if (d["style-src-elem"] && !d["style-src-elem"].includes(sha256_empty_comment_hash) && !this.#style_src_elem.has(sha256_empty_comment_hash)) this.#style_src_elem.add(sha256_empty_comment_hash);
			if (source !== sha256_empty_comment_hash) this.#style_src_elem.add(source);
		}
	}
	/**
	* @param {boolean} [is_meta]
	*/
	get_header(is_meta = false) {
		const header = [];
		const directives = { ...this.#directives };
		if (this.#style_src.size > 0) directives["style-src"] = [...directives["style-src"] || directives["default-src"] || [], ...this.#style_src];
		if (this.#style_src_attr.size > 0) directives["style-src-attr"] = [...directives["style-src-attr"] || [], ...this.#style_src_attr];
		if (this.#style_src_elem.size > 0) directives["style-src-elem"] = [...directives["style-src-elem"] || [], ...this.#style_src_elem];
		if (this.#script_src.size > 0) directives["script-src"] = [...directives["script-src"] || directives["default-src"] || [], ...this.#script_src];
		if (this.#script_src_elem.size > 0) directives["script-src-elem"] = [...directives["script-src-elem"] || [], ...this.#script_src_elem];
		for (const key in directives) {
			if (is_meta && (key === "frame-ancestors" || key === "report-uri" || key === "sandbox")) continue;
			const value = directives[key];
			if (!value) continue;
			const directive = [key];
			if (Array.isArray(value)) value.forEach((value) => {
				if (quoted.has(value) || crypto_pattern.test(value)) directive.push(`'${value}'`);
				else directive.push(value);
			});
			header.push(directive.join(" "));
		}
		return header.join("; ");
	}
};
var CspProvider = class extends BaseProvider {
	get_meta() {
		const content = this.get_header(true);
		if (!content) return;
		return `<meta http-equiv="content-security-policy" content="${escape_html(content, true)}">`;
	}
};
var CspReportOnlyProvider = class extends BaseProvider {
	/**
	* @param {boolean} use_hashes
	* @param {import('types').CspDirectives} directives
	* @param {string} nonce
	*/
	constructor(use_hashes, directives, nonce) {
		super(use_hashes, directives, nonce);
		if (Object.values(directives).filter((v) => !!v).length > 0) {
			const has_report_to = directives["report-to"]?.length ?? false;
			const has_report_uri = directives["report-uri"]?.length ?? false;
			if (!has_report_to && !has_report_uri) throw Error("`content-security-policy-report-only` must be specified with either the `report-to` or `report-uri` directives, or both");
		}
	}
};
var Csp = class {
	/** @readonly */
	nonce = generate_nonce();
	/** @type {CspProvider} */
	csp_provider;
	/** @type {CspReportOnlyProvider} */
	report_only_provider;
	/**
	* @param {import('./types.js').CspConfig} config
	* @param {import('./types.js').CspOpts} opts
	*/
	constructor({ mode, directives, reportOnly }, { prerender }) {
		const use_hashes = mode === "hash" || mode === "auto" && prerender;
		this.csp_provider = new CspProvider(use_hashes, directives, this.nonce);
		this.report_only_provider = new CspReportOnlyProvider(use_hashes, reportOnly, this.nonce);
	}
	get script_needs_hash() {
		return this.csp_provider.script_needs_hash || this.report_only_provider.script_needs_hash;
	}
	get script_needs_nonce() {
		return this.csp_provider.script_needs_nonce || this.report_only_provider.script_needs_nonce;
	}
	get style_needs_nonce() {
		return this.csp_provider.style_needs_nonce || this.report_only_provider.style_needs_nonce;
	}
	/** @param {string} content */
	add_script(content) {
		this.csp_provider.add_script(content);
		this.report_only_provider.add_script(content);
	}
	/** @param {`sha256-${string}`[]} hashes */
	add_script_hashes(hashes) {
		this.csp_provider.add_script_hashes(hashes);
		this.report_only_provider.add_script_hashes(hashes);
	}
	/** @param {string} content */
	add_style(content) {
		this.csp_provider.add_style(content);
		this.report_only_provider.add_style(content);
	}
};
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/server_routing.js
/**
* @param {import('types').SSRClientRoute} route
* @param {URL} url
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @returns {string}
*/
function generate_route_object(route, url, manifest) {
	const { errors, layouts, leaf } = route;
	const nodes = [
		...errors,
		...layouts.map((l) => l?.[1]),
		leaf[1]
	].filter((n) => typeof n === "number").map((n) => `'${n}': () => ${create_client_import(manifest._.client.nodes?.[n], url)}`).join(",\n		");
	/** @type {import('types').CSRRouteServer} */
	return [
		`{\n\tid: ${s(route.id)}`,
		`errors: ${s(route.errors)}`,
		`layouts: ${s(route.layouts)}`,
		`leaf: ${s(route.leaf)}`,
		`nodes: {\n\t\t${nodes}\n\t}\n}`
	].join(",\n	");
}
/**
* @param {string | undefined} import_path
* @param {URL} url
*/
function create_client_import(import_path, url) {
	if (!import_path) return "Promise.resolve({})";
	if (import_path[0] === "/") return `import('${import_path}')`;
	if (assets !== "") return `import('${assets}/${import_path}')`;
	let path = get_relative_path(url.pathname, `${base}/${import_path}`);
	if (path[0] !== ".") path = `./${path}`;
	return `import('${path}')`;
}
/**
* @param {string} resolved_path
* @param {URL} url
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @returns {Promise<Response>}
*/
async function resolve_route(resolved_path, url, manifest) {
	if (!manifest._.client.routes) return text("Server-side route resolution disabled", { status: 400 });
	const matchers = await manifest._.matchers();
	const result = find_route(resolved_path, manifest._.client.routes, matchers);
	return create_server_routing_response(result?.route ?? null, result?.params ?? {}, url, manifest).response;
}
/**
* @param {import('types').SSRClientRoute | null} route
* @param {Partial<Record<string, string>>} params
* @param {URL} url
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @returns {{response: Response, body: string}}
*/
function create_server_routing_response(route, params, url, manifest) {
	const headers = new Headers({ "content-type": "application/javascript; charset=utf-8" });
	if (route) {
		const csr_route = generate_route_object(route, url, manifest);
		const body = `${create_css_import(route, url, manifest)}\nexport const route = ${csr_route}; export const params = ${JSON.stringify(params)};`;
		return {
			response: text(body, { headers }),
			body
		};
	} else return {
		response: text("", { headers }),
		body: ""
	};
}
/**
* This function generates the client-side import for the CSS files that are
* associated with the current route. Vite takes care of that when using
* client-side route resolution, but for server-side resolution it does
* not know about the CSS files automatically.
*
* @param {import('types').SSRClientRoute} route
* @param {URL} url
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @returns {string}
*/
function create_css_import(route, url, manifest) {
	const { errors, layouts, leaf } = route;
	let css = "";
	for (const node of [
		...errors,
		...layouts.map((l) => l?.[1]),
		leaf[1]
	]) {
		if (typeof node !== "number") continue;
		const node_css = manifest._.client.css?.[node];
		for (const css_path of node_css ?? []) css += `'${assets || base}/${css_path}',`;
	}
	if (!css) return "";
	return `${create_client_import(manifest._.client.start, url)}.then(x => x.load_css([${css}]));`;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/render.js
var updated = {
	...readable(false),
	check: () => false
};
/**
* Creates the HTML response.
* @param {{
*   branch: Array<import('./types.js').Loaded>;
*   fetched: Array<import('./types.js').Fetched>;
*   options: import('types').SSROptions;
*   manifest: import('@sveltejs/kit').SSRManifest;
*   state: import('types').SSRState;
*   page_config: { ssr: boolean; csr: boolean };
*   status: number;
*   error: App.Error | null;
*   event: import('@sveltejs/kit').RequestEvent;
*   event_state: import('types').RequestState;
*   resolve_opts: import('types').RequiredResolveOptions;
*   action_result?: import('@sveltejs/kit').ActionResult;
*   data_serializer: import('./types.js').ServerDataSerializer;
*   error_components?: Array<import('types').SSRComponent | undefined>
* }} opts
*/
async function render_response({ branch, fetched, options, manifest, state, page_config, status, error = null, event, event_state, resolve_opts, action_result, data_serializer, error_components }) {
	if (state.prerendering) {
		if (options.csp.mode === "nonce") throw new Error("Cannot use prerendering if config.kit.csp.mode === \"nonce\"");
		if (options.app_template_contains_nonce) throw new Error("Cannot use prerendering if page template contains %sveltekit.nonce%");
	}
	const { client } = manifest._;
	const modulepreloads = new Set(client.imports);
	const stylesheets = new Set(client.stylesheets);
	const fonts = new Set(client.fonts);
	/**
	* The value of the Link header that is added to the response when not prerendering
	* @type {Set<string>}
	*/
	const link_headers = /* @__PURE__ */ new Set();
	/** @type {Map<string, string>} */
	const inline_styles = /* @__PURE__ */ new Map();
	/** @type {ReturnType<typeof options.root.render>} */
	let rendered;
	const form_value = action_result?.type === "success" || action_result?.type === "failure" ? action_result.data ?? null : null;
	/** @type {string} */
	let base$1 = base;
	/** @type {string} */
	let assets$1 = assets;
	/**
	* An expression that will evaluate in the client to determine the resolved base path.
	* We use a relative path when possible to support IPFS, the internet archive, etc.
	*/
	let base_expression = s(base);
	const csp = new Csp(options.csp, { prerender: !!state.prerendering });
	if (!state.prerendering?.fallback) {
		base$1 = event.url.pathname.slice(base.length).split("/").slice(2).map(() => "..").join("/") || ".";
		base_expression = `new URL(${s(base$1)}, location).pathname.slice(0, -1)`;
		if (!assets || assets[0] === "/" && assets !== "/_svelte_kit_assets") assets$1 = base$1;
	} else if (options.hash_routing) base_expression = "new URL('.', location).pathname.slice(0, -1)";
	if (page_config.ssr) {
		/** @type {Record<string, any>} */
		const props = {
			stores: {
				page: writable(null),
				navigating: writable(null),
				updated
			},
			constructors: await Promise.all(branch.map(({ node }) => {
				if (!node.component) throw new Error(`Missing +page.svelte component for route ${event.route.id}`);
				return node.component();
			})),
			form: form_value
		};
		if (error_components) {
			if (error) props.error = error;
			props.errors = error_components;
		}
		let data = {};
		for (let i = 0; i < branch.length; i += 1) {
			data = {
				...data,
				...branch[i].data
			};
			props[`data_${i}`] = data;
		}
		props.page = {
			error,
			params: event.params,
			route: event.route,
			status,
			url: event.url,
			data,
			form: form_value,
			state: {}
		};
		const render_opts = {
			context: new Map([["__request__", { page: props.page }]]),
			csp: csp.script_needs_nonce ? { nonce: csp.nonce } : { hash: csp.script_needs_hash },
			transformError: error_components ? async (e) => {
				if (isRedirect(e)) throw e;
				const transformed = await handle_error_and_jsonify(event, event_state, options, e);
				props.page.error = props.error = error = transformed;
				props.page.status = status = get_status(e);
				return transformed;
			} : void 0
		};
		try {
			rendered = await with_request_store({
				event,
				state: {
					...event_state,
					is_in_render: true
				}
			}, async () => {
				override({
					base: base$1,
					assets: assets$1
				});
				const maybe_promise = options.root.render(props, render_opts);
				const rendered = options.async && "then" in maybe_promise ? maybe_promise.then((r) => r) : maybe_promise;
				if (options.async) reset();
				const { head, html, css, hashes } = options.async ? await rendered : rendered;
				if (hashes) csp.add_script_hashes(hashes.script);
				return {
					head,
					html,
					css,
					hashes
				};
			});
		} finally {
			reset();
		}
		for (const { node } of branch) {
			for (const url of node.imports) modulepreloads.add(url);
			for (const url of node.stylesheets) stylesheets.add(url);
			for (const url of node.fonts) fonts.add(url);
			if (node.inline_styles && !client.inline) Object.entries(await node.inline_styles()).forEach(([filename, css]) => {
				if (typeof css === "string") {
					inline_styles.set(filename, css);
					return;
				}
				inline_styles.set(filename, css(`${assets$1}/${app_dir}/immutable/assets`, assets$1));
			});
		}
	} else rendered = {
		head: "",
		html: "",
		css: {
			code: "",
			map: null
		},
		hashes: { script: [] }
	};
	const head = new Head(rendered.head, !!state.prerendering);
	let body = rendered.html;
	/** @param {string} path */
	const prefixed = (path) => {
		if (path.startsWith("/")) return base + path;
		return `${assets$1}/${path}`;
	};
	const style = client.inline ? client.inline?.style : Array.from(inline_styles.values()).join("\n");
	if (style) {
		const attributes = [];
		if (csp.style_needs_nonce) attributes.push(`nonce="${csp.nonce}"`);
		csp.add_style(style);
		head.add_style(style, attributes);
	}
	for (const dep of stylesheets) {
		const path = prefixed(dep);
		const attributes = ["rel=\"stylesheet\""];
		if (inline_styles.has(dep)) attributes.push("disabled", "media=\"(max-width: 0)\"");
		else if (resolve_opts.preload({
			type: "css",
			path
		})) link_headers.add(`<${encodeURI(path)}>; rel="preload"; as="style"; nopush`);
		head.add_stylesheet(path, attributes);
	}
	for (const dep of fonts) {
		const path = prefixed(dep);
		if (resolve_opts.preload({
			type: "font",
			path
		})) {
			const ext = dep.slice(dep.lastIndexOf(".") + 1);
			head.add_link_tag(path, [
				"rel=\"preload\"",
				"as=\"font\"",
				`type="font/${ext}"`,
				"crossorigin"
			]);
			link_headers.add(`<${encodeURI(path)}>; rel="preload"; as="font"; type="font/${ext}"; crossorigin; nopush`);
		}
	}
	const global = get_global_name(options);
	const { data, chunks } = data_serializer.get_data(csp);
	if (page_config.ssr && page_config.csr) body += `\n\t\t\t${fetched.map((item) => serialize_data(item, resolve_opts.filterSerializedResponseHeaders, !!state.prerendering)).join("\n			")}`;
	if (page_config.csr) {
		const route = manifest._.client.routes?.find((r) => r.id === event.route.id) ?? null;
		if (client.uses_env_dynamic_public && state.prerendering) modulepreloads.add(`${app_dir}/env.js`);
		if (!client.inline) {
			const included_modulepreloads = Array.from(modulepreloads, (dep) => prefixed(dep)).filter((path) => resolve_opts.preload({
				type: "js",
				path
			}));
			for (const path of included_modulepreloads) {
				link_headers.add(`<${encodeURI(path)}>; rel="modulepreload"; nopush`);
				if (options.preload_strategy !== "modulepreload") head.add_script_preload(path);
				else head.add_link_tag(path, ["rel=\"modulepreload\""]);
			}
		}
		if (manifest._.client.routes && state.prerendering && !state.prerendering.fallback) {
			const pathname = add_resolution_suffix(event.url.pathname);
			state.prerendering.dependencies.set(pathname, create_server_routing_response(route, event.params, new URL(pathname, event.url), manifest));
		}
		const blocks = [];
		const load_env_eagerly = client.uses_env_dynamic_public && state.prerendering;
		const properties = [`base: ${base_expression}`];
		if (assets) properties.push(`assets: ${s(assets)}`);
		if (client.uses_env_dynamic_public) properties.push(`env: ${load_env_eagerly ? "null" : s(public_env)}`);
		if (chunks) {
			blocks.push("const deferred = new Map();");
			properties.push(`defer: (id) => new Promise((fulfil, reject) => {
							deferred.set(id, { fulfil, reject });
						})`);
			let app_declaration = "";
			if (Object.keys(options.hooks.transport).length > 0) if (client.inline) app_declaration = `const app = __sveltekit_${options.version_hash}.app.app;`;
			else if (client.app) app_declaration = `const app = await import(${s(prefixed(client.app))});`;
			else app_declaration = `const { app } = await import(${s(prefixed(client.start))});`;
			const prelude = app_declaration ? `${app_declaration}
							const [data, error] = fn(app);` : `const [data, error] = fn();`;
			properties.push(`resolve: async (id, fn) => {
							${prelude}

							const try_to_resolve = () => {
								if (!deferred.has(id)) {
									setTimeout(try_to_resolve, 0);
									return;
								}
								const { fulfil, reject } = deferred.get(id);
								deferred.delete(id);
								if (error) reject(error);
								else fulfil(data);
							}
							try_to_resolve();
						}`);
		}
		blocks.push(`${global} = {
						${properties.join(",\n						")}
					};`);
		const args = ["element"];
		blocks.push("const element = document.currentScript.parentElement;");
		if (page_config.ssr) {
			const serialized = {
				form: "null",
				error: "null"
			};
			if (form_value) serialized.form = uneval_action_response(form_value, event.route.id, options.hooks.transport);
			if (error) serialized.error = uneval(error);
			const hydrate = [
				`node_ids: [${branch.map(({ node }) => node.index).join(", ")}]`,
				`data: ${data}`,
				`form: ${serialized.form}`,
				`error: ${serialized.error}`
			];
			if (status !== 200) hydrate.push(`status: ${status}`);
			if (manifest._.client.routes) {
				if (route) {
					const stringified = generate_route_object(route, event.url, manifest).replaceAll("\n", "\n							");
					hydrate.push(`params: ${uneval(event.params)}`, `server_route: ${stringified}`);
				}
			} else if (options.embedded) hydrate.push(`params: ${uneval(event.params)}`, `route: ${s(event.route)}`);
			const indent = "	".repeat(load_env_eagerly ? 7 : 6);
			args.push(`{\n${indent}\t${hydrate.join(`,\n${indent}\t`)}\n${indent}}`);
		}
		const { remote } = event_state;
		let serialized_query_data = "";
		let serialized_prerender_data = "";
		if (remote.data) {
			/** @type {Record<string, any>} */
			const query = {};
			/** @type {Record<string, any>} */
			const prerender = {};
			for (const [internals, cache] of remote.data) {
				if (!internals.id) continue;
				for (const key in cache) {
					const entry = cache[key];
					if (!entry.serialize) continue;
					const remote_key = create_remote_key(internals.id, key);
					const store = internals.type === "prerender" ? prerender : query;
					if (event_state.remote.refreshes?.[remote_key] !== void 0) store[remote_key] = await entry.data;
					else {
						const result = await Promise.race([Promise.resolve(entry.data).then((v) => ({
							settled: true,
							value: v
						}), (e) => ({
							settled: true,
							error: e
						})), new Promise((resolve) => {
							queueMicrotask(() => resolve({ settled: false }));
						})]);
						if (result.settled) {
							if ("error" in result) throw result.error;
							store[remote_key] = result.value;
						}
					}
				}
			}
			const replacer = (thing) => {
				for (const key in options.hooks.transport) {
					const encoded = options.hooks.transport[key].encode(thing);
					if (encoded) return `app.decode('${key}', ${uneval(encoded, replacer)})`;
				}
			};
			if (Object.keys(query).length > 0) serialized_query_data = `${global}.query = ${uneval(query, replacer)};\n\n\t\t\t\t\t\t`;
			if (Object.keys(prerender).length > 0) serialized_prerender_data = `${global}.prerender = ${uneval(prerender, replacer)};\n\n\t\t\t\t\t\t`;
		}
		const serialized_remote_data = `${serialized_query_data}${serialized_prerender_data}`;
		const boot = client.inline ? `${client.inline.script}

					${serialized_remote_data}${global}.app.start(${args.join(", ")});` : client.app ? `Promise.all([
						import(${s(prefixed(client.start))}),
						import(${s(prefixed(client.app))})
					]).then(([kit, app]) => {
						${serialized_remote_data}kit.start(app, ${args.join(", ")});
					});` : `import(${s(prefixed(client.start))}).then((app) => {
						${serialized_remote_data}app.start(${args.join(", ")})
					});`;
		if (load_env_eagerly) blocks.push(`import(${s(`${base$1}/${app_dir}/env.js`)}).then(({ env }) => {
						${global}.env = env;

						${boot.replace(/\n/g, "\n	")}
					});`);
		else blocks.push(boot);
		if (options.service_worker) {
			let opts = "";
			if (options.service_worker_options != null) opts = `, ${s({ ...options.service_worker_options })}`;
			blocks.push(`if ('serviceWorker' in navigator) {
						const script_url = '${prefixed("service-worker.js")}';
						const policy = globalThis?.window?.trustedTypes?.createPolicy(
							'sveltekit-trusted-url',
							{ createScriptURL(url) { return url; } }
						);
						const sanitised = policy?.createScriptURL(script_url) ?? script_url;
						addEventListener('load', function () {
							navigator.serviceWorker.register(sanitised${opts});
						});
					}`);
		}
		const init_app = `
				{
					${blocks.join("\n\n					")}
				}
			`;
		csp.add_script(init_app);
		body += `\n\t\t\t<script${csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : ""}>${init_app}<\/script>\n\t\t`;
	}
	const headers = new Headers({
		"x-sveltekit-page": "true",
		"content-type": "text/html"
	});
	if (state.prerendering) {
		const csp_headers = csp.csp_provider.get_meta();
		if (csp_headers) head.add_http_equiv(csp_headers);
		if (state.prerendering.cache) head.add_http_equiv(`<meta http-equiv="cache-control" content="${state.prerendering.cache}">`);
	} else {
		const csp_header = csp.csp_provider.get_header();
		if (csp_header) headers.set("content-security-policy", csp_header);
		const report_only_header = csp.report_only_provider.get_header();
		if (report_only_header) headers.set("content-security-policy-report-only", report_only_header);
		if (link_headers.size) headers.set("link", Array.from(link_headers).join(", "));
	}
	const html = options.templates.app({
		head: head.build(),
		body,
		assets: assets$1,
		nonce: csp.nonce,
		env: public_env
	});
	const transformed = await resolve_opts.transformPageChunk({
		html,
		done: true
	}) || "";
	if (!chunks) headers.set("etag", `"${hash(transformed)}"`);
	return !chunks ? text(transformed, {
		status,
		headers
	}) : new Response(new ReadableStream({
		async start(controller) {
			controller.enqueue(text_encoder.encode(transformed + "\n"));
			for await (const chunk of chunks) if (chunk.length) controller.enqueue(text_encoder.encode(chunk));
			controller.close();
		},
		type: "bytes"
	}), { headers });
}
var Head = class {
	#rendered;
	#prerendering;
	/** @type {string[]} */
	#http_equiv = [];
	/** @type {string[]} */
	#link_tags = [];
	/** @type {string[]} */
	#script_preloads = [];
	/** @type {string[]} */
	#style_tags = [];
	/** @type {string[]} */
	#stylesheet_links = [];
	/**
	* @param {string} rendered
	* @param {boolean} prerendering
	*/
	constructor(rendered, prerendering) {
		this.#rendered = rendered;
		this.#prerendering = prerendering;
	}
	build() {
		return [
			...this.#http_equiv,
			...this.#link_tags,
			...this.#script_preloads,
			this.#rendered,
			...this.#style_tags,
			...this.#stylesheet_links
		].join("\n		");
	}
	/**
	* @param {string} style
	* @param {string[]} attributes
	*/
	add_style(style, attributes) {
		this.#style_tags.push(`<style${attributes.length ? " " + attributes.join(" ") : ""}>${style}</style>`);
	}
	/**
	* @param {string} href
	* @param {string[]} attributes
	*/
	add_stylesheet(href, attributes) {
		this.#stylesheet_links.push(`<link href="${href}" ${attributes.join(" ")}>`);
	}
	/** @param {string} href */
	add_script_preload(href) {
		this.#script_preloads.push(`<link rel="preload" as="script" crossorigin="anonymous" href="${href}">`);
	}
	/**
	* @param {string} href
	* @param {string[]} attributes
	*/
	add_link_tag(href, attributes) {
		if (!this.#prerendering) return;
		this.#link_tags.push(`<link href="${href}" ${attributes.join(" ")}>`);
	}
	/** @param {string} tag */
	add_http_equiv(tag) {
		if (!this.#prerendering) return;
		this.#http_equiv.push(tag);
	}
};
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/utils/page_nodes.js
var PageNodes = class {
	data;
	/**
	* @param {Array<import('types').SSRNode | undefined>} nodes
	*/
	constructor(nodes) {
		this.data = nodes;
	}
	layouts() {
		return this.data.slice(0, -1);
	}
	page() {
		return this.data.at(-1);
	}
	validate() {
		for (const layout of this.layouts()) if (layout) {
			validate_layout_server_exports(layout.server, layout.server_id);
			validate_layout_exports(layout.universal, layout.universal_id);
		}
		const page = this.page();
		if (page) {
			validate_page_server_exports(page.server, page.server_id);
			validate_page_exports(page.universal, page.universal_id);
		}
	}
	/**
	* @template {'prerender' | 'ssr' | 'csr' | 'trailingSlash'} Option
	* @param {Option} option
	* @returns {Value | undefined}
	*/
	#get_option(option) {
		/** @typedef {(import('types').UniversalNode | import('types').ServerNode)[Option]} Value */
		return this.data.reduce((value, node) => {
			return node?.universal?.[option] ?? node?.server?.[option] ?? value;
		}, void 0);
	}
	csr() {
		return this.#get_option("csr") ?? true;
	}
	ssr() {
		return this.#get_option("ssr") ?? true;
	}
	prerender() {
		return this.#get_option("prerender") ?? false;
	}
	trailing_slash() {
		return this.#get_option("trailingSlash") ?? "never";
	}
	get_config() {
		/** @type {any} */
		let current = {};
		for (const node of this.data) {
			if (!node?.universal?.config && !node?.server?.config) continue;
			current = {
				...current,
				...node?.universal?.config,
				...node?.server?.config
			};
		}
		return Object.keys(current).length ? current : void 0;
	}
	should_prerender_data() {
		return this.data.some((node) => node?.server?.load || node?.server?.trailingSlash !== void 0);
	}
};
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/respond_with_error.js
/**
* @typedef {import('./types.js').Loaded} Loaded
*/
/**
* @param {{
*   event: import('@sveltejs/kit').RequestEvent;
*   event_state: import('types').RequestState;
*   options: import('types').SSROptions;
*   manifest: import('@sveltejs/kit').SSRManifest;
*   state: import('types').SSRState;
*   status: number;
*   error: unknown;
*   resolve_opts: import('types').RequiredResolveOptions;
* }} opts
*/
async function respond_with_error({ event, event_state, options, manifest, state, status, error, resolve_opts }) {
	if (event.request.headers.get("x-sveltekit-error")) return static_error_page(
		options,
		status,
		/** @type {Error} */
		error.message
	);
	/** @type {import('./types.js').Fetched[]} */
	const fetched = [];
	try {
		const branch = [];
		const default_layout = await manifest._.nodes[0]();
		const nodes = new PageNodes([default_layout]);
		const ssr = nodes.ssr();
		const csr = nodes.csr();
		const data_serializer = server_data_serializer(event, event_state, options);
		if (ssr) {
			state.error = true;
			const server_data_promise = load_server_data({
				event,
				event_state,
				state,
				node: default_layout,
				parent: async () => ({})
			});
			const server_data = await server_data_promise;
			data_serializer.add_node(0, server_data);
			const data = await load_data({
				event,
				event_state,
				fetched,
				node: default_layout,
				parent: async () => ({}),
				resolve_opts,
				server_data_promise,
				state,
				csr
			});
			branch.push({
				node: default_layout,
				server_data,
				data
			}, {
				node: await manifest._.nodes[1](),
				data: null,
				server_data: null
			});
		}
		return await render_response({
			options,
			manifest,
			state,
			page_config: {
				ssr,
				csr
			},
			status,
			error: await handle_error_and_jsonify(event, event_state, options, error),
			branch,
			error_components: [],
			fetched,
			event,
			event_state,
			resolve_opts,
			data_serializer
		});
	} catch (e) {
		if (e instanceof Redirect) return redirect_response(e.status, e.location);
		return static_error_page(options, get_status(e), (await handle_error_and_jsonify(event, event_state, options, e)).message);
	}
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/remote.js
/** @import { ActionResult, RemoteForm, RequestEvent, SSRManifest } from '@sveltejs/kit' */
/** @import { RemoteFormInternals, RemoteFunctionResponse, RemoteInternals, RequestState, SSROptions } from 'types' */
/** @type {typeof handle_remote_call_internal} */
async function handle_remote_call(event, state, options, manifest, id) {
	return record_span({
		name: "sveltekit.remote.call",
		attributes: { },
		fn: (current) => {
			const traced_event = merge_tracing(event, current);
			return with_request_store({
				event: traced_event,
				state
			}, () => handle_remote_call_internal(traced_event, state, options, manifest, id));
		}
	});
}
/**
* @param {RequestEvent} event
* @param {RequestState} state
* @param {SSROptions} options
* @param {SSRManifest} manifest
* @param {string} id
*/
async function handle_remote_call_internal(event, state, options, manifest, id) {
	const [hash, name, additional_args] = id.split("/");
	const remotes = manifest._.remotes;
	if (!remotes[hash]) error(404);
	const fn = (await remotes[hash]()).default[name];
	if (!fn) error(404);
	/** @type {RemoteInternals} */
	const internals = fn.__;
	const transport = options.hooks.transport;
	event.tracing.current.setAttributes({
		"sveltekit.remote.call.type": internals.type,
		"sveltekit.remote.call.name": internals.name
	});
	try {
		if (internals.type === "query_batch") {
			if (event.request.method !== "POST") throw new SvelteKitError(405, "Method Not Allowed", `\`query.batch\` functions must be invoked via POST request, not ${event.request.method}`);
			/** @type {{ payloads: string[] }} */
			const { payloads } = await event.request.json();
			const args = await Promise.all(payloads.map((payload) => parse_remote_arg(payload, transport)));
			return json({
				type: "result",
				result: stringify(await with_request_store({
					event,
					state
				}, () => internals.run(args, options)), transport)
			});
		}
		if (internals.type === "form") {
			if (event.request.method !== "POST") throw new SvelteKitError(405, "Method Not Allowed", `\`form\` functions must be invoked via POST request, not ${event.request.method}`);
			if (!is_form_content_type(event.request)) throw new SvelteKitError(415, "Unsupported Media Type", `\`form\` functions expect form-encoded data — received ${event.request.headers.get("content-type")}`);
			const { data, meta, form_data } = await deserialize_binary_form(event.request);
			state.remote.requested = create_requested_map(meta.remote_refreshes);
			if (additional_args && !("id" in data)) data.id = JSON.parse(decodeURIComponent(additional_args));
			const fn = internals.fn;
			const result = await with_request_store({
				event,
				state
			}, () => fn(data, meta, form_data));
			return json({
				type: "result",
				result: stringify(result, transport),
				refreshes: result.issues ? void 0 : await serialize_refreshes()
			});
		}
		if (internals.type === "command") {
			/** @type {{ payload: string, refreshes?: string[] }} */
			const { payload, refreshes } = await event.request.json();
			state.remote.requested = create_requested_map(refreshes);
			const arg = parse_remote_arg(payload, transport);
			return json({
				type: "result",
				result: stringify(await with_request_store({
					event,
					state
				}, () => fn(arg)), transport),
				refreshes: await serialize_refreshes()
			});
		}
		const payload = internals.type === "prerender" ? additional_args : new URL(event.request.url).searchParams.get("payload");
		return json({
			type: "result",
			result: stringify(await with_request_store({
				event,
				state
			}, () => fn(parse_remote_arg(payload, transport))), transport)
		});
	} catch (error) {
		if (error instanceof Redirect) return json({
			type: "redirect",
			location: error.location,
			refreshes: await serialize_refreshes()
		});
		const status = error instanceof HttpError || error instanceof SvelteKitError ? error.status : 500;
		return json({
			type: "error",
			error: await handle_error_and_jsonify(event, state, options, error),
			status
		}, {
			status: state.prerendering ? status : void 0,
			headers: { "cache-control": "private, no-store" }
		});
	}
	async function serialize_refreshes() {
		const refreshes = state.remote.refreshes ?? {};
		const entries = Object.entries(refreshes);
		if (entries.length === 0) return;
		const results = await Promise.all(entries.map(async ([key, promise]) => {
			try {
				return [key, {
					type: "result",
					data: await promise
				}];
			} catch (error) {
				return [key, {
					type: "error",
					status: error instanceof HttpError || error instanceof SvelteKitError ? error.status : 500,
					error: await handle_error_and_jsonify(event, state, options, error)
				}];
			}
		}));
		return stringify(Object.fromEntries(results), transport);
	}
}
/**
* @param {string[] | undefined} refreshes
*/
function create_requested_map(refreshes) {
	/** @type {Map<string, string[]>} */
	const requested = /* @__PURE__ */ new Map();
	for (const key of refreshes ?? []) {
		const parts = split_remote_key(key);
		const existing = requested.get(parts.id);
		if (existing) existing.push(parts.payload);
		else requested.set(parts.id, [parts.payload]);
	}
	return requested;
}
/** @type {typeof handle_remote_form_post_internal} */
async function handle_remote_form_post(event, state, manifest, id) {
	return record_span({
		name: "sveltekit.remote.form.post",
		attributes: { },
		fn: (current) => {
			const traced_event = merge_tracing(event, current);
			return with_request_store({
				event: traced_event,
				state
			}, () => handle_remote_form_post_internal(traced_event, state, manifest, id));
		}
	});
}
/**
* @param {RequestEvent} event
* @param {RequestState} state
* @param {SSRManifest} manifest
* @param {string} id
* @returns {Promise<ActionResult>}
*/
async function handle_remote_form_post_internal(event, state, manifest, id) {
	const [hash, name, action_id] = id.split("/");
	let form = (await manifest._.remotes[hash]?.())?.default[name];
	if (!form) {
		event.setHeaders({ allow: "GET" });
		return {
			type: "error",
			error: new SvelteKitError(405, "Method Not Allowed", `POST method not allowed. No form actions exist for this page`)
		};
	}
	if (action_id) form = with_request_store({
		event,
		state
	}, () => form.for(JSON.parse(action_id)));
	try {
		const fn = form.__.fn;
		const { data, meta, form_data } = await deserialize_binary_form(event.request);
		if (action_id && !("id" in data)) data.id = JSON.parse(decodeURIComponent(action_id));
		await with_request_store({
			event,
			state
		}, () => fn(data, meta, form_data));
		return {
			type: "success",
			status: 200
		};
	} catch (e) {
		const err = normalize_error(e);
		if (err instanceof Redirect) return {
			type: "redirect",
			status: err.status,
			location: err.location
		};
		return {
			type: "error",
			error: check_incorrect_fail_use(err)
		};
	}
}
/**
* @param {URL} url
*/
function get_remote_id(url) {
	return url.pathname.startsWith(`${base}/_app/remote/`) && url.pathname.replace(`${base}/_app/remote/`, "");
}
/**
* @param {URL} url
*/
function get_remote_action(url) {
	return url.searchParams.get("/remote");
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/page/index.js
/**
* The maximum request depth permitted before assuming we're stuck in an infinite loop
*/
var MAX_DEPTH = 10;
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} event_state
* @param {import('types').PageNodeIndexes} page
* @param {import('types').SSROptions} options
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @param {import('types').SSRState} state
* @param {import('../../../utils/page_nodes.js').PageNodes} nodes
* @param {import('types').RequiredResolveOptions} resolve_opts
* @returns {Promise<Response>}
*/
async function render_page(event, event_state, page, options, manifest, state, nodes, resolve_opts) {
	if (state.depth > MAX_DEPTH) return text(`Not found: ${event.url.pathname}`, { status: 404 });
	if (is_action_json_request(event)) return handle_action_json_request(event, event_state, options, (await manifest._.nodes[page.leaf]())?.server);
	try {
		const leaf_node = nodes.page();
		let status = 200;
		/** @type {import('@sveltejs/kit').ActionResult | undefined} */
		let action_result = void 0;
		if (is_action_request(event)) {
			const remote_id = get_remote_action(event.url);
			if (remote_id) action_result = await handle_remote_form_post(event, event_state, manifest, remote_id);
			else action_result = await handle_action_request(event, event_state, leaf_node.server);
			if (action_result?.type === "redirect") return redirect_response(action_result.status, action_result.location);
			if (action_result?.type === "error") status = get_status(action_result.error);
			if (action_result?.type === "failure") status = action_result.status;
		}
		const should_prerender = nodes.prerender();
		if (should_prerender) {
			if (leaf_node.server?.actions) throw new Error("Cannot prerender pages with actions");
		} else if (state.prerendering) return new Response(void 0, { status: 204 });
		state.prerender_default = should_prerender;
		const should_prerender_data = nodes.should_prerender_data();
		const data_pathname = add_data_suffix(event.url.pathname);
		/** @type {import('./types.js').Fetched[]} */
		const fetched = [];
		const ssr = nodes.ssr();
		const csr = nodes.csr();
		if (ssr === false && !(state.prerendering && should_prerender_data)) return await render_response({
			branch: [],
			fetched,
			page_config: {
				ssr: false,
				csr
			},
			status,
			error: null,
			event,
			event_state,
			options,
			manifest,
			state,
			resolve_opts,
			data_serializer: server_data_serializer(event, event_state, options)
		});
		/** @type {Array<import('./types.js').Loaded | null>} */
		const branch = [];
		/** @type {Error | null} */
		let load_error = null;
		const data_serializer = server_data_serializer(event, event_state, options);
		const data_serializer_json = state.prerendering && should_prerender_data ? server_data_serializer_json(event, event_state, options) : null;
		/** @type {Array<Promise<import('types').ServerDataNode | null>>} */
		const server_promises = nodes.data.map((node, i) => {
			if (load_error) throw load_error;
			return Promise.resolve().then(async () => {
				try {
					if (node === leaf_node && action_result?.type === "error") throw action_result.error;
					const server_data = await load_server_data({
						event,
						event_state,
						state,
						node,
						parent: async () => {
							/** @type {Record<string, any>} */
							const data = {};
							for (let j = 0; j < i; j += 1) {
								const parent = await server_promises[j];
								if (parent) Object.assign(data, parent.data);
							}
							return data;
						}
					});
					if (node) data_serializer.add_node(i, server_data);
					data_serializer_json?.add_node(i, server_data);
					return server_data;
				} catch (e) {
					load_error = e;
					throw load_error;
				}
			});
		});
		/** @type {Array<Promise<Record<string, any> | null>>} */
		const load_promises = nodes.data.map((node, i) => {
			if (load_error) throw load_error;
			return Promise.resolve().then(async () => {
				try {
					return await load_data({
						event,
						event_state,
						fetched,
						node,
						parent: async () => {
							const data = {};
							for (let j = 0; j < i; j += 1) Object.assign(data, await load_promises[j]);
							return data;
						},
						resolve_opts,
						server_data_promise: server_promises[i],
						state,
						csr
					});
				} catch (e) {
					load_error = e;
					throw load_error;
				}
			});
		});
		for (const p of server_promises) p.catch(noop);
		for (const p of load_promises) p.catch(noop);
		for (let i = 0; i < nodes.data.length; i += 1) {
			const node = nodes.data[i];
			if (node) try {
				const server_data = await server_promises[i];
				const data = await load_promises[i];
				branch.push({
					node,
					server_data,
					data
				});
			} catch (e) {
				const err = normalize_error(e);
				if (err instanceof Redirect) {
					if (state.prerendering && should_prerender_data) {
						const body = JSON.stringify({
							type: "redirect",
							location: err.location
						});
						state.prerendering.dependencies.set(data_pathname, {
							response: text(body),
							body
						});
					}
					return redirect_response(err.status, err.location);
				}
				const status = get_status(err);
				const error = await handle_error_and_jsonify(event, event_state, options, err);
				while (i--) if (page.errors[i]) {
					const index = page.errors[i];
					const node = await manifest._.nodes[index]();
					let j = i;
					while (!branch[j]) j -= 1;
					data_serializer.set_max_nodes(j + 1);
					const layouts = compact(branch.slice(0, j + 1));
					const nodes = new PageNodes(layouts.map((layout) => layout.node));
					const error_branch = layouts.concat({
						node,
						data: null,
						server_data: null
					});
					return await render_response({
						event,
						event_state,
						options,
						manifest,
						state,
						resolve_opts,
						page_config: {
							ssr: nodes.ssr(),
							csr: nodes.csr()
						},
						status,
						error,
						error_components: await load_error_components(options, ssr, error_branch, page, manifest),
						branch: error_branch,
						fetched,
						data_serializer
					});
				}
				return static_error_page(options, status, error.message);
			}
			else branch.push(null);
		}
		if (state.prerendering && data_serializer_json) {
			let { data, chunks } = data_serializer_json.get_data();
			if (chunks) for await (const chunk of chunks) data += chunk;
			state.prerendering.dependencies.set(data_pathname, {
				response: text(data),
				body: data
			});
		}
		return await render_response({
			event,
			event_state,
			options,
			manifest,
			state,
			resolve_opts,
			page_config: {
				csr,
				ssr
			},
			status,
			error: null,
			branch: !ssr ? [] : compact(branch),
			action_result,
			fetched,
			data_serializer: !ssr ? server_data_serializer(event, event_state, options) : data_serializer,
			error_components: await load_error_components(options, ssr, branch, page, manifest)
		});
	} catch (e) {
		if (e instanceof Redirect) return redirect_response(e.status, e.location);
		return await respond_with_error({
			event,
			event_state,
			options,
			manifest,
			state,
			status: e instanceof HttpError ? e.status : 500,
			error: e,
			resolve_opts
		});
	}
}
/**
*
* @param {import('types').SSROptions} options
* @param {boolean} ssr
* @param {Array<import('./types.js').Loaded | null>} branch
* @param {import('types').PageNodeIndexes} page
* @param {import('@sveltejs/kit').SSRManifest} manifest
*/
async function load_error_components(options, ssr, branch, page, manifest) {
	/** @type {Array<import('types').SSRComponent | undefined> | undefined} */
	let error_components;
	if (options.server_error_boundaries && ssr) {
		let last_idx = -1;
		error_components = await Promise.all(branch.map((b, i) => {
			if (i === 0) return void 0;
			if (!b) return null;
			i--;
			while (i > last_idx + 1 && page.errors[i] === void 0) i -= 1;
			last_idx = i;
			const idx = page.errors[i];
			if (idx == null) return void 0;
			return manifest._.nodes[idx]?.().then((e) => e.component?.()).catch(() => void 0);
		}).filter((e) => e !== null));
	}
	return error_components;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/data/index.js
/**
* @param {import('@sveltejs/kit').RequestEvent} event
* @param {import('types').RequestState} event_state
* @param {import('types').SSRRoute} route
* @param {import('types').SSROptions} options
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @param {import('types').SSRState} state
* @param {boolean[] | undefined} invalidated_data_nodes
* @param {import('types').TrailingSlash} trailing_slash
* @returns {Promise<Response>}
*/
async function render_data(event, event_state, route, options, manifest, state, invalidated_data_nodes, trailing_slash) {
	if (!route.page) return new Response(void 0, { status: 404 });
	try {
		const node_ids = [...route.page.layouts, route.page.leaf];
		const invalidated = invalidated_data_nodes ?? node_ids.map(() => true);
		let aborted = false;
		const url = new URL(event.url);
		url.pathname = normalize_path(url.pathname, trailing_slash);
		const new_event = {
			...event,
			url
		};
		const functions = node_ids.map((n, i) => {
			return once(async () => {
				try {
					if (aborted) return { type: "skip" };
					return load_server_data({
						event: new_event,
						event_state,
						state,
						node: n == void 0 ? n : await manifest._.nodes[n](),
						parent: async () => {
							/** @type {Record<string, any>} */
							const data = {};
							for (let j = 0; j < i; j += 1) {
								const parent = await functions[j]();
								if (parent) Object.assign(data, parent.data);
							}
							return data;
						}
					});
				} catch (e) {
					aborted = true;
					throw e;
				}
			});
		});
		const promises = functions.map(async (fn, i) => {
			if (!invalidated[i]) return { type: "skip" };
			return fn();
		});
		let length = promises.length;
		const nodes = await Promise.all(promises.map((p, i) => p.catch(async (error) => {
			if (error instanceof Redirect) throw error;
			length = Math.min(length, i + 1);
			return {
				type: "error",
				error: await handle_error_and_jsonify(event, event_state, options, error),
				status: error instanceof HttpError || error instanceof SvelteKitError ? error.status : void 0
			};
		})));
		const data_serializer = server_data_serializer_json(event, event_state, options);
		for (let i = 0; i < nodes.length; i++) data_serializer.add_node(i, nodes[i]);
		const { data, chunks } = data_serializer.get_data();
		if (!chunks) return json_response(data);
		return new Response(new ReadableStream({
			async start(controller) {
				controller.enqueue(text_encoder.encode(data));
				for await (const chunk of chunks) controller.enqueue(text_encoder.encode(chunk));
				controller.close();
			},
			type: "bytes"
		}), { headers: {
			"content-type": "text/sveltekit-data",
			"cache-control": "private, no-store"
		} });
	} catch (e) {
		const error = normalize_error(e);
		if (error instanceof Redirect) return redirect_json_response(error);
		else return json_response(await handle_error_and_jsonify(event, event_state, options, error), 500);
	}
}
/**
* @param {Record<string, any> | string} json
* @param {number} [status]
*/
function json_response(json, status = 200) {
	return text(typeof json === "string" ? json : JSON.stringify(json), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "private, no-store"
		}
	});
}
/**
* @param {Redirect} redirect
*/
function redirect_json_response(redirect) {
	return json_response({
		type: "redirect",
		location: redirect.location
	});
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/cookie.js
var import_cookie = (/* @__PURE__ */ __commonJSMin(((exports$1) => {
	/**
	* Module exports.
	* @public
	*/
	exports$1.parse = parse;
	exports$1.serialize = serialize;
	/**
	* Module variables.
	* @private
	*/
	var __toString = Object.prototype.toString;
	/**
	* RegExp to match field-content in RFC 7230 sec 3.2
	*
	* field-content = field-vchar [ 1*( SP / HTAB ) field-vchar ]
	* field-vchar   = VCHAR / obs-text
	* obs-text      = %x80-FF
	*/
	var fieldContentRegExp = /^[\u0009\u0020-\u007e\u0080-\u00ff]+$/;
	/**
	* Parse a cookie header.
	*
	* Parse the given cookie header string into an object
	* The object has the various cookies as keys(names) => values
	*
	* @param {string} str
	* @param {object} [options]
	* @return {object}
	* @public
	*/
	function parse(str, options) {
		if (typeof str !== "string") throw new TypeError("argument str must be a string");
		var obj = {};
		var dec = (options || {}).decode || decode;
		var index = 0;
		while (index < str.length) {
			var eqIdx = str.indexOf("=", index);
			if (eqIdx === -1) break;
			var endIdx = str.indexOf(";", index);
			if (endIdx === -1) endIdx = str.length;
			else if (endIdx < eqIdx) {
				index = str.lastIndexOf(";", eqIdx - 1) + 1;
				continue;
			}
			var key = str.slice(index, eqIdx).trim();
			if (void 0 === obj[key]) {
				var val = str.slice(eqIdx + 1, endIdx).trim();
				if (val.charCodeAt(0) === 34) val = val.slice(1, -1);
				obj[key] = tryDecode(val, dec);
			}
			index = endIdx + 1;
		}
		return obj;
	}
	/**
	* Serialize data into a cookie header.
	*
	* Serialize the a name value pair into a cookie string suitable for
	* http headers. An optional options object specified cookie parameters.
	*
	* serialize('foo', 'bar', { httpOnly: true })
	*   => "foo=bar; httpOnly"
	*
	* @param {string} name
	* @param {string} val
	* @param {object} [options]
	* @return {string}
	* @public
	*/
	function serialize(name, val, options) {
		var opt = options || {};
		var enc = opt.encode || encode;
		if (typeof enc !== "function") throw new TypeError("option encode is invalid");
		if (!fieldContentRegExp.test(name)) throw new TypeError("argument name is invalid");
		var value = enc(val);
		if (value && !fieldContentRegExp.test(value)) throw new TypeError("argument val is invalid");
		var str = name + "=" + value;
		if (null != opt.maxAge) {
			var maxAge = opt.maxAge - 0;
			if (isNaN(maxAge) || !isFinite(maxAge)) throw new TypeError("option maxAge is invalid");
			str += "; Max-Age=" + Math.floor(maxAge);
		}
		if (opt.domain) {
			if (!fieldContentRegExp.test(opt.domain)) throw new TypeError("option domain is invalid");
			str += "; Domain=" + opt.domain;
		}
		if (opt.path) {
			if (!fieldContentRegExp.test(opt.path)) throw new TypeError("option path is invalid");
			str += "; Path=" + opt.path;
		}
		if (opt.expires) {
			var expires = opt.expires;
			if (!isDate(expires) || isNaN(expires.valueOf())) throw new TypeError("option expires is invalid");
			str += "; Expires=" + expires.toUTCString();
		}
		if (opt.httpOnly) str += "; HttpOnly";
		if (opt.secure) str += "; Secure";
		if (opt.partitioned) str += "; Partitioned";
		if (opt.priority) switch (typeof opt.priority === "string" ? opt.priority.toLowerCase() : opt.priority) {
			case "low":
				str += "; Priority=Low";
				break;
			case "medium":
				str += "; Priority=Medium";
				break;
			case "high":
				str += "; Priority=High";
				break;
			default: throw new TypeError("option priority is invalid");
		}
		if (opt.sameSite) switch (typeof opt.sameSite === "string" ? opt.sameSite.toLowerCase() : opt.sameSite) {
			case true:
				str += "; SameSite=Strict";
				break;
			case "lax":
				str += "; SameSite=Lax";
				break;
			case "strict":
				str += "; SameSite=Strict";
				break;
			case "none":
				str += "; SameSite=None";
				break;
			default: throw new TypeError("option sameSite is invalid");
		}
		return str;
	}
	/**
	* URL-decode string value. Optimized to skip native call when no %.
	*
	* @param {string} str
	* @returns {string}
	*/
	function decode(str) {
		return str.indexOf("%") !== -1 ? decodeURIComponent(str) : str;
	}
	/**
	* URL-encode value.
	*
	* @param {string} val
	* @returns {string}
	*/
	function encode(val) {
		return encodeURIComponent(val);
	}
	/**
	* Determine if value is a Date.
	*
	* @param {*} val
	* @private
	*/
	function isDate(val) {
		return __toString.call(val) === "[object Date]" || val instanceof Date;
	}
	/**
	* Try decoding a string using a decoding function.
	*
	* @param {string} str
	* @param {function} decode
	* @private
	*/
	function tryDecode(str, decode) {
		try {
			return decode(str);
		} catch (e) {
			return str;
		}
	}
})))();
var INVALID_COOKIE_CHARACTER_REGEX = /[\x00-\x1F\x7F()<>@,;:"/[\]?={} \t]/;
/** @param {import('./page/types.js').Cookie['options']} options */
function validate_options(options) {
	if (options?.path === void 0) throw new Error("You must specify a `path` when setting, deleting or serializing cookies");
}
/**
* Generates a unique key for a cookie based on its domain, path, and name in
* the format: `<domain>/<path>?<name>`.
* If domain is undefined, it will be omitted.
* For example: `/?name`, `example.com/foo?name`.
*
* @param {string | undefined} domain
* @param {string} path
* @param {string} name
* @returns {string}
*/
function generate_cookie_key(domain, path, name) {
	return `${domain || ""}${path}?${encodeURIComponent(name)}`;
}
/**
* @param {Request} request
* @param {URL} url
*/
function get_cookies(request, url) {
	const header = request.headers.get("cookie") ?? "";
	const initial_cookies = (0, import_cookie.parse)(header, { decode: (value) => value });
	/** @type {string | undefined} */
	let normalized_url;
	/** @type {Map<string, import('./page/types.js').Cookie>} */
	const new_cookies = /* @__PURE__ */ new Map();
	/** @type {import('cookie').CookieSerializeOptions} */
	const defaults = {
		httpOnly: true,
		sameSite: "lax",
		secure: url.hostname === "localhost" && url.protocol === "http:" ? false : true
	};
	/** @type {import('@sveltejs/kit').Cookies} */
	const cookies = {
		get(name, opts) {
			const best_match = Array.from(new_cookies.values()).filter((c) => {
				return c.name === name && domain_matches(url.hostname, c.options.domain) && path_matches(url.pathname, c.options.path);
			}).sort((a, b) => b.options.path.length - a.options.path.length)[0];
			if (best_match) return best_match.options.maxAge === 0 ? void 0 : best_match.value;
			return (0, import_cookie.parse)(header, { decode: opts?.decode })[name];
		},
		getAll(opts) {
			const cookies = (0, import_cookie.parse)(header, { decode: opts?.decode });
			const lookup = /* @__PURE__ */ new Map();
			for (const c of new_cookies.values()) if (domain_matches(url.hostname, c.options.domain) && path_matches(url.pathname, c.options.path)) {
				const existing = lookup.get(c.name);
				if (!existing || c.options.path.length > existing.options.path.length) lookup.set(c.name, c);
			}
			for (const c of lookup.values()) cookies[c.name] = c.value;
			return Object.entries(cookies).map(([name, value]) => ({
				name,
				value
			}));
		},
		set(name, value, options) {
			const illegal_characters = name.match(INVALID_COOKIE_CHARACTER_REGEX);
			if (illegal_characters) console.warn(`The cookie name "${name}" will be invalid in SvelteKit 3.0 as it contains ${illegal_characters.join(" and ")}. See RFC 2616 for more details https://datatracker.ietf.org/doc/html/rfc2616#section-2.2`);
			validate_options(options);
			set_internal(name, value, {
				...defaults,
				...options
			});
		},
		delete(name, options) {
			validate_options(options);
			cookies.set(name, "", {
				...options,
				maxAge: 0
			});
		},
		serialize(name, value, options) {
			validate_options(options);
			let path = options.path;
			if (!options.domain || options.domain === url.hostname) {
				if (!normalized_url) throw new Error("Cannot serialize cookies until after the route is determined");
				path = resolve(normalized_url, path);
			}
			return (0, import_cookie.serialize)(name, value, {
				...defaults,
				...options,
				path
			});
		}
	};
	/**
	* @param {URL} destination
	* @param {string | null} header
	*/
	function get_cookie_header(destination, header) {
		/** @type {Record<string, string>} */
		const combined_cookies = { ...initial_cookies };
		for (const cookie of new_cookies.values()) {
			if (!domain_matches(destination.hostname, cookie.options.domain)) continue;
			if (!path_matches(destination.pathname, cookie.options.path)) continue;
			const encoder = cookie.options.encode || encodeURIComponent;
			combined_cookies[cookie.name] = encoder(cookie.value);
		}
		if (header) {
			const parsed = (0, import_cookie.parse)(header, { decode: (value) => value });
			for (const name in parsed) combined_cookies[name] = parsed[name];
		}
		return Object.entries(combined_cookies).map(([name, value]) => `${name}=${value}`).join("; ");
	}
	/** @type {Array<() => void>} */
	const internal_queue = [];
	/**
	* @param {string} name
	* @param {string} value
	* @param {import('./page/types.js').Cookie['options']} options
	*/
	function set_internal(name, value, options) {
		if (!normalized_url) {
			internal_queue.push(() => set_internal(name, value, options));
			return;
		}
		let path = options.path;
		if (!options.domain || options.domain === url.hostname) path = resolve(normalized_url, path);
		const cookie_key = generate_cookie_key(options.domain, path, name);
		const cookie = {
			name,
			value,
			options: {
				...options,
				path
			}
		};
		new_cookies.set(cookie_key, cookie);
	}
	/**
	* @param {import('types').TrailingSlash} trailing_slash
	*/
	function set_trailing_slash(trailing_slash) {
		normalized_url = normalize_path(url.pathname, trailing_slash);
		internal_queue.forEach((fn) => fn());
	}
	return {
		cookies,
		new_cookies,
		get_cookie_header,
		set_internal,
		set_trailing_slash
	};
}
/**
* @param {string} hostname
* @param {string} [constraint]
*/
function domain_matches(hostname, constraint) {
	if (!constraint) return true;
	const normalized = constraint[0] === "." ? constraint.slice(1) : constraint;
	if (hostname === normalized) return true;
	return hostname.endsWith("." + normalized);
}
/**
* @param {string} path
* @param {string} [constraint]
*/
function path_matches(path, constraint) {
	if (!constraint) return true;
	const normalized = constraint.endsWith("/") ? constraint.slice(0, -1) : constraint;
	if (path === normalized) return true;
	return path.startsWith(normalized + "/");
}
/**
* @param {Headers} headers
* @param {MapIterator<import('./page/types.js').Cookie>} cookies
*/
function add_cookies_to_headers(headers, cookies) {
	for (const new_cookie of cookies) {
		const { name, value, options } = new_cookie;
		headers.append("set-cookie", (0, import_cookie.serialize)(name, value, options));
		if (options.path.endsWith(".html")) {
			const path = add_data_suffix(options.path);
			headers.append("set-cookie", (0, import_cookie.serialize)(name, value, {
				...options,
				path
			}));
		}
	}
}
//#endregion
//#region ../../node_modules/.pnpm/set-cookie-parser@3.1.0/node_modules/set-cookie-parser/lib/set-cookie.js
var defaultParseOptions = {
	decodeValues: true,
	map: false,
	silent: false,
	split: "auto"
};
function isForbiddenKey(key) {
	return typeof key !== "string" || key in {};
}
function createNullObj() {
	return Object.create(null);
}
function isNonEmptyString(str) {
	return typeof str === "string" && !!str.trim();
}
function parseString(setCookieValue, options) {
	var parts = setCookieValue.split(";").filter(isNonEmptyString);
	var parsed = parseNameValuePair(parts.shift());
	var name = parsed.name;
	var value = parsed.value;
	options = options ? Object.assign({}, defaultParseOptions, options) : defaultParseOptions;
	if (isForbiddenKey(name)) return null;
	try {
		value = options.decodeValues ? decodeURIComponent(value) : value;
	} catch (e) {
		console.error("set-cookie-parser: failed to decode cookie value. Set options.decodeValues=false to disable decoding.", e);
	}
	var cookie = createNullObj();
	cookie.name = name;
	cookie.value = value;
	parts.forEach(function(part) {
		var sides = part.split("=");
		var key = sides.shift().trimLeft().toLowerCase();
		if (isForbiddenKey(key)) return;
		var value = sides.join("=");
		if (key === "expires") cookie.expires = new Date(value);
		else if (key === "max-age") {
			var n = parseInt(value, 10);
			if (!Number.isNaN(n)) cookie.maxAge = n;
		} else if (key === "secure") cookie.secure = true;
		else if (key === "httponly") cookie.httpOnly = true;
		else if (key === "samesite") cookie.sameSite = value;
		else if (key === "partitioned") cookie.partitioned = true;
		else if (key) cookie[key] = value;
	});
	return cookie;
}
function parseNameValuePair(nameValuePairStr) {
	var name = "";
	var value = "";
	var nameValueArr = nameValuePairStr.split("=");
	if (nameValueArr.length > 1) {
		name = nameValueArr.shift();
		value = nameValueArr.join("=");
	} else value = nameValuePairStr;
	return {
		name,
		value
	};
}
function parseSetCookie(input, options) {
	options = options ? Object.assign({}, defaultParseOptions, options) : defaultParseOptions;
	if (!input) if (!options.map) return [];
	else return createNullObj();
	if (input.headers) if (typeof input.headers.getSetCookie === "function") input = input.headers.getSetCookie();
	else if (input.headers["set-cookie"]) input = input.headers["set-cookie"];
	else {
		var sch = input.headers[Object.keys(input.headers).find(function(key) {
			return key.toLowerCase() === "set-cookie";
		})];
		if (!sch && input.headers.cookie && !options.silent) console.warn("Warning: set-cookie-parser appears to have been called on a request object. It is designed to parse Set-Cookie headers from responses, not Cookie headers from requests. Set the option {silent: true} to suppress this warning.");
		input = sch;
	}
	var split = options.split;
	var isArray = Array.isArray(input);
	if (split === "auto") split = !isArray;
	if (!isArray) input = [input];
	input = input.filter(isNonEmptyString);
	if (split) input = input.map(splitCookiesString).flat();
	if (!options.map) return input.map(function(str) {
		return parseString(str, options);
	}).filter(Boolean);
	else {
		var cookies = createNullObj();
		return input.reduce(function(cookies, str) {
			var cookie = parseString(str, options);
			if (cookie && !isForbiddenKey(cookie.name)) cookies[cookie.name] = cookie;
			return cookies;
		}, cookies);
	}
}
function splitCookiesString(cookiesString) {
	if (Array.isArray(cookiesString)) return cookiesString;
	if (typeof cookiesString !== "string") return [];
	var cookiesStrings = [];
	var pos = 0;
	var start;
	var ch;
	var lastComma;
	var nextStart;
	var cookiesSeparatorFound;
	function skipWhitespace() {
		while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))) pos += 1;
		return pos < cookiesString.length;
	}
	function notSpecialChar() {
		ch = cookiesString.charAt(pos);
		return ch !== "=" && ch !== ";" && ch !== ",";
	}
	while (pos < cookiesString.length) {
		start = pos;
		cookiesSeparatorFound = false;
		while (skipWhitespace()) {
			ch = cookiesString.charAt(pos);
			if (ch === ",") {
				lastComma = pos;
				pos += 1;
				skipWhitespace();
				nextStart = pos;
				while (pos < cookiesString.length && notSpecialChar()) pos += 1;
				if (pos < cookiesString.length && cookiesString.charAt(pos) === "=") {
					cookiesSeparatorFound = true;
					pos = nextStart;
					cookiesStrings.push(cookiesString.substring(start, lastComma));
					start = pos;
				} else pos = lastComma + 1;
			} else pos += 1;
		}
		if (!cookiesSeparatorFound || pos >= cookiesString.length) cookiesStrings.push(cookiesString.substring(start, cookiesString.length));
	}
	return cookiesStrings;
}
parseSetCookie.parseSetCookie = parseSetCookie;
parseSetCookie.parse = parseSetCookie;
parseSetCookie.parseString = parseString;
parseSetCookie.splitCookiesString = splitCookiesString;
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/fetch.js
/**
* @param {{
*   event: import('@sveltejs/kit').RequestEvent;
*   options: import('types').SSROptions;
*   manifest: import('@sveltejs/kit').SSRManifest;
*   state: import('types').SSRState;
*   get_cookie_header: (url: URL, header: string | null) => string;
*   set_internal: (name: string, value: string, opts: import('./page/types.js').Cookie['options']) => void;
* }} opts
* @returns {typeof fetch}
*/
function create_fetch({ event, options, manifest, state, get_cookie_header, set_internal }) {
	/**
	* @type {typeof fetch}
	*/
	const server_fetch = async (info, init) => {
		const original_request = normalize_fetch_input(info, init, event.url);
		let mode = (info instanceof Request ? info.mode : init?.mode) ?? "cors";
		let credentials = (info instanceof Request ? info.credentials : init?.credentials) ?? "same-origin";
		return options.hooks.handleFetch({
			event,
			request: original_request,
			fetch: async (info, init) => {
				const request = normalize_fetch_input(info, init, event.url);
				const url = new URL(request.url);
				if (!request.headers.has("origin")) request.headers.set("origin", event.url.origin);
				if (info !== original_request) {
					mode = (info instanceof Request ? info.mode : init?.mode) ?? "cors";
					credentials = (info instanceof Request ? info.credentials : init?.credentials) ?? "same-origin";
				}
				if ((request.method === "GET" || request.method === "HEAD") && (mode === "no-cors" && url.origin !== event.url.origin || url.origin === event.url.origin)) request.headers.delete("origin");
				const decoded = decodeURIComponent(url.pathname);
				if (url.origin !== event.url.origin || base && decoded !== base && !decoded.startsWith(`${base}/`)) {
					if (`.${url.hostname}`.endsWith(`.${event.url.hostname}`) && credentials !== "omit") {
						const cookie = get_cookie_header(url, request.headers.get("cookie"));
						if (cookie) request.headers.set("cookie", cookie);
					}
					return fetch(request);
				}
				const prefix = assets || base;
				const filename = (decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded).slice(1);
				const filename_html = `${filename}/index.html`;
				const is_asset = manifest.assets.has(filename) || filename in manifest._.server_assets;
				const is_asset_html = manifest.assets.has(filename_html) || filename_html in manifest._.server_assets;
				if (is_asset || is_asset_html) {
					const file = is_asset ? filename : filename_html;
					if (state.read) {
						const type = is_asset ? manifest.mimeTypes[filename.slice(filename.lastIndexOf("."))] : "text/html";
						return new Response(state.read(file), { headers: type ? { "content-type": type } : {} });
					} else if (read_implementation && file in manifest._.server_assets) {
						const length = manifest._.server_assets[file];
						const type = manifest.mimeTypes[file.slice(file.lastIndexOf("."))];
						return new Response(read_implementation(file), { headers: {
							"Content-Length": "" + length,
							"Content-Type": type
						} });
					}
					return await fetch(request);
				}
				if (has_prerendered_path(manifest, base + decoded)) return await fetch(request);
				if (credentials !== "omit") {
					const cookie = get_cookie_header(url, request.headers.get("cookie"));
					if (cookie) request.headers.set("cookie", cookie);
					const authorization = event.request.headers.get("authorization");
					if (authorization && !request.headers.has("authorization")) request.headers.set("authorization", authorization);
				}
				if (!request.headers.has("accept")) request.headers.set("accept", "*/*");
				if (!request.headers.has("accept-language")) request.headers.set("accept-language", event.request.headers.get("accept-language"));
				const response = await internal_fetch(request, options, manifest, state);
				const set_cookie = response.headers.get("set-cookie");
				if (set_cookie) for (const str of splitCookiesString(set_cookie)) {
					const { name, value, ...options } = parseString(str, { decodeValues: false });
					set_internal(name, value, {
						path: options.path ?? (url.pathname.split("/").slice(0, -1).join("/") || "/"),
						encode: (value) => value,
						...options
					});
				}
				return response;
			}
		});
	};
	return (input, init) => {
		const response = server_fetch(input, init);
		response.catch(noop);
		return response;
	};
}
/**
* @param {RequestInfo | URL} info
* @param {RequestInit | undefined} init
* @param {URL} url
*/
function normalize_fetch_input(info, init, url) {
	if (info instanceof Request) return info;
	return new Request(typeof info === "string" ? new URL(info, url) : info, init);
}
/**
* @param {Request} request
* @param {import('types').SSROptions} options
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @param {import('types').SSRState} state
* @returns {Promise<Response>}
*/
async function internal_fetch(request, options, manifest, state) {
	if (request.signal) {
		if (request.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
		let remove_abort_listener = noop;
		/** @type {Promise<never>} */
		const abort_promise = new Promise((_, reject) => {
			const on_abort = () => {
				reject(new DOMException("The operation was aborted.", "AbortError"));
			};
			request.signal.addEventListener("abort", on_abort, { once: true });
			remove_abort_listener = () => request.signal.removeEventListener("abort", on_abort);
		});
		const result = await Promise.race([respond(request, options, manifest, {
			...state,
			depth: state.depth + 1
		}), abort_promise]);
		remove_abort_listener();
		return result;
	} else return await respond(request, options, manifest, {
		...state,
		depth: state.depth + 1
	});
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/env_module.js
/** @type {string} */
var body;
/** @type {string} */
var etag;
/** @type {Headers} */
var headers;
/**
* @param {Request} request
* @returns {Response}
*/
function get_public_env(request) {
	body ??= `export const env=${JSON.stringify(public_env)}`;
	etag ??= `W/${Date.now()}`;
	headers ??= new Headers({
		"content-type": "application/javascript; charset=utf-8",
		etag
	});
	if (request.headers.get("if-none-match") === etag) return new Response(void 0, {
		status: 304,
		headers
	});
	return new Response(body, { headers });
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/respond.js
/** @import { RequestState } from 'types' */
/** @type {import('types').RequiredResolveOptions['transformPageChunk']} */
var default_transform = ({ html }) => html;
/** @type {import('types').RequiredResolveOptions['filterSerializedResponseHeaders']} */
var default_filter = () => false;
/** @type {import('types').RequiredResolveOptions['preload']} */
var default_preload = ({ type }) => type === "js" || type === "css";
var page_methods = new Set([
	"GET",
	"HEAD",
	"POST"
]);
var allowed_page_methods = new Set([
	"GET",
	"HEAD",
	"OPTIONS"
]);
var respond = propagate_context(internal_respond);
/**
* @param {Request} request
* @param {import('types').SSROptions} options
* @param {import('@sveltejs/kit').SSRManifest} manifest
* @param {import('types').SSRState} state
* @returns {Promise<Response>}
*/
async function internal_respond(request, options, manifest, state) {
	/** URL but stripped from the potential `/__data.json` suffix and its search param  */
	const url = new URL(request.url);
	const is_route_resolution_request = has_resolution_suffix(url.pathname);
	const is_data_request = has_data_suffix(url.pathname);
	const remote_id = get_remote_id(url);
	{
		const request_origin = request.headers.get("origin");
		if (remote_id) {
			if (request.method !== "GET" && request_origin !== url.origin) return json({ message: "Cross-site remote requests are forbidden" }, { status: 403 });
		} else if (options.csrf_check_origin) {
			if (is_form_content_type(request) && (request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE") && request_origin !== url.origin && (!request_origin || !options.csrf_trusted_origins.includes(request_origin))) {
				const message = `Cross-site ${request.method} form submissions are forbidden`;
				const opts = { status: 403 };
				if (request.headers.get("accept") === "application/json") return json({ message }, opts);
				return text(message, opts);
			}
		}
	}
	if (options.hash_routing && url.pathname !== base + "/" && url.pathname !== "/[fallback]") return text("Not found", { status: 404 });
	/** @type {boolean[] | undefined} */
	let invalidated_data_nodes;
	if (is_route_resolution_request)
 /**
	* If the request is for a route resolution, first modify the URL, then continue as normal
	* for path resolution, then return the route object as a JS file.
	*/
	url.pathname = strip_resolution_suffix(url.pathname);
	else if (is_data_request) {
		url.pathname = strip_data_suffix(url.pathname) + (url.searchParams.get("x-sveltekit-trailing-slash") === "1" ? "/" : "") || "/";
		url.searchParams.delete(TRAILING_SLASH_PARAM);
		invalidated_data_nodes = url.searchParams.get(INVALIDATED_PARAM)?.split("").map((node) => node === "1");
		url.searchParams.delete(INVALIDATED_PARAM);
	} else if (remote_id) {
		url.pathname = request.headers.get("x-sveltekit-pathname") ?? base;
		url.search = request.headers.get("x-sveltekit-search") ?? "";
	}
	/** @type {Record<string, string>} */
	const headers = {};
	const { cookies, new_cookies, get_cookie_header, set_internal, set_trailing_slash } = get_cookies(request, url);
	/** @type {RequestState} */
	const event_state = {
		prerendering: state.prerendering,
		transport: options.hooks.transport,
		handleValidationError: options.hooks.handleValidationError,
		tracing: { record_span },
		remote: {
			data: null,
			forms: null,
			refreshes: null,
			requested: null,
			validated: null
		},
		is_in_remote_function: false,
		is_in_render: false,
		is_in_universal_load: false
	};
	/** @type {import('@sveltejs/kit').RequestEvent} */
	const event = {
		cookies,
		fetch: null,
		getClientAddress: state.getClientAddress || (() => {
			throw new Error(`@sveltejs/adapter-node does not specify getClientAddress. Please raise an issue`);
		}),
		locals: {},
		params: {},
		platform: state.platform,
		request,
		route: { id: null },
		setHeaders: (new_headers) => {
			for (const key in new_headers) {
				const lower = key.toLowerCase();
				const value = new_headers[key];
				if (lower === "set-cookie") throw new Error("Use `event.cookies.set(name, value, options)` instead of `event.setHeaders` to set cookies");
				else if (lower in headers) if (lower === "server-timing") headers[lower] += ", " + value;
				else throw new Error(`"${key}" header is already set`);
				else {
					headers[lower] = value;
					if (state.prerendering && lower === "cache-control") state.prerendering.cache = value;
				}
			}
		},
		url,
		isDataRequest: is_data_request,
		isSubRequest: state.depth > 0,
		isRemoteRequest: !!remote_id
	};
	event.fetch = create_fetch({
		event,
		options,
		manifest,
		state,
		get_cookie_header,
		set_internal
	});
	if (state.emulator?.platform) event.platform = await state.emulator.platform({
		config: {},
		prerender: !!state.prerendering?.fallback
	});
	let resolved_path = url.pathname;
	if (!remote_id) {
		const prerendering_reroute_state = state.prerendering?.inside_reroute;
		try {
			if (state.prerendering) state.prerendering.inside_reroute = true;
			resolved_path = await options.hooks.reroute({
				url: new URL(url),
				fetch: event.fetch
			}) ?? url.pathname;
		} catch {
			return text("Internal Server Error", { status: 500 });
		} finally {
			if (state.prerendering) state.prerendering.inside_reroute = prerendering_reroute_state;
		}
	}
	try {
		resolved_path = decode_pathname(resolved_path);
	} catch {
		return text("Malformed URI", { status: 400 });
	}
	if (resolved_path !== decode_pathname(url.pathname) && !state.prerendering?.fallback && has_prerendered_path(manifest, resolved_path)) {
		const url = new URL(request.url);
		url.pathname = is_data_request ? add_data_suffix(resolved_path) : is_route_resolution_request ? add_resolution_suffix(resolved_path) : resolved_path;
		try {
			const response = await fetch(url, request);
			const headers = new Headers(response.headers);
			if (headers.has("content-encoding")) {
				headers.delete("content-encoding");
				headers.delete("content-length");
			}
			return new Response(response.body, {
				headers,
				status: response.status,
				statusText: response.statusText
			});
		} catch (error) {
			return await handle_fatal_error(event, event_state, options, error);
		}
	}
	/** @type {import('types').SSRRoute | null} */
	let route = null;
	if (base && !state.prerendering?.fallback) {
		if (!resolved_path.startsWith(base)) return text("Not found", { status: 404 });
		resolved_path = resolved_path.slice(base.length) || "/";
	}
	if (is_route_resolution_request) return resolve_route(resolved_path, new URL(request.url), manifest);
	if (resolved_path === `/_app/env.js`) return get_public_env(request);
	if (!remote_id && resolved_path.startsWith(`/_app`)) {
		const headers = new Headers();
		headers.set("cache-control", "public, max-age=0, must-revalidate");
		return text("Not found", {
			status: 404,
			headers
		});
	}
	if (!state.prerendering?.fallback) {
		const matchers = await manifest._.matchers();
		const result = find_route(resolved_path, manifest._.routes, matchers);
		if (result) {
			route = result.route;
			event.route = { id: route.id };
			event.params = result.params;
		}
	}
	/** @type {import('types').RequiredResolveOptions} */
	let resolve_opts = {
		transformPageChunk: default_transform,
		filterSerializedResponseHeaders: default_filter,
		preload: default_preload
	};
	/** @type {import('types').TrailingSlash} */
	let trailing_slash = "never";
	try {
		/** @type {PageNodes | undefined} */
		const page_nodes = route?.page ? new PageNodes(await load_page_nodes(route.page, manifest)) : void 0;
		if (route && !remote_id) {
			if (url.pathname === base || url.pathname === base + "/") trailing_slash = "always";
			else if (page_nodes) trailing_slash = page_nodes.trailing_slash();
			else if (route.endpoint) trailing_slash = (await route.endpoint()).trailingSlash ?? "never";
			if (!is_data_request) {
				const normalized = normalize_path(url.pathname, trailing_slash);
				if (normalized !== url.pathname && !state.prerendering?.fallback) return new Response(void 0, {
					status: 308,
					headers: {
						"x-sveltekit-normalize": "1",
						location: (normalized.startsWith("//") ? url.origin + normalized : normalized) + (url.search === "?" ? "" : url.search)
					}
				});
			}
			if (state.before_handle || state.emulator?.platform) {
				let config = {};
				/** @type {import('types').PrerenderOption} */
				let prerender = false;
				if (route.endpoint) {
					const node = await route.endpoint();
					config = node.config ?? config;
					prerender = node.prerender ?? prerender;
				} else if (page_nodes) {
					config = page_nodes.get_config() ?? config;
					prerender = page_nodes.prerender();
				}
				if (state.before_handle) state.before_handle(event, config, prerender);
				if (state.emulator?.platform) event.platform = await state.emulator.platform({
					config,
					prerender
				});
			}
		}
		set_trailing_slash(trailing_slash);
		if (state.prerendering && !state.prerendering.fallback && !state.prerendering.inside_reroute) disable_search(url);
		const response = await record_span({
			name: "sveltekit.handle.root",
			attributes: {
				"http.route": event.route.id || "unknown",
				"http.method": event.request.method,
				"http.url": event.url.href,
				"sveltekit.is_data_request": is_data_request,
				"sveltekit.is_sub_request": event.isSubRequest
			},
			fn: async (root_span) => {
				const traced_event = {
					...event,
					tracing: {
						enabled: false,
						root: root_span,
						current: root_span
					}
				};
				return await with_request_store({
					event: traced_event,
					state: event_state
				}, () => options.hooks.handle({
					event: traced_event,
					resolve: (event, opts) => {
						return record_span({
							name: "sveltekit.resolve",
							attributes: { "http.route": event.route.id || "unknown" },
							fn: (resolve_span) => {
								return with_request_store(null, () => resolve(merge_tracing(event, resolve_span), page_nodes, opts).then((response) => {
									for (const key in headers) {
										const value = headers[key];
										response.headers.set(key, value);
									}
									add_cookies_to_headers(response.headers, new_cookies.values());
									if (state.prerendering && event.route.id !== null) response.headers.set("x-sveltekit-routeid", encodeURI(event.route.id));
									resolve_span.setAttributes({
										"http.response.status_code": response.status,
										"http.response.body.size": response.headers.get("content-length") || "unknown"
									});
									return response;
								}));
							}
						});
					}
				}));
			}
		});
		if (response.status === 200 && response.headers.has("etag")) {
			let if_none_match_value = request.headers.get("if-none-match");
			if (if_none_match_value?.startsWith("W/\"")) if_none_match_value = if_none_match_value.substring(2);
			const etag = response.headers.get("etag");
			if (if_none_match_value === etag) {
				const headers = new Headers({ etag });
				for (const key of [
					"cache-control",
					"content-location",
					"date",
					"expires",
					"vary",
					"set-cookie"
				]) {
					const value = response.headers.get(key);
					if (value) headers.set(key, value);
				}
				return new Response(void 0, {
					status: 304,
					headers
				});
			}
		}
		if (is_data_request && response.status >= 300 && response.status <= 308) {
			const location = response.headers.get("location");
			if (location) return redirect_json_response(new Redirect(response.status, location));
		}
		return response;
	} catch (e) {
		if (e instanceof Redirect) try {
			const response = is_data_request || remote_id ? redirect_json_response(e) : route?.page && is_action_json_request(event) ? action_json_redirect(e) : redirect_response(e.status, e.location);
			add_cookies_to_headers(response.headers, new_cookies.values());
			return response;
		} catch (err) {
			return await handle_fatal_error(event, event_state, options, err);
		}
		return await handle_fatal_error(event, event_state, options, e);
	}
	/**
	* @param {import('@sveltejs/kit').RequestEvent} event
	* @param {PageNodes | undefined} page_nodes
	* @param {import('@sveltejs/kit').ResolveOptions} [opts]
	*/
	async function resolve(event, page_nodes, opts) {
		try {
			if (opts) resolve_opts = {
				transformPageChunk: opts.transformPageChunk || default_transform,
				filterSerializedResponseHeaders: opts.filterSerializedResponseHeaders || default_filter,
				preload: opts.preload || default_preload
			};
			if (options.hash_routing || state.prerendering?.fallback) return await render_response({
				event,
				event_state,
				options,
				manifest,
				state,
				page_config: {
					ssr: false,
					csr: true
				},
				status: 200,
				error: null,
				branch: [],
				fetched: [],
				resolve_opts,
				data_serializer: server_data_serializer(event, event_state, options)
			});
			if (remote_id) return await handle_remote_call(event, event_state, options, manifest, remote_id);
			if (route) {
				const method = event.request.method;
				/** @type {Response} */
				let response;
				if (is_data_request) response = await render_data(event, event_state, route, options, manifest, state, invalidated_data_nodes, trailing_slash);
				else if (route.endpoint && (!route.page || is_endpoint_request(event))) response = await render_endpoint(event, event_state, await route.endpoint(), state);
				else if (route.page) if (!page_nodes) throw new Error("page_nodes not found. This should never happen");
				else if (page_methods.has(method)) response = await render_page(event, event_state, route.page, options, manifest, state, page_nodes, resolve_opts);
				else {
					const allowed_methods = new Set(allowed_page_methods);
					if ((await manifest._.nodes[route.page.leaf]())?.server?.actions) allowed_methods.add("POST");
					if (method === "OPTIONS") response = new Response(null, {
						status: 204,
						headers: { allow: Array.from(allowed_methods.values()).join(", ") }
					});
					else response = method_not_allowed([...allowed_methods].reduce((acc, curr) => {
						acc[curr] = true;
						return acc;
					}, {}), method);
				}
				else throw new Error("Route is neither page nor endpoint. This should never happen");
				if (request.method === "GET" && route.page && route.endpoint) {
					const vary = response.headers.get("vary")?.split(",")?.map((v) => v.trim().toLowerCase());
					if (!(vary?.includes("accept") || vary?.includes("*"))) {
						response = new Response(response.body, {
							status: response.status,
							statusText: response.statusText,
							headers: new Headers(response.headers)
						});
						response.headers.append("Vary", "Accept");
					}
				}
				return response;
			}
			if (state.error && event.isSubRequest) {
				const headers = new Headers(request.headers);
				headers.set("x-sveltekit-error", "true");
				return await fetch(request, { headers });
			}
			if (state.error) return text("Internal Server Error", { status: 500 });
			if (state.depth === 0) return await respond_with_error({
				event,
				event_state,
				options,
				manifest,
				state,
				status: 404,
				error: new SvelteKitError(404, "Not Found", `Not found: ${event.url.pathname}`),
				resolve_opts
			});
			if (state.prerendering) return text("not found", { status: 404 });
			const response = await fetch(request);
			return new Response(response.body, response);
		} catch (e) {
			return await handle_fatal_error(event, event_state, options, e);
		} finally {
			event.cookies.set = () => {
				throw new Error("Cannot use `cookies.set(...)` after the response has been generated");
			};
			event.setHeaders = () => {
				throw new Error("Cannot use `setHeaders(...)` after the response has been generated");
			};
		}
	}
}
/**
* @param {import('types').PageNodeIndexes} page
* @param {import('@sveltejs/kit').SSRManifest} manifest
*/
function load_page_nodes(page, manifest) {
	return Promise.all([...page.layouts.map((n) => n == void 0 ? n : manifest._.nodes[n]()), manifest._.nodes[page.leaf]()]);
}
/**
* It's likely that, in a distributed system, there are spans starting outside the SvelteKit server -- eg.
* started on the frontend client, or in a service that calls the SvelteKit server. There are standardized
* ways to represent this context in HTTP headers, so we can extract that context and run our tracing inside of it
* so that when our traces are exported, they are associated with the correct parent context.
* @param {typeof internal_respond} fn
* @returns {typeof internal_respond}
*/
function propagate_context(fn) {
	return async (req, ...rest) => {
		return fn(req, ...rest);
	};
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/utils/env.js
/**
* @param {Record<string, string>} env
* @param {string} allowed
* @param {string} disallowed
* @returns {Record<string, string>}
*/
function filter_env(env, allowed, disallowed) {
	return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith(allowed) && (disallowed === "" || !k.startsWith(disallowed))));
}
/**
* @param {{ decoders: Record<string, (data: any) => any> }} value
*/
function set_app(value) {}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/server/index.js
/** @import { PromiseWithResolvers } from '../../utils/promise.js' */
/** @type {Promise<any>} */
var init_promise;
/** @type {Promise<void> | null} */
var current = null;
var Server = class {
	/** @type {import('types').SSROptions} */
	#options;
	/** @type {import('@sveltejs/kit').SSRManifest} */
	#manifest;
	/** @param {import('@sveltejs/kit').SSRManifest} manifest */
	constructor(manifest) {
		/** @type {import('types').SSROptions} */
		this.#options = options;
		this.#manifest = manifest;
		if (IN_WEBCONTAINER) {
			const respond = this.respond.bind(this);
			/** @type {typeof respond} */
			this.respond = async (...args) => {
				const { promise, resolve } = with_resolvers();
				const previous = current;
				current = promise;
				await previous;
				return respond(...args).finally(resolve);
			};
		}
	}
	/**
	* @param {import('@sveltejs/kit').ServerInitOptions} opts
	*/
	async init({ env, read }) {
		const { env_public_prefix, env_private_prefix } = this.#options;
		set_private_env(filter_env(env, env_private_prefix, env_public_prefix));
		set_public_env(filter_env(env, env_public_prefix, env_private_prefix));
		if (read) {
			/** @param {string} file */
			const wrapped_read = (file) => {
				const result = read(file);
				if (result instanceof ReadableStream) return result;
				else return new ReadableStream({ async start(controller) {
					try {
						const stream = await Promise.resolve(result);
						if (!stream) {
							controller.close();
							return;
						}
						const reader = stream.getReader();
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							controller.enqueue(value);
						}
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				} });
			};
			set_read_implementation(wrapped_read);
		}
		await (init_promise ??= (async () => {
			try {
				const module = await get_hooks();
				this.#options.hooks = {
					handle: module.handle || (({ event, resolve }) => resolve(event)),
					handleError: module.handleError || (({ status, error, event }) => {
						const error_message = format_server_error(status, error, event);
						console.error(error_message);
					}),
					handleFetch: module.handleFetch || (({ request, fetch }) => fetch(request)),
					handleValidationError: module.handleValidationError || (({ issues }) => {
						console.error("Remote function schema validation failed:", issues);
						return { message: "Bad Request" };
					}),
					reroute: module.reroute || noop,
					transport: module.transport || {}
				};
				set_app({ decoders: module.transport ? Object.fromEntries(Object.entries(module.transport).map(([k, v]) => [k, v.decode])) : {} });
				if (module.init) await module.init();
			} catch (e) {
				throw e;
			}
		})());
	}
	/**
	* @param {Request} request
	* @param {import('types').RequestOptions} options
	*/
	async respond(request, options) {
		return respond(request, this.#options, this.#manifest, {
			...options,
			error: false,
			depth: 0
		});
	}
};

export { Server };
//# sourceMappingURL=index.js.map
