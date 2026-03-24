import { getTransportMapping, isRegisteredErrorCode, getRegistryCode } from "./errorRegistry.js";
import { resolveOutputFormat, LAFSFlagError } from "./flagSemantics.js";
import { isAgentAction, isMVILevel } from "./types.js";
import type { ConformanceReport, FlagInput, LAFSAgentAction } from "./types.js";
import { getChecksForTier, type ConformanceTier } from "./conformanceProfiles.js";
import { validateEnvelope } from "./validateEnvelope.js";

function pushCheck(
  checks: ConformanceReport["checks"],
  name: string,
  pass: boolean,
  detail?: string,
) {
  checks.push({ name, pass, ...(detail ? { detail } : {}) });
}

export interface EnvelopeConformanceOptions {
  tier?: ConformanceTier;
}

export function runEnvelopeConformance(
  envelope: unknown,
  options: EnvelopeConformanceOptions = {},
): ConformanceReport {
  const checks: ConformanceReport["checks"] = [];

  const validation = validateEnvelope(envelope);
  pushCheck(
    checks,
    "envelope_schema_valid",
    validation.valid,
    validation.valid ? undefined : validation.errors.join("; "),
  );

  if (!validation.valid) {
    return { ok: false, checks };
  }

  const typed = envelope as {
    success: boolean;
    result: unknown;
    error?: null | { code: string; agentAction?: string };
    page?: unknown;
    _extensions?: Record<string, unknown>;
    _meta: {
      mvi: string;
      strict: boolean;
      warnings?: unknown[];
      operation: string;
      contextVersion: number;
      sessionId?: string;
      transport: "http" | "grpc" | "cli" | "sdk";
    };
  };

  // envelope_invariants: success=true allows error to be null OR omitted;
  // success=false requires error to be a non-null object.
  // result MAY be non-null on error — validation tools (linters, type checkers)
  // need to return actionable data (e.g., suggestedFix) alongside the error.
  const invariant = typed.success
    ? typed.error == null  // null or undefined (omitted) both valid for success
    : typed.error != null; // error must be present, result is optional
  pushCheck(
    checks,
    "envelope_invariants",
    invariant,
    invariant
      ? undefined
      : typed.success
        ? "success=true but error is present and non-null"
        : "success=false requires error to be a non-null object",
  );

  // error_code_registered: only checked when error is present (error is optional when success=true)
  if (typed.error) {
    const registered = isRegisteredErrorCode(typed.error.code);
    pushCheck(
      checks,
      "error_code_registered",
      registered,
      registered ? undefined : `unregistered code: ${typed.error.code}`,
    );
  } else {
    pushCheck(
      checks,
      "error_code_registered",
      true,
      "error field absent or null — skipped (optional when success=true)",
    );
  }

  // agent_action_valid: if error.agentAction is present, it must be a valid LAFSAgentAction
  if (typed.error && typed.error.agentAction !== undefined) {
    const valid = isAgentAction(typed.error.agentAction);
    pushCheck(
      checks,
      "agent_action_valid",
      valid,
      valid ? undefined : `invalid agentAction: ${String(typed.error.agentAction)}`,
    );
  } else {
    pushCheck(
      checks,
      "agent_action_valid",
      true,
      "agentAction absent — skipped",
    );
  }

  // error_registry_agent_action: if error code is registered and agentAction is present,
  // check if it matches the registry default (warning-level, not a hard failure)
  if (typed.error && typed.error.agentAction !== undefined && isRegisteredErrorCode(typed.error.code)) {
    const registryEntry = getRegistryCode(typed.error.code);
    const registryAction = (registryEntry as Record<string, unknown> | undefined)?.["agentAction"] as string | undefined;
    if (registryAction) {
      const matches = typed.error.agentAction === registryAction;
      pushCheck(
        checks,
        "error_registry_agent_action",
        true, // always passes — advisory only
        matches
          ? undefined
          : `agentAction "${typed.error.agentAction}" differs from registry default "${registryAction}" for ${typed.error.code} (advisory)`,
      );
    } else {
      pushCheck(
        checks,
        "error_registry_agent_action",
        true,
        "registry entry has no default agentAction — skipped",
      );
    }
  } else {
    pushCheck(
      checks,
      "error_registry_agent_action",
      true,
      typed.error ? "agentAction absent or code unregistered — skipped" : "no error present — skipped",
    );
  }

  // transport_mapping_consistent: when an error is present, ensure the code has
  // a transport-specific mapping in the registry for the declared transport.
  if (typed.error) {
    if (typed._meta.transport === "sdk") {
      pushCheck(
        checks,
        "transport_mapping_consistent",
        true,
        "sdk transport does not require external status-code mapping",
      );
    } else {
      const mapping = getTransportMapping(typed.error.code, typed._meta.transport);
      const mappingOk = mapping !== null;
      pushCheck(
        checks,
        "transport_mapping_consistent",
        mappingOk,
        mappingOk
          ? undefined
          : `no ${typed._meta.transport} mapping found for code ${typed.error.code}`,
      );
    }
  } else {
    pushCheck(
      checks,
      "transport_mapping_consistent",
      true,
      "no error present — mapping check skipped",
    );
  }

  // context_mutation_failure: if the producer marks context as required for a
  // mutation operation, missing context must fail with a context error code.
  {
    const ext = (typed._extensions ?? {}) as Record<string, unknown>;
    const contextObj = (ext["context"] ?? {}) as Record<string, unknown>;
    const lafsObj = (ext["lafs"] ?? {}) as Record<string, unknown>;
    const contextRequired =
      ext["lafsContextRequired"] === true ||
      contextObj["required"] === true ||
      lafsObj["contextRequired"] === true;

    if (!contextRequired) {
      pushCheck(
        checks,
        "context_mutation_failure",
        true,
        "context not marked required — skipped",
      );
    } else {
      const hasContextIdentity = typed._meta.contextVersion > 0 || Boolean(typed._meta.sessionId);

      if (typed.success) {
        const pass = hasContextIdentity;
        pushCheck(
          checks,
          "context_mutation_failure",
          pass,
          pass ? undefined : "context required but missing identity (expect E_CONTEXT_MISSING)",
        );
      } else {
        const code = typed.error?.code;
        const pass = code === "E_CONTEXT_MISSING" || code === "E_CONTEXT_STALE";
        pushCheck(
          checks,
          "context_mutation_failure",
          pass,
          pass
            ? undefined
            : `context required failures should return E_CONTEXT_MISSING or E_CONTEXT_STALE, got ${String(code)}`,
        );
      }
    }
  }

  const mviValid = isMVILevel(typed._meta.mvi);
  pushCheck(
    checks,
    "meta_mvi_present",
    mviValid,
    mviValid ? undefined : `invalid mvi level: ${String(typed._meta.mvi)}`,
  );
  pushCheck(checks, "meta_strict_present", typeof typed._meta.strict === "boolean");

  // strict_mode_behavior: when strict=true, the envelope MUST NOT contain
  // explicit null for optional fields that can be omitted (page, error on success).
  if (typed._meta.strict) {
    const obj = envelope as Record<string, unknown>;
    const hasExplicitNullError = typed.success && "error" in obj && obj["error"] === null;
    const hasExplicitNullPage = "page" in obj && obj["page"] === null;
    const strictClean = !hasExplicitNullError && !hasExplicitNullPage;
    pushCheck(
      checks,
      "strict_mode_behavior",
      strictClean,
      strictClean
        ? undefined
        : "strict mode: optional fields should be omitted rather than set to null",
    );
  }

  // pagination_mode_consistent: when page is present and is an object, verify
  // that the fields present match the declared pagination mode.
  if (typed.page && typeof typed.page === "object") {
    const page = typed.page as Record<string, unknown>;
    const mode = page["mode"] as string | undefined;
    let consistent = true;
    let detail: string | undefined;

    if (mode === "cursor") {
      if (page["offset"] !== undefined) {
        consistent = false;
        detail = "cursor mode should not include offset field";
      }
    } else if (mode === "offset") {
      if (page["nextCursor"] !== undefined) {
        consistent = false;
        detail = "offset mode should not include nextCursor field";
      }
    } else if (mode === "none") {
      const extraFields = Object.keys(page).filter((k) => k !== "mode");
      if (extraFields.length > 0) {
        consistent = false;
        detail = `none mode should only have mode field, found: ${extraFields.join(", ")}`;
      }
    }

    pushCheck(
      checks,
      "pagination_mode_consistent",
      consistent,
      consistent ? undefined : detail,
    );
  } else {
    pushCheck(
      checks,
      "pagination_mode_consistent",
      true,
      "page absent — skipped",
    );
  }

  // strict_mode_enforced: verify the schema enforces additional-property rules.
  // When strict=true, extra top-level properties must be rejected by validation.
  // When strict=false, extra top-level properties must be allowed.
  {
    const extraPropEnvelope = { ...(envelope as Record<string, unknown>), _unknown_extra: true };
    const extraResult = validateEnvelope(extraPropEnvelope);
    if (typed._meta.strict) {
      pushCheck(
        checks,
        "strict_mode_enforced",
        !extraResult.valid,
        extraResult.valid ? "strict=true but additional properties were accepted" : undefined,
      );
    } else {
      pushCheck(
        checks,
        "strict_mode_enforced",
        extraResult.valid,
        !extraResult.valid ? "strict=false but additional properties were rejected" : undefined,
      );
    }
  }

  // context_preservation_valid: validate monotonic context version behavior and
  // context-constraint integrity when a context ledger extension is present.
  {
    const ext = (typed._extensions ?? {}) as Record<string, unknown>;
    const ledger = (ext["contextLedger"] ?? ext["context"]) as
      | Record<string, unknown>
      | undefined;

    if (!ledger || typeof ledger !== "object") {
      pushCheck(checks, "context_preservation_valid", true, "context ledger absent — skipped");
    } else {
      const version = ledger["version"];
      const previousVersion = ledger["previousVersion"];
      const removedConstraints = ledger["removedConstraints"];

      const hasNumericVersion = typeof version === "number";
      const matchesEnvelopeVersion = hasNumericVersion && version === typed._meta.contextVersion;
      const monotonicFromPrevious =
        typeof previousVersion !== "number" || (hasNumericVersion && version >= previousVersion);
      const constraintsPreserved =
        !Array.isArray(removedConstraints) || removedConstraints.length === 0 || !typed.success;

      let pass = matchesEnvelopeVersion && monotonicFromPrevious && constraintsPreserved;
      let detail: string | undefined;

      if (!hasNumericVersion) {
        pass = false;
        detail = "context ledger version must be numeric";
      } else if (!matchesEnvelopeVersion) {
        detail = `context version mismatch: ledger=${String(version)} envelope=${typed._meta.contextVersion}`;
      } else if (!monotonicFromPrevious) {
        detail = `non-monotonic context version: previous=${String(previousVersion)} current=${String(version)}`;
      } else if (!constraintsPreserved) {
        detail = "context constraint removal detected on successful response";
      }

      // Error-path validation for stale/missing context signaling.
      if (!typed.success && typed.error && ledger["required"] === true) {
        const stale = ledger["stale"] === true;
        if (stale && typed.error.code !== "E_CONTEXT_STALE") {
          pass = false;
          detail = `stale context should return E_CONTEXT_STALE, got ${typed.error.code}`;
        }
        if (!stale && typed.error.code !== "E_CONTEXT_MISSING" && typed.error.code !== "E_CONTEXT_STALE") {
          pass = false;
          detail = `required context failure should return E_CONTEXT_MISSING or E_CONTEXT_STALE, got ${typed.error.code}`;
        }
      }

      pushCheck(checks, "context_preservation_valid", pass, detail);
    }
  }

  const tier = options.tier;
  if (!tier) {
    return { ok: checks.every((check) => check.pass), checks };
  }

  const allowed = new Set(getChecksForTier(tier));
  const tierChecks = checks.filter((check) => allowed.has(check.name));
  return { ok: tierChecks.every((check) => check.pass), checks: tierChecks };
}

