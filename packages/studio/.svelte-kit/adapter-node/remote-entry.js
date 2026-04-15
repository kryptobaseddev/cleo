import { f as app_dir, m as base, t as prerendering } from "./chunks/environment.js";
import { b as parse, c as unfriendly_hydratable, i as parse_remote_arg, o as stringify, r as create_remote_key, s as stringify_remote_arg, x as noop } from "./chunks/shared.js";
import { _ as deep_set, a as handle_error_and_jsonify, b as normalize_issue, g as create_field_proxy, w as MUTATIVE_METHODS, x as set_nested_value, y as flatten_issues } from "./chunks/utils.js";
import { error, json } from "@sveltejs/kit";
import { HttpError, SvelteKitError, ValidationError } from "@sveltejs/kit/internal";
import { get_request_store, with_request_store } from "@sveltejs/kit/internal/server";
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/server/remote/shared.js
/** @import { RequestEvent } from '@sveltejs/kit' */
/** @import { ServerHooks, MaybePromise, RequestState, RemoteInternals, RequestStore } from 'types' */
/**
* @param {any} validate_or_fn
* @param {(arg?: any) => any} [maybe_fn]
* @returns {(arg?: any) => MaybePromise<any>}
*/
function create_validator(validate_or_fn, maybe_fn) {
	if (!maybe_fn) return (arg) => {
		if (arg !== void 0) error(400, "Bad Request");
	};
	if (validate_or_fn === "unchecked") return (arg) => arg;
	if ("~standard" in validate_or_fn) return async (arg) => {
		const { event, state } = get_request_store();
		const result = await validate_or_fn["~standard"].validate(arg);
		if (result.issues) error(400, await state.handleValidationError({
			issues: result.issues,
			event
		}));
		return result.value;
	};
	throw new Error("Invalid validator passed to remote function. Expected \"unchecked\" or a Standard Schema (https://standardschema.dev)");
}
/**
* In case of a single remote function call, just returns the result.
*
* In case of a full page reload, returns the response for a remote function call,
* either from the cache or by invoking the function.
* Also saves an uneval'ed version of the result for later HTML inlining for hydration.
*
* @template {MaybePromise<any>} T
* @param {RemoteInternals} internals
* @param {any} arg
* @param {RequestState} state
* @param {() => Promise<T>} get_result
* @returns {Promise<T>}
*/
async function get_response(internals, arg, state, get_result) {
	await 0;
	const cache = get_cache(internals, state);
	const key = stringify_remote_arg(arg, state.transport);
	const entry = cache[key] ??= {
		serialize: false,
		data: get_result()
	};
	entry.serialize ||= !!state.is_in_universal_load;
	if (state.is_in_render && internals.id) {
		const remote_key = create_remote_key(internals.id, key);
		Promise.resolve(entry.data).then((value) => {
			unfriendly_hydratable(remote_key, () => stringify(value, state.transport));
		}).catch(noop);
	}
	return entry.data;
}
/**
* @param {any} data
* @param {ServerHooks['transport']} transport
*/
function parse_remote_response(data, transport) {
	/** @type {Record<string, any>} */
	const revivers = {};
	for (const key in transport) revivers[key] = transport[key].decode;
	return parse(data, revivers);
}
/**
* Like `with_event` but removes things from `event` you cannot see/call in remote functions, such as `setHeaders`.
* @template T
* @param {RequestEvent} event
* @param {RequestState} state
* @param {boolean} allow_cookies
* @param {() => any} get_input
* @param {(arg?: any) => T} fn
*/
async function run_remote_function(event, state, allow_cookies, get_input, fn) {
	/** @type {RequestStore} */
	const store = {
		event: {
			...event,
			setHeaders: () => {
				throw new Error("setHeaders is not allowed in remote functions");
			},
			cookies: {
				...event.cookies,
				set: (name, value, opts) => {
					if (!allow_cookies) throw new Error("Cannot set cookies in `query` or `prerender` functions");
					if (opts.path && !opts.path.startsWith("/")) throw new Error("Cookies set in remote functions must have an absolute path");
					return event.cookies.set(name, value, opts);
				},
				delete: (name, opts) => {
					if (!allow_cookies) throw new Error("Cannot delete cookies in `query` or `prerender` functions");
					if (opts.path && !opts.path.startsWith("/")) throw new Error("Cookies deleted in remote functions must have an absolute path");
					return event.cookies.delete(name, opts);
				}
			}
		},
		state: {
			...state,
			is_in_remote_function: true
		}
	};
	const input = await with_request_store(store, get_input);
	return with_request_store(store, () => fn(input));
}
/**
* @param {RemoteInternals} internals
* @param {RequestState} state
*/
function get_cache(internals, state = get_request_store().state) {
	let cache = state.remote.data?.get(internals);
	if (cache === void 0) {
		cache = {};
		(state.remote.data ??= /* @__PURE__ */ new Map()).set(internals, cache);
	}
	return cache;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/server/remote/command.js
/** @import { RemoteCommand } from '@sveltejs/kit' */
/** @import { MaybePromise, RemoteCommandInternals } from 'types' */
/** @import { StandardSchemaV1 } from '@standard-schema/spec' */
/**
* Creates a remote command. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#command) for full documentation.
*
* @template Output
* @overload
* @param {() => Output} fn
* @returns {RemoteCommand<void, Output>}
* @since 2.27
*/
/**
* Creates a remote command. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#command) for full documentation.
*
* @template Input
* @template Output
* @overload
* @param {'unchecked'} validate
* @param {(arg: Input) => Output} fn
* @returns {RemoteCommand<Input, Output>}
* @since 2.27
*/
/**
* Creates a remote command. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#command) for full documentation.
*
* @template {StandardSchemaV1} Schema
* @template Output
* @overload
* @param {Schema} validate
* @param {(arg: StandardSchemaV1.InferOutput<Schema>) => Output} fn
* @returns {RemoteCommand<StandardSchemaV1.InferInput<Schema>, Output>}
* @since 2.27
*/
/**
* @template Input
* @template Output
* @param {any} validate_or_fn
* @param {(arg?: Input) => Output} [maybe_fn]
* @returns {RemoteCommand<Input, Output>}
* @since 2.27
*/
/* @__NO_SIDE_EFFECTS__ */
function command(validate_or_fn, maybe_fn) {
	/** @type {(arg?: Input) => Output} */
	const fn = maybe_fn ?? validate_or_fn;
	/** @type {(arg?: any) => MaybePromise<Input>} */
	const validate = create_validator(validate_or_fn, maybe_fn);
	/** @type {RemoteCommandInternals} */
	const __ = {
		type: "command",
		id: "",
		name: ""
	};
	/** @type {RemoteCommand<Input, Output> & { __: RemoteCommandInternals }} */
	const wrapper = (arg) => {
		const { event, state } = get_request_store();
		if (!MUTATIVE_METHODS.includes(event.request.method)) throw new Error(`Cannot call a command (\`${__.name}(${maybe_fn ? "..." : ""})\`) from a ${event.request.method} handler`);
		if (state.is_in_render) throw new Error(`Cannot call a command (\`${__.name}(${maybe_fn ? "..." : ""})\`) during server-side rendering`);
		state.remote.refreshes ??= {};
		const promise = Promise.resolve(run_remote_function(event, state, true, () => validate(arg), fn));
		promise.updates = () => {
			throw new Error(`Cannot call '${__.name}(...).updates(...)' on the server`);
		};
		return promise;
	};
	Object.defineProperty(wrapper, "__", { value: __ });
	Object.defineProperty(wrapper, "pending", { get: () => 0 });
	return wrapper;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/server/remote/form.js
/** @import { RemoteFormInput, RemoteForm, InvalidField } from '@sveltejs/kit' */
/** @import { InternalRemoteFormIssue, MaybePromise, RemoteFormInternals } from 'types' */
/** @import { StandardSchemaV1 } from '@standard-schema/spec' */
/**
* Creates a form object that can be spread onto a `<form>` element.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#form) for full documentation.
*
* @template Output
* @overload
* @param {() => MaybePromise<Output>} fn
* @returns {RemoteForm<void, Output>}
* @since 2.27
*/
/**
* Creates a form object that can be spread onto a `<form>` element.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#form) for full documentation.
*
* @template {RemoteFormInput} Input
* @template Output
* @overload
* @param {'unchecked'} validate
* @param {(data: Input, issue: InvalidField<Input>) => MaybePromise<Output>} fn
* @returns {RemoteForm<Input, Output>}
* @since 2.27
*/
/**
* Creates a form object that can be spread onto a `<form>` element.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#form) for full documentation.
*
* @template {StandardSchemaV1<RemoteFormInput, Record<string, any>>} Schema
* @template Output
* @overload
* @param {Schema} validate
* @param {(data: StandardSchemaV1.InferOutput<Schema>, issue: InvalidField<StandardSchemaV1.InferInput<Schema>>) => MaybePromise<Output>} fn
* @returns {RemoteForm<StandardSchemaV1.InferInput<Schema>, Output>}
* @since 2.27
*/
/**
* @template {RemoteFormInput} Input
* @template Output
* @param {any} validate_or_fn
* @param {(data_or_issue: any, issue?: any) => MaybePromise<Output>} [maybe_fn]
* @returns {RemoteForm<Input, Output>}
* @since 2.27
*/
/* @__NO_SIDE_EFFECTS__ */
function form(validate_or_fn, maybe_fn) {
	/** @type {any} */
	const fn = maybe_fn ?? validate_or_fn;
	/** @type {StandardSchemaV1 | null} */
	const schema = !maybe_fn || validate_or_fn === "unchecked" ? null : validate_or_fn;
	/**
	* @param {string | number | boolean} [key]
	*/
	function create_instance(key) {
		/** @type {RemoteForm<Input, Output>} */
		const instance = {};
		instance.method = "POST";
		Object.defineProperty(instance, "enhance", { value: () => {
			return {
				action: instance.action,
				method: instance.method
			};
		} });
		/** @type {RemoteFormInternals} */
		const __ = {
			type: "form",
			name: "",
			id: "",
			fn: async (data, meta, form_data) => {
				/** @type {{ submission: true, input?: Record<string, any>, issues?: InternalRemoteFormIssue[], result: Output }} */
				const output = {};
				output.submission = true;
				const { event, state } = get_request_store();
				const validated = await schema?.["~standard"].validate(data);
				if (meta.validate_only) return validated?.issues?.map((issue) => normalize_issue(issue, true)) ?? [];
				if (validated?.issues !== void 0) handle_issues(output, validated.issues, form_data);
				else {
					if (validated !== void 0) data = validated.value;
					state.remote.refreshes ??= {};
					const issue = create_issues();
					try {
						output.result = await run_remote_function(event, state, true, () => data, (data) => !maybe_fn ? fn() : fn(data, issue));
					} catch (e) {
						if (e instanceof ValidationError) handle_issues(output, e.issues, form_data);
						else throw e;
					}
				}
				if (!event.isRemoteRequest) get_cache(__, state)[""] ??= {
					serialize: true,
					data: output
				};
				return output;
			}
		};
		Object.defineProperty(instance, "__", { value: __ });
		Object.defineProperty(instance, "action", {
			get: () => `?/remote=${__.id}`,
			enumerable: true
		});
		Object.defineProperty(instance, "fields", { get() {
			return create_field_proxy({}, () => get_cache(__)?.[""]?.data?.input ?? {}, (path, value) => {
				const cache = get_cache(__);
				const entry = cache[""];
				if (entry?.data?.submission) return;
				if (path.length === 0) {
					(cache[""] ??= {
						serialize: true,
						data: {}
					}).data.input = value;
					return;
				}
				const input = entry?.data?.input ?? {};
				deep_set(input, path.map(String), value);
				(cache[""] ??= {
					serialize: true,
					data: {}
				}).data.input = input;
			}, () => flatten_issues(get_cache(__)?.[""]?.data?.issues ?? []));
		} });
		Object.defineProperty(instance, "result", { get() {
			try {
				return get_cache(__)?.[""]?.data?.result;
			} catch {
				return;
			}
		} });
		Object.defineProperty(instance, "pending", { get: () => 0 });
		Object.defineProperty(instance, "preflight", { value: () => instance });
		Object.defineProperty(instance, "validate", { value: () => {
			throw new Error("Cannot call validate() on the server");
		} });
		if (key == void 0) Object.defineProperty(instance, "for", { value: (key) => {
			const { state } = get_request_store();
			const cache_key = __.id + "|" + JSON.stringify(key);
			let instance = (state.remote.forms ??= /* @__PURE__ */ new Map()).get(cache_key);
			if (!instance) {
				instance = create_instance(key);
				instance.__.id = `${__.id}/${encodeURIComponent(JSON.stringify(key))}`;
				instance.__.name = __.name;
				state.remote.forms.set(cache_key, instance);
			}
			return instance;
		} });
		return instance;
	}
	return create_instance();
}
/**
* @param {{ issues?: InternalRemoteFormIssue[], input?: Record<string, any>, result: any }} output
* @param {readonly StandardSchemaV1.Issue[]} issues
* @param {FormData | null} form_data - null if the form is progressively enhanced
*/
function handle_issues(output, issues, form_data) {
	output.issues = issues.map((issue) => normalize_issue(issue, true));
	if (form_data) {
		output.input = {};
		for (let key of form_data.keys()) {
			if (/^[.\]]?_/.test(key)) continue;
			const is_array = key.endsWith("[]");
			const values = form_data.getAll(key).filter((value) => typeof value === "string");
			if (is_array) key = key.slice(0, -2);
			set_nested_value(output.input, key, is_array ? values : values[0]);
		}
	}
}
/**
* Creates an invalid function that can be used to imperatively mark form fields as invalid
* @returns {InvalidField<any>}
*/
function create_issues() {
	return new Proxy(
		/** @param {string} message */
		(message) => {
			if (typeof message !== "string") throw new Error("`invalid` should now be imported from `@sveltejs/kit` to throw validation issues. The second parameter provided to the form function (renamed to `issue`) is still used to construct issues, e.g. `invalid(issue.field('message'))`. For more info see https://github.com/sveltejs/kit/pulls/14768");
			return create_issue(message);
		},
		{ get(target, prop) {
			if (typeof prop === "symbol") return target[prop];
			return create_issue_proxy(prop, []);
		} }
	);
	/**
	* @param {string} message
	* @param {(string | number)[]} path
	* @returns {StandardSchemaV1.Issue}
	*/
	function create_issue(message, path = []) {
		return {
			message,
			path
		};
	}
	/**
	* Creates a proxy that builds up a path and returns a function to create an issue
	* @param {string | number} key
	* @param {(string | number)[]} path
	*/
	function create_issue_proxy(key, path) {
		const new_path = [...path, key];
		/**
		* @param {string} message
		* @returns {StandardSchemaV1.Issue}
		*/
		const issue_func = (message) => create_issue(message, new_path);
		return new Proxy(issue_func, { get(target, prop) {
			if (typeof prop === "symbol") return target[prop];
			if (/^\d+$/.test(prop)) return create_issue_proxy(parseInt(prop, 10), new_path);
			return create_issue_proxy(prop, new_path);
		} });
	}
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/server/remote/prerender.js
/** @import { RemoteResource, RemotePrerenderFunction } from '@sveltejs/kit' */
/** @import { RemotePrerenderInputsGenerator, RemotePrerenderInternals, MaybePromise } from 'types' */
/** @import { StandardSchemaV1 } from '@standard-schema/spec' */
/**
* Creates a remote prerender function. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#prerender) for full documentation.
*
* @template Output
* @overload
* @param {() => MaybePromise<Output>} fn
* @param {{ inputs?: RemotePrerenderInputsGenerator<void>, dynamic?: boolean }} [options]
* @returns {RemotePrerenderFunction<void, Output>}
* @since 2.27
*/
/**
* Creates a remote prerender function. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#prerender) for full documentation.
*
* @template Input
* @template Output
* @overload
* @param {'unchecked'} validate
* @param {(arg: Input) => MaybePromise<Output>} fn
* @param {{ inputs?: RemotePrerenderInputsGenerator<Input>, dynamic?: boolean }} [options]
* @returns {RemotePrerenderFunction<Input, Output>}
* @since 2.27
*/
/**
* Creates a remote prerender function. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#prerender) for full documentation.
*
* @template {StandardSchemaV1} Schema
* @template Output
* @overload
* @param {Schema} schema
* @param {(arg: StandardSchemaV1.InferOutput<Schema>) => MaybePromise<Output>} fn
* @param {{ inputs?: RemotePrerenderInputsGenerator<StandardSchemaV1.InferInput<Schema>>, dynamic?: boolean }} [options]
* @returns {RemotePrerenderFunction<StandardSchemaV1.InferInput<Schema>, Output>}
* @since 2.27
*/
/**
* @template Input
* @template Output
* @param {any} validate_or_fn
* @param {any} [fn_or_options]
* @param {{ inputs?: RemotePrerenderInputsGenerator<Input>, dynamic?: boolean }} [maybe_options]
* @returns {RemotePrerenderFunction<Input, Output>}
* @since 2.27
*/
/* @__NO_SIDE_EFFECTS__ */
function prerender(validate_or_fn, fn_or_options, maybe_options) {
	const maybe_fn = typeof fn_or_options === "function" ? fn_or_options : void 0;
	/** @type {typeof maybe_options} */
	const options = maybe_options ?? (maybe_fn ? void 0 : fn_or_options);
	/** @type {(arg?: Input) => MaybePromise<Output>} */
	const fn = maybe_fn ?? validate_or_fn;
	/** @type {(arg?: any) => MaybePromise<Input>} */
	const validate = create_validator(validate_or_fn, maybe_fn);
	/** @type {RemotePrerenderInternals} */
	const __ = {
		type: "prerender",
		id: "",
		name: "",
		has_arg: !!maybe_fn,
		inputs: options?.inputs,
		dynamic: options?.dynamic
	};
	/** @type {RemotePrerenderFunction<Input, Output> & { __: RemotePrerenderInternals }} */
	const wrapper = (arg) => {
		/** @type {Promise<Output> & Partial<RemoteResource<Output>>} */
		const promise = (async () => {
			const { event, state } = get_request_store();
			const payload = stringify_remote_arg(arg, state.transport);
			const url = `${base}/${app_dir}/remote/${__.id}${payload ? `/${payload}` : ""}`;
			if (!state.prerendering && !event.isRemoteRequest) try {
				return await get_response(__, arg, state, async () => {
					const key = stringify_remote_arg(arg, state.transport);
					const cache = get_cache(__, state);
					const promise = (cache[key] ??= {
						serialize: true,
						data: fetch(new URL(url, event.url.origin).href).then(async (response) => {
							if (!response.ok) throw new Error("Prerendered response not found");
							const prerendered = await response.json();
							if (prerendered.type === "error") error(prerendered.status, prerendered.error);
							return prerendered.result;
						})
					}).data;
					return parse_remote_response(await promise, state.transport);
				});
			} catch {}
			if (state.prerendering?.remote_responses.has(url)) return state.prerendering.remote_responses.get(url);
			const promise = get_response(__, arg, state, () => run_remote_function(event, state, false, () => validate(arg), fn));
			if (state.prerendering) state.prerendering.remote_responses.set(url, promise);
			const result = await promise;
			if (state.prerendering) {
				const body = {
					type: "result",
					result: stringify(result, state.transport)
				};
				state.prerendering.dependencies.set(url, {
					body: JSON.stringify(body),
					response: json(body)
				});
			}
			return result;
		})();
		promise.catch(noop);
		return promise;
	};
	Object.defineProperty(wrapper, "__", { value: __ });
	return wrapper;
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/server/remote/query.js
/** @import { RemoteQuery, RemoteQueryFunction } from '@sveltejs/kit' */
/** @import { RemoteInternals, MaybePromise, RequestState, RemoteQueryBatchInternals, RemoteQueryInternals } from 'types' */
/** @import { StandardSchemaV1 } from '@standard-schema/spec' */
/**
* Creates a remote query. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#query) for full documentation.
*
* @template Output
* @overload
* @param {() => MaybePromise<Output>} fn
* @returns {RemoteQueryFunction<void, Output>}
* @since 2.27
*/
/**
* Creates a remote query. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#query) for full documentation.
*
* @template Input
* @template Output
* @overload
* @param {'unchecked'} validate
* @param {(arg: Input) => MaybePromise<Output>} fn
* @returns {RemoteQueryFunction<Input, Output>}
* @since 2.27
*/
/**
* Creates a remote query. When called from the browser, the function will be invoked on the server via a `fetch` call.
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#query) for full documentation.
*
* @template {StandardSchemaV1} Schema
* @template Output
* @overload
* @param {Schema} schema
* @param {(arg: StandardSchemaV1.InferOutput<Schema>) => MaybePromise<Output>} fn
* @returns {RemoteQueryFunction<StandardSchemaV1.InferInput<Schema>, Output>}
* @since 2.27
*/
/**
* @template Input
* @template Output
* @param {any} validate_or_fn
* @param {(args?: Input) => MaybePromise<Output>} [maybe_fn]
* @returns {RemoteQueryFunction<Input, Output>}
* @since 2.27
*/
/* @__NO_SIDE_EFFECTS__ */
function query(validate_or_fn, maybe_fn) {
	/** @type {(arg?: Input) => Output} */
	const fn = maybe_fn ?? validate_or_fn;
	/** @type {(arg?: any) => MaybePromise<Input>} */
	const validate = create_validator(validate_or_fn, maybe_fn);
	/** @type {RemoteQueryInternals} */
	const __ = {
		type: "query",
		id: "",
		name: "",
		validate
	};
	/** @type {RemoteQueryFunction<Input, Output> & { __: RemoteQueryInternals }} */
	const wrapper = (arg) => {
		if (prerendering) throw new Error(`Cannot call query '${__.name}' while prerendering, as prerendered pages need static data. Use 'prerender' from $app/server instead`);
		const { event, state } = get_request_store();
		const is_validated = is_validated_argument(__, state, arg);
		return create_query_resource(__, arg, state, () => run_remote_function(event, state, false, () => is_validated ? arg : validate(arg), fn));
	};
	Object.defineProperty(wrapper, "__", { value: __ });
	return wrapper;
}
/**
* @param {RemoteQueryInternals} __
* @param {RequestState} state
* @param {any} arg
*/
function is_validated_argument(__, state, arg) {
	return state.remote.validated?.get(__.id)?.has(arg) ?? false;
}
/**
* @param {RemoteQueryInternals} __
* @param {RequestState} state
* @param {any} arg
*/
function mark_argument_validated(__, state, arg) {
	const validated = state.remote.validated ??= /* @__PURE__ */ new Map();
	let validated_args = validated.get(__.id);
	if (!validated_args) {
		validated_args = /* @__PURE__ */ new Set();
		validated.set(__.id, validated_args);
	}
	validated_args.add(arg);
	return arg;
}
/**
* Creates a batch query function that collects multiple calls and executes them in a single request
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#query.batch) for full documentation.
*
* @template Input
* @template Output
* @overload
* @param {'unchecked'} validate
* @param {(args: Input[]) => MaybePromise<(arg: Input, idx: number) => Output>} fn
* @returns {RemoteQueryFunction<Input, Output>}
* @since 2.35
*/
/**
* Creates a batch query function that collects multiple calls and executes them in a single request
*
* See [Remote functions](https://svelte.dev/docs/kit/remote-functions#query.batch) for full documentation.
*
* @template {StandardSchemaV1} Schema
* @template Output
* @overload
* @param {Schema} schema
* @param {(args: StandardSchemaV1.InferOutput<Schema>[]) => MaybePromise<(arg: StandardSchemaV1.InferOutput<Schema>, idx: number) => Output>} fn
* @returns {RemoteQueryFunction<StandardSchemaV1.InferInput<Schema>, Output>}
* @since 2.35
*/
/**
* @template Input
* @template Output
* @param {any} validate_or_fn
* @param {(args?: Input[]) => MaybePromise<(arg: Input, idx: number) => Output>} [maybe_fn]
* @returns {RemoteQueryFunction<Input, Output>}
* @since 2.35
*/
/* @__NO_SIDE_EFFECTS__ */
function batch(validate_or_fn, maybe_fn) {
	/** @type {(args?: Input[]) => MaybePromise<(arg: Input, idx: number) => Output>} */
	const fn = maybe_fn ?? validate_or_fn;
	/** @type {(arg?: any) => MaybePromise<Input>} */
	const validate = create_validator(validate_or_fn, maybe_fn);
	/** @type {RemoteQueryBatchInternals} */
	const __ = {
		type: "query_batch",
		id: "",
		name: "",
		run: async (args, options) => {
			const { event, state } = get_request_store();
			return run_remote_function(event, state, false, async () => Promise.all(args.map(validate)), async (input) => {
				const get_result = await fn(input);
				return Promise.all(input.map(async (arg, i) => {
					try {
						return {
							type: "result",
							data: stringify(get_result(arg, i), state.transport)
						};
					} catch (error) {
						return {
							type: "error",
							error: await handle_error_and_jsonify(event, state, options, error),
							status: error instanceof HttpError || error instanceof SvelteKitError ? error.status : 500
						};
					}
				}));
			});
		}
	};
	/** @type {Map<string, { arg: any, resolvers: Array<{resolve: (value: any) => void, reject: (error: any) => void}> }>} */
	let batching = /* @__PURE__ */ new Map();
	/** @type {RemoteQueryFunction<Input, Output> & { __: RemoteQueryBatchInternals }} */
	const wrapper = (arg) => {
		if (prerendering) throw new Error(`Cannot call query.batch '${__.name}' while prerendering, as prerendered pages need static data. Use 'prerender' from $app/server instead`);
		const { event, state } = get_request_store();
		return create_query_resource(__, arg, state, () => {
			return new Promise((resolve, reject) => {
				const key = stringify_remote_arg(arg, state.transport);
				const entry = batching.get(key);
				if (entry) {
					entry.resolvers.push({
						resolve,
						reject
					});
					return;
				}
				batching.set(key, {
					arg,
					resolvers: [{
						resolve,
						reject
					}]
				});
				if (batching.size > 1) return;
				setTimeout(async () => {
					const batched = batching;
					batching = /* @__PURE__ */ new Map();
					const entries = Array.from(batched.values());
					const args = entries.map((entry) => entry.arg);
					try {
						return await run_remote_function(event, state, false, async () => Promise.all(args.map(validate)), async (input) => {
							const get_result = await fn(input);
							for (let i = 0; i < entries.length; i++) try {
								const result = get_result(input[i], i);
								for (const resolver of entries[i].resolvers) resolver.resolve(result);
							} catch (error) {
								for (const resolver of entries[i].resolvers) resolver.reject(error);
							}
						});
					} catch (error) {
						for (const entry of batched.values()) for (const resolver of entry.resolvers) resolver.reject(error);
					}
				}, 0);
			});
		});
	};
	Object.defineProperty(wrapper, "__", { value: __ });
	return wrapper;
}
/**
* @param {RemoteInternals} __
* @param {any} arg
* @param {RequestState} state
* @param {() => Promise<any>} fn
* @returns {RemoteQuery<any>}
*/
function create_query_resource(__, arg, state, fn) {
	/** @type {Promise<any> | null} */
	let promise = null;
	const get_promise = () => {
		return promise ??= get_response(__, arg, state, fn);
	};
	return {
		catch(onrejected) {
			return get_promise().catch(onrejected);
		},
		current: void 0,
		error: void 0,
		finally(onfinally) {
			return get_promise().finally(onfinally);
		},
		loading: true,
		ready: false,
		refresh() {
			const refresh_context = get_refresh_context(__, "refresh", arg);
			const is_immediate_refresh = !refresh_context.cache[refresh_context.cache_key];
			return update_refresh_value(refresh_context, is_immediate_refresh ? get_promise() : fn(), is_immediate_refresh);
		},
		run() {
			if (!state.is_in_universal_load) throw new Error("On the server, .run() can only be called in universal `load` functions. Anywhere else, just await the query directly");
			return get_response(__, arg, state, fn);
		},
		set(value) {
			return update_refresh_value(get_refresh_context(__, "set", arg), value);
		},
		then(onfulfilled, onrejected) {
			return get_promise().then(onfulfilled, onrejected);
		},
		withOverride() {
			throw new Error(`Cannot call '${__.name}.withOverride()' on the server`);
		},
		get [Symbol.toStringTag]() {
			return "QueryResource";
		}
	};
}
Object.defineProperty(query, "batch", {
	value: batch,
	enumerable: true
});
/**
* @param {RemoteInternals} __
* @param {'set' | 'refresh'} action
* @param {any} [arg]
* @returns {{ __: RemoteInternals; state: any; refreshes: Record<string, Promise<any>>; cache: Record<string, { serialize: boolean; data: any }>; refreshes_key: string; cache_key: string }}
*/
function get_refresh_context(__, action, arg) {
	const { state } = get_request_store();
	const { refreshes } = state.remote;
	if (!refreshes) {
		const name = __.type === "query_batch" ? `query.batch '${__.name}'` : `query '${__.name}'`;
		throw new Error(`Cannot call ${action} on ${name} because it is not executed in the context of a command/form remote function`);
	}
	const cache = get_cache(__, state);
	const cache_key = stringify_remote_arg(arg, state.transport);
	return {
		__,
		state,
		refreshes,
		refreshes_key: create_remote_key(__.id, cache_key),
		cache,
		cache_key
	};
}
/**
* @param {{ __: RemoteInternals; refreshes: Record<string, Promise<any>>; cache: Record<string, { serialize: boolean; data: any }>; refreshes_key: string; cache_key: string }} context
* @param {any} value
* @param {boolean} [is_immediate_refresh=false]
* @returns {Promise<void>}
*/
function update_refresh_value({ __, refreshes, refreshes_key, cache, cache_key }, value, is_immediate_refresh = false) {
	const promise = Promise.resolve(value);
	if (!is_immediate_refresh) cache[cache_key] = {
		serialize: true,
		data: promise
	};
	if (__.id) refreshes[refreshes_key] = promise;
	return promise.then(noop, noop);
}
//#endregion
//#region ../../node_modules/.pnpm/@sveltejs+kit@2.57.1_@sveltejs+vite-plugin-svelte@5.1.1_svelte@5.55.4_vite@8.0.8_@types_3b291ab8aecb731f2569fb111f44cf77/node_modules/@sveltejs/kit/src/runtime/app/server/remote/requested.js
/** @import { RemoteQueryFunction, RequestedResult } from '@sveltejs/kit' */
/** @import { MaybePromise, RemoteQueryInternals } from 'types' */
/**
* In the context of a remote `command` or `form` request, returns an iterable
* of the client-requested refreshes' validated arguments up to the supplied limit.
* Arguments that fail validation or exceed the limit are recorded as failures in
* the response to the client.
*
* @example
* ```ts
* import { requested } from '$app/server';
*
* for (const arg of requested(getPost, 5)) {
* 	// it's safe to throw away this promise -- SvelteKit
* 	// will await it for us and handle any errors by sending
* 	// them to the client.
* 	void getPost(arg).refresh();
* }
* ```
*
* As a shorthand for the above, you can also call `refreshAll` on the result:
*
* ```ts
* import { requested } from '$app/server';
*
* await requested(getPost, 5).refreshAll();
* ```
*
* @template Input
* @template Output
* @param {RemoteQueryFunction<Input, Output>} query
* @param {number} [limit=Infinity]
* @returns {RequestedResult<Input>}
*/
function requested(query, limit = Infinity) {
	const { state } = get_request_store();
	const internals = query.__;
	if (!internals || internals.type !== "query") throw new Error("requested(...) expects a query function created with query(...)");
	const payloads = state.remote.requested?.get(internals.id) ?? [];
	const refreshes = state.remote.refreshes ??= {};
	const [selected, skipped] = split_limit(payloads, limit);
	/**
	* @param {string} payload
	* @param {unknown} error
	*/
	const record_failure = (payload, error) => {
		const promise = Promise.reject(error);
		promise.catch(noop);
		const key = create_remote_key(internals.id, payload);
		refreshes[key] = promise;
	};
	for (const payload of skipped) record_failure(payload, /* @__PURE__ */ new Error(`Requested refresh was rejected because it exceeded requested(${internals.name}, ${limit}) limit`));
	return {
		*[Symbol.iterator]() {
			for (const payload of selected) try {
				const parsed = parse_remote_arg(payload, state.transport);
				const validated = internals.validate(parsed);
				if (is_thenable(validated)) throw new Error(`requested(${internals.name}, ${limit}) cannot be used with synchronous iteration because the query validator is async. Use \`for await ... of\` instead`);
				yield mark_argument_validated(internals, state, validated);
			} catch (error) {
				record_failure(payload, error);
				continue;
			}
		},
		async *[Symbol.asyncIterator]() {
			yield* race_all(selected, async (payload) => {
				try {
					const parsed = parse_remote_arg(payload, state.transport);
					return mark_argument_validated(internals, state, await internals.validate(parsed));
				} catch (error) {
					record_failure(payload, error);
					throw new Error(`Skipping ${internals.name}(${payload})`, { cause: error });
				}
			});
		},
		async refreshAll() {
			for await (const arg of this) query(arg).refresh();
		}
	};
}
/**
* @template T
* @param {Array<T>} array
* @param {number} limit
* @returns {[Array<T>, Array<T>]}
*/
function split_limit(array, limit) {
	if (limit === Infinity) return [array, []];
	if (!Number.isInteger(limit) || limit < 0) throw new Error("Limit must be a non-negative integer or Infinity");
	return [array.slice(0, limit), array.slice(limit)];
}
/**
* @param {any} value
* @returns {value is PromiseLike<any>}
*/
function is_thenable(value) {
	return !!value && (typeof value === "object" || typeof value === "function") && "then" in value;
}
/**
* Runs all callbacks immediately and yields resolved values in completion order.
* If the promise rejects, it is skipped.
*
* @template T
* @template R
* @param {Array<T>} array
* @param {(value: T) => MaybePromise<R>} fn
* @returns {AsyncIterable<R>}
*/
async function* race_all(array, fn) {
	/** @type {Set<Promise<{ promise: Promise<any>, value: Awaited<R> }>>} */
	const pending = /* @__PURE__ */ new Set();
	for (const value of array) {
		/** @type {Promise<{ promise: Promise<any>, value: Awaited<R> }>} */
		const promise = Promise.resolve(fn(value)).then((result) => ({
			promise,
			value: result
		}));
		promise.catch(noop);
		pending.add(promise);
	}
	while (pending.size > 0) try {
		const { promise, value } = await Promise.race(pending);
		pending.delete(promise);
		yield value;
	} catch {}
}
//#endregion
export { command, form, prerender, query, requested };
