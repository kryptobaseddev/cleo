/**
 * Release channel contracts — types describing the npm dist-tag channel
 * model used by the release pipeline.
 *
 * The implementation (branch→channel resolution, version validation) lives
 * in `@cleocode/core/release/channel.ts`. The types live here so consumers
 * can describe / validate the same shapes without depending on core.
 *
 * @adr ADR-063
 */

/** npm dist-tag channel for a release. */
export type ReleaseChannel = 'latest' | 'beta' | 'alpha';

/** Result of validating a version string against a channel's expectations. */
export interface ChannelValidationResult {
  valid: boolean;
  expected?: string;
  actual?: string;
  message: string;
}
