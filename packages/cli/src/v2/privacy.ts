/**
 * Effective privacy policy (PLAN-V2 §3.1): today the `--allow-insecure-private-store` flag and the
 * `MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE` environment variable feed different channels
 * (store/report options vs. the preflight permission probe), which lets a run disagree with itself
 * (§8.1 item 4, §9.1 "política de privacidade difere entre preflight e execução").
 *
 * One operation resolves both declarations exactly once, refuses an inconsistent or unrecognized
 * declaration without ever widening permissions, and then propagates the effective policy to every
 * channel (the environment variable included) so preflight, store and report always agree.
 * `WEAK_PRIVATE_PERMISSIONS` / `DEGRADED_ISOLATION` disclosures remain expected evidence whenever
 * the effective policy is degraded — never a failure, and never silently dropped.
 */
export const PRIVACY_ENV = 'MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE';

export interface EffectivePrivacyPolicy {
  readonly mode: 'STRICT' | 'DEGRADED_INSECURE';
  readonly allowInsecurePrivateStore: boolean;
  readonly source: 'default' | 'flag' | 'environment' | 'flag+environment';
}

export interface PrivacyDeclarations {
  /** The `--allow-insecure-private-store` flag of this invocation. */
  allowInsecurePrivateStore?: boolean;
  /** The environment value as seen by this operation; undefined when the variable is unset. */
  env?: string | undefined;
}

/** Raised instead of guessing which declaration wins: the operation refuses, permissions never widen. */
export class PrivacyPolicyConflictError extends Error {
  constructor() {
    super(`Conflicting privacy declarations: --allow-insecure-private-store opts in to degraded private storage while ${PRIVACY_ENV} declares otherwise. Set the variable to "1" or unset it; permissions are never widened silently.`);
    this.name = 'PrivacyPolicyConflictError';
  }
}

/** Refuse a conflict: the flag opts in while the environment declares something else. Strict stays the fallback. */
export function resolvePrivacyPolicy(input: PrivacyDeclarations): EffectivePrivacyPolicy {
  const flag = input.allowInsecurePrivateStore === true;
  const env = input.env;
  if (flag && env !== undefined && env !== '' && env !== '1') throw new PrivacyPolicyConflictError();
  const environment = env === '1';
  const degraded = flag || environment;
  return {
    mode: degraded ? 'DEGRADED_INSECURE' : 'STRICT',
    allowInsecurePrivateStore: degraded,
    source: degraded ? (flag && environment ? 'flag+environment' : flag ? 'flag' : 'environment') : 'default',
  };
}

/**
 * Propagate the resolved policy to the environment-fed channels (permission probe, engine stores,
 * report privacy stamping) so no channel can disagree with the decision this operation made.
 * Called once per operation, before any engine call.
 */
export function applyPrivacyPolicy(policy: EffectivePrivacyPolicy): void {
  if (policy.allowInsecurePrivateStore) process.env[PRIVACY_ENV] = '1';
  else if (process.env[PRIVACY_ENV] === '1') delete process.env[PRIVACY_ENV];
}