export function runFlagConformance(flags: FlagInput): ConformanceReport {
  const checks: ConformanceReport["checks"] = [];

  try {
    const resolved = resolveOutputFormat(flags);
    pushCheck(checks, "flag_conflict_rejected", !(flags.humanFlag && flags.jsonFlag));

    // Protocol-default check: when nothing is specified (source === "default"),
    // the protocol requires JSON as the default format.
    const isProtocolDefault = resolved.source === "default";
    pushCheck(
      checks,
      "json_protocol_default",
      !isProtocolDefault || resolved.format === "json",
      isProtocolDefault && resolved.format !== "json"
        ? `protocol default should be json, got ${resolved.format}`
        : undefined,
    );

    // Config-override check: when a project or user default is active,
    // the resolved format must match the config-provided value.
    const hasConfigOverride = resolved.source === "project" || resolved.source === "user";
    const expectedOverride =
      resolved.source === "project" ? flags.projectDefault : flags.userDefault;
    pushCheck(
      checks,
      "config_override_respected",
      !hasConfigOverride || resolved.format === expectedOverride,
      hasConfigOverride && resolved.format !== expectedOverride
        ? `config override expected ${String(expectedOverride)}, got ${resolved.format}`
        : undefined,
    );
  } catch (error) {
    if (error instanceof LAFSFlagError && error.code === "E_FORMAT_CONFLICT") {
      pushCheck(checks, "flag_conflict_rejected", true);
      return { ok: checks.every((check) => check.pass), checks };
    }
    pushCheck(checks, "flag_resolution", false, error instanceof Error ? error.message : String(error));
    return { ok: false, checks };
  }

  return { ok: checks.every((check) => check.pass), checks };
}
