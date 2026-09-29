/**
 * Stderr UI for an RFC 8628 device-code login: the verification URL and user
 * code, the in-place polling counter, and the approval line.
 *
 * Shared by the kimi-code LLM login (`cleo llm login kimi-code`) and the
 * Cleo Nexus account login (`cleo login nexus`). Everything goes to stderr:
 * stdout carries exactly one LAFS envelope (ADR-086).
 *
 * @task T9323
 * @task T12712
 */

/** The fields of a device-code start response the prompt shows. */
export interface DeviceCodePromptInfo {
  /** Code the user enters. */
  userCode: string;
  /** URL the user visits. */
  verificationUri: string;
  /** URL with the code pre-filled, when the server sent one. */
  verificationUriComplete?: string;
  /** Seconds until the code expires. */
  expiresIn: number;
}

/**
 * Print where to go, the code to enter, and how long the code lasts.
 *
 * @param info - Device-code start response.
 * @param serviceName - Name shown in the waiting line (e.g. `Kimi Code`).
 */
export function writeDeviceCodePrompt(info: DeviceCodePromptInfo, serviceName: string): void {
  process.stderr.write('\n');
  process.stderr.write(`  Visit:      ${info.verificationUriComplete ?? info.verificationUri}\n`);
  process.stderr.write(`  Enter code: ${info.userCode}\n`);
  process.stderr.write('\n');
  process.stderr.write(
    `  Waiting for ${serviceName} authorization (up to ${Math.round(info.expiresIn / 60)} min)...\n`,
  );
}

/**
 * Rewrite the polling counter in place.
 *
 * @param elapsed - Seconds since polling started.
 */
export function writeDeviceCodePending(elapsed: number): void {
  // In-place progress during device-code polling; stderr per ADR-086.
  process.stderr.write(`\r  Polling... ${elapsed}s elapsed`); // raw-cr-allowed
}

/** End the polling line after a failure. */
export function writeDeviceCodeInterrupted(): void {
  process.stderr.write('\n');
}

/**
 * Replace the polling line with the approval line.
 *
 * @param serviceName - Name shown (e.g. `Kimi Code`).
 */
export function writeDeviceCodeApproved(serviceName: string): void {
  // Clears the `Polling...` line above; stderr per ADR-086.
  process.stderr.write(`\r  ${serviceName} authorization approved.              \n\n`); // raw-cr-allowed
}
