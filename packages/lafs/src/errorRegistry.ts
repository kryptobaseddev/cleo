import errorRegistry from "../schemas/v1/error-registry.json" with { type: "json" };
import type { LAFSAgentAction } from "./types.js";

export interface RegistryCode {
  code: string;
  category: string;
  description: string;
  retryable: boolean;
  httpStatus: number;
  grpcStatus: string;
  cliExit: number;
  agentAction?: string;
  typeUri?: string;
  docUrl?: string;
}

export interface ErrorRegistry {
  version: string;
  codes: RegistryCode[];
}

export type TransportMapping = {
  transport: "http" | "grpc" | "cli";
  value: number | string;
};

export function getErrorRegistry(): ErrorRegistry {
  return errorRegistry as ErrorRegistry;
}

export function isRegisteredErrorCode(code: string): boolean {
  const registry = getErrorRegistry();
  return registry.codes.some((item) => item.code === code);
}

export function getRegistryCode(code: string): RegistryCode | undefined {
  return getErrorRegistry().codes.find((item) => item.code === code);
}

export function getAgentAction(code: string): LAFSAgentAction | undefined {
  const entry = getRegistryCode(code);
  return entry?.agentAction as LAFSAgentAction | undefined;
}

export function getTypeUri(code: string): string | undefined {
  const entry = getRegistryCode(code);
  return entry?.typeUri;
}

export function getDocUrl(code: string): string | undefined {
  const entry = getRegistryCode(code);
  return entry?.docUrl;
}

export function getTransportMapping(
  code: string,
  transport: "http" | "grpc" | "cli",
): TransportMapping | null {
  const registryCode = getRegistryCode(code);
  if (!registryCode) {
    return null;
  }

  if (transport === "http") {
    return { transport, value: registryCode.httpStatus };
  }
  if (transport === "grpc") {
    return { transport, value: registryCode.grpcStatus };
  }
  return { transport, value: registryCode.cliExit };
}
