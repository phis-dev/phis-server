import "server-only";

import { getPool, withTransaction } from "@/lib/db";
import {
  isPhiAuthLinkingMode,
  isPhiAuthFactorEnforcementMode,
  isPhiAuthRegistrationMode,
  isPhiAuthStage,
  type PhiAuthLinkingMode,
  type PhiAuthFactorPolicy,
  type PhiAuthMethodPresentation,
  type PhiAuthRegistrationMode,
  type PhiAuthStage,
} from "@/lib/site-auth/contracts";
import { toPhiRecord } from "@/lib/helpers/record";
import { requirePhiString } from "@/lib/helpers/string";

export type SiteAuthPolicy = {
  siteId: number;
  revision: number;
  registrationMode: PhiAuthRegistrationMode;
  existingAccountLinking: PhiAuthLinkingMode;
  allowPrivilegedAutoLink: boolean;
  passwordPolicy: Record<string, unknown>;
  passkeyPolicy: Record<string, unknown>;
  factorPolicy: PhiAuthFactorPolicy;
  recoveryPolicy: Record<string, unknown>;
  sessionPolicy: Record<string, unknown>;
  allowedCallbackOrigins: string[];
};

export type AuthProviderInstallationValidation = {
  status: "ok" | "failed" | "not-testable";
  testedAt: string;
  detail: string | null;
};

export type AuthProviderInstallation = {
  siteId: number;
  installationKey: string;
  providerKey: string;
  issuer: string;
  clientId: string;
  secretReference: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  /** Optional per-installation callback origin from the Site's allowedCallbackOrigins policy. */
  callbackOrigin: string | null;
  validation: AuthProviderInstallationValidation | null;
};

export type SiteAuthMethod = {
  siteId: number;
  methodKey: string;
  stage: PhiAuthStage;
  providerInstallationKey: string | null;
  enabled: boolean;
  sortOrder: number;
  presentation: PhiAuthMethodPresentation;
  provider: AuthProviderInstallation | null;
};

type SiteAuthConfiguration = {
  policy: Omit<SiteAuthPolicy, "siteId" | "revision">;
  methods: Array<Omit<SiteAuthMethod, "siteId" | "provider">>;
  providers: Array<Omit<AuthProviderInstallation, "siteId">>;
};

type ConfigRow = {
  site_id: number;
  config_version: number;
  policy_revision: number;
  config: unknown;
};

function createDefaultSiteAuthConfiguration(): SiteAuthConfiguration {
  return {
    policy: {
      registrationMode: "automatic",
      existingAccountLinking: "verified-email-confirm",
      allowPrivilegedAutoLink: false,
      passwordPolicy: {},
      passkeyPolicy: {},
      factorPolicy: {
        requiredMethod: null,
        enforcement: "next-login",
        graceUntil: null,
        roleFlags: 0,
      },
      recoveryPolicy: { recoveryCodes: true },
      sessionPolicy: {},
      allowedCallbackOrigins: [],
    },
    methods: [{
      methodKey: "password",
      stage: "primary",
      providerInstallationKey: null,
      enabled: true,
      sortOrder: 10,
      presentation: { label: "Email and password" },
    }],
    providers: [],
  };
}

export function parseSiteAuthFactorPolicy(value: unknown): PhiAuthFactorPolicy {
  const policy = toPhiRecord(value);
  const requiredMethod = policy.requiredMethod == null ? null : policy.requiredMethod;
  const enforcement = policy.enforcement ?? "next-login";
  const graceUntil = policy.graceUntil == null ? null : policy.graceUntil;
  const roleFlags = policy.roleFlags ?? 0;
  if (
    (requiredMethod !== null && requiredMethod !== "totp") ||
    !isPhiAuthFactorEnforcementMode(enforcement) ||
    (graceUntil !== null && (
      typeof graceUntil !== "string" ||
      !Number.isFinite(new Date(graceUntil).getTime())
    )) ||
    !Number.isInteger(roleFlags) ||
    (roleFlags as number) < 0
  ) {
    throw new Error("Invalid Site Auth factor policy.");
  }
  if (enforcement === "grace" && graceUntil === null) {
    throw new Error("A grace enforcement policy requires graceUntil.");
  }
  return {
    requiredMethod,
    enforcement,
    graceUntil,
    roleFlags: roleFlags as number,
  };
}

export function parseSiteAuthConfiguration(siteId: number, value: unknown): SiteAuthConfiguration {
  const root = toPhiRecord(value);
  const policyValue = toPhiRecord(root.policy);
  const registrationMode = policyValue.registrationMode;
  const existingAccountLinking = policyValue.existingAccountLinking;
  if (!isPhiAuthRegistrationMode(registrationMode) || !isPhiAuthLinkingMode(existingAccountLinking)) {
    throw new Error(`Invalid Site Auth policy for site ${siteId}.`);
  }
  if (!Array.isArray(policyValue.allowedCallbackOrigins) ||
      policyValue.allowedCallbackOrigins.some((origin) => typeof origin !== "string")) {
    throw new Error(`Invalid Site Auth callback origins for site ${siteId}.`);
  }
  if (!Array.isArray(root.providers) || !Array.isArray(root.methods)) {
    throw new Error(`Invalid Site Auth configuration for site ${siteId}.`);
  }
  const providers = root.providers.map((raw, index) => {
    const provider = toPhiRecord(raw);
    const secretReference = provider.secretReference == null
      ? null
      : requirePhiString(provider.secretReference, `Auth provider ${index} secretReference`);
    if (typeof provider.enabled !== "boolean") {
      throw new Error(`Invalid Auth provider ${index} enabled state.`);
    }
    const callbackOrigin = provider.callbackOrigin == null
      ? null
      : requirePhiString(provider.callbackOrigin, `Auth provider ${index} callbackOrigin`);
    const validationValue = provider.validation == null ? null : toPhiRecord(provider.validation);
    const validationStatus = validationValue?.status;
    const validation: AuthProviderInstallationValidation | null = validationValue &&
      (validationStatus === "ok" || validationStatus === "failed" || validationStatus === "not-testable") &&
      typeof validationValue.testedAt === "string"
        ? {
            status: validationStatus,
            testedAt: validationValue.testedAt,
            detail: typeof validationValue.detail === "string" ? validationValue.detail : null,
          }
        : null;
    return {
      installationKey: requirePhiString(
        provider.installationKey,
        `Auth provider ${index} installationKey`,
      ),
      providerKey: requirePhiString(provider.providerKey, `Auth provider ${index} providerKey`),
      issuer: requirePhiString(provider.issuer, `Auth provider ${index} issuer`),
      clientId: requirePhiString(provider.clientId, `Auth provider ${index} clientId`),
      secretReference,
      config: toPhiRecord(provider.config),
      enabled: provider.enabled,
      callbackOrigin,
      validation,
    };
  });
  if (new Set(providers.map((provider) => provider.installationKey)).size !== providers.length) {
    throw new Error(`Duplicate Auth provider installation for site ${siteId}.`);
  }
  const providerKeys = new Set(providers.map((provider) => provider.installationKey));
  const methods = root.methods.map((raw, index) => {
    const method = toPhiRecord(raw);
    const stage = method.stage;
    if (!isPhiAuthStage(stage) || typeof method.enabled !== "boolean" || !Number.isInteger(method.sortOrder)) {
      throw new Error(`Invalid Auth method ${index} for site ${siteId}.`);
    }
    const providerInstallationKey = method.installationKey == null
      ? null
      : requirePhiString(method.installationKey, `Auth method ${index} installationKey`);
    if (providerInstallationKey && !providerKeys.has(providerInstallationKey)) {
      throw new Error(`Unknown Auth provider installation ${providerInstallationKey}.`);
    }
    return {
      methodKey: requirePhiString(method.methodKey, `Auth method ${index} methodKey`),
      stage,
      providerInstallationKey,
      enabled: method.enabled,
      sortOrder: method.sortOrder as number,
      presentation: toPhiRecord(method.presentation) as PhiAuthMethodPresentation,
    };
  });
  if (
    new Set(methods.map((method) =>
      `${method.methodKey}\u0000${method.stage}\u0000${method.providerInstallationKey ?? ""}`,
    )).size !== methods.length
  ) {
    throw new Error(`Duplicate Auth method/stage/installation for site ${siteId}.`);
  }
  return {
    policy: {
      registrationMode,
      existingAccountLinking,
      allowPrivilegedAutoLink: policyValue.allowPrivilegedAutoLink === true,
      passwordPolicy: toPhiRecord(policyValue.passwordPolicy),
      passkeyPolicy: toPhiRecord(policyValue.passkeyPolicy),
      factorPolicy: parseSiteAuthFactorPolicy(policyValue.factorPolicy),
      recoveryPolicy: toPhiRecord(policyValue.recoveryPolicy),
      sessionPolicy: toPhiRecord(policyValue.sessionPolicy),
      allowedCallbackOrigins: policyValue.allowedCallbackOrigins as string[],
    },
    methods,
    providers,
  };
}

function mapConfigRow(row: ConfigRow) {
  if (row.config_version !== 1) {
    throw new Error(`Unsupported Site Auth config version ${row.config_version}.`);
  }
  return {
    ...parseSiteAuthConfiguration(row.site_id, row.config),
    revision: row.policy_revision,
  };
}

async function getSiteAuthConfiguration(siteId: number) {
  const { rows } = await getPool().query<ConfigRow>(
    `SELECT site_id, config_version, policy_revision, config
     FROM phis.site_auth_config
     WHERE site_id = $1
     LIMIT 1`,
    [siteId],
  );
  return rows[0] ? mapConfigRow(rows[0]) : null;
}

async function updateSiteAuthConfiguration(
  siteId: number,
  update: (current: SiteAuthConfiguration) => SiteAuthConfiguration,
) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO phis.site_auth_config (site_id)
       VALUES ($1)
       ON CONFLICT (site_id) DO NOTHING`,
      [siteId],
    );
    const { rows } = await client.query<ConfigRow>(
      `SELECT site_id, config_version, policy_revision, config
       FROM phis.site_auth_config
       WHERE site_id = $1
       FOR UPDATE`,
      [siteId],
    );
    const next = update(rows[0] ? mapConfigRow(rows[0]) : createDefaultSiteAuthConfiguration());
    const validated = parseSiteAuthConfiguration(siteId, {
      policy: next.policy,
      methods: next.methods.map((method) => ({
        ...method,
        installationKey: method.providerInstallationKey,
      })),
      providers: next.providers,
    });
    await client.query(
      `UPDATE phis.site_auth_config
       SET config = $2::jsonb,
           policy_revision = policy_revision + 1,
           updated_at = NOW()
       WHERE site_id = $1`,
      [siteId, JSON.stringify({
        policy: validated.policy,
        methods: validated.methods.map((method) => ({
          methodKey: method.methodKey,
          stage: method.stage,
          installationKey: method.providerInstallationKey,
          enabled: method.enabled,
          sortOrder: method.sortOrder,
          presentation: method.presentation,
        })),
        providers: validated.providers,
      })],
    );
    return {
      ...validated,
      revision: rows[0].policy_revision + 1,
    };
  });
}

export async function getSiteAuthPolicy(siteId: number) {
  const config = await getSiteAuthConfiguration(siteId);
  return config ? { siteId, revision: config.revision, ...config.policy } : null;
}

export async function upsertSiteAuthPolicy(
  input: Omit<SiteAuthPolicy, "revision"> & { revision?: number },
) {
  const { siteId, revision: _revision, ...policy } = input;
  void _revision;
  const config = await updateSiteAuthConfiguration(siteId, (current) => ({ ...current, policy }));
  return { siteId, revision: config.revision, ...config.policy };
}

export async function listSiteAuthMethods(siteId: number, stage?: PhiAuthStage) {
  const config = await getSiteAuthConfiguration(siteId);
  if (!config) return [];
  const providers = new Map(config.providers.map((provider) => [provider.installationKey, provider]));
  return config.methods
    .filter((method) => !stage || method.stage === stage)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.methodKey.localeCompare(right.methodKey))
    .map((method): SiteAuthMethod => ({
      siteId,
      ...method,
      provider: method.providerInstallationKey
        ? { siteId, ...providers.get(method.providerInstallationKey)! }
        : null,
    }));
}

/**
 * Resolves one method row. With `providerInstallationKey` given (string or null) the match is
 * exact; without it, the first enabled row for the method key wins (sortOrder-first), falling back
 * to the first row — the single-installation shortcut used by provider-agnostic callers.
 */
export async function getSiteAuthMethod(
  siteId: number,
  methodKey: string,
  stage: PhiAuthStage,
  providerInstallationKey?: string | null,
) {
  const methods = (await listSiteAuthMethods(siteId, stage))
    .filter((method) => method.methodKey === methodKey);
  if (providerInstallationKey !== undefined) {
    return methods.find((method) => method.providerInstallationKey === providerInstallationKey) ?? null;
  }
  return methods.find((method) => method.enabled) ?? methods[0] ?? null;
}

export async function upsertSiteAuthMethod(input: Omit<SiteAuthMethod, "provider">) {
  const { siteId, ...method } = input;
  await updateSiteAuthConfiguration(siteId, (current) => ({
    ...current,
    methods: [
      ...current.methods.filter((entry) =>
        entry.methodKey !== method.methodKey ||
        entry.stage !== method.stage ||
        entry.providerInstallationKey !== method.providerInstallationKey),
      method,
    ],
  }));
  return getSiteAuthMethod(input.siteId, input.methodKey, input.stage, input.providerInstallationKey);
}

/**
 * Removes one provider installation together with every method row coupled to it. The caller owns
 * the lockout guard; this function is pure removal.
 */
export async function deleteAuthProviderInstallation(siteId: number, installationKey: string) {
  await updateSiteAuthConfiguration(siteId, (current) => ({
    ...current,
    methods: current.methods.filter((method) => method.providerInstallationKey !== installationKey),
    providers: current.providers.filter((provider) => provider.installationKey !== installationKey),
  }));
}

/**
 * Counts the Site's member identities linked through an issuer. Identities hang off the issuer
 * (installations of the same provider share it), so the count is per issuer, scoped to users with
 * a membership on this Site.
 */
export async function countSiteUserIdentitiesByIssuer(siteId: number, issuer: string) {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM phis.user_auth_identities i
     JOIN phis.user_site_memberships m ON m.user_id = i.user_id AND m.site_id = $1
     WHERE i.issuer = $2`,
    [siteId, issuer],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function listAuthProviderInstallations(siteId: number) {
  const config = await getSiteAuthConfiguration(siteId);
  return (config?.providers ?? [])
    .sort((left, right) => left.installationKey.localeCompare(right.installationKey))
    .map((provider) => ({ siteId, ...provider }));
}

export async function upsertAuthProviderInstallation(
  input: AuthProviderInstallation,
) {
  const { siteId, ...provider } = input;
  const config = await updateSiteAuthConfiguration(siteId, (current) => ({
    ...current,
    providers: [
      ...current.providers.filter((entry) => entry.installationKey !== provider.installationKey),
      provider,
    ],
  }));
  const stored = config.providers.find((entry) => entry.installationKey === provider.installationKey)!;
  return { siteId, ...stored };
}

export async function getUserIdByExternalIdentity(issuer: string, subject: string) {
  const pool = getPool();
  const { rows } = await pool.query<{ user_id: number }>(
    `SELECT user_id
     FROM phis.user_auth_identities
     WHERE issuer = $1 AND subject = $2
     LIMIT 1`,
    [issuer, subject],
  );
  return rows[0]?.user_id ?? null;
}

export async function linkExternalIdentity(input: {
  userId: number;
  issuer: string;
  subject: string;
  providerKey: string;
}) {
  const pool = getPool();
  const { rows } = await pool.query<{ user_id: number }>(
    `INSERT INTO phis.user_auth_identities (user_id, issuer, subject, provider_key, last_used_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (issuer, subject) DO UPDATE
     SET last_used_at = NOW()
     WHERE phis.user_auth_identities.user_id = EXCLUDED.user_id
     RETURNING user_id`,
    [input.userId, input.issuer, input.subject, input.providerKey],
  );
  if (rows[0]?.user_id !== input.userId) {
    throw new Error("IDENTITY_CONFLICT");
  }
}

export async function listUserAuthIdentities(userId: number) {
  const { rows } = await getPool().query<{
    id: number;
    provider_key: string;
    issuer: string;
    created_at: string | Date;
    last_used_at: string | Date | null;
  }>(
    `SELECT id, provider_key, issuer, created_at, last_used_at
     FROM phis.user_auth_identities
     WHERE user_id = $1
     ORDER BY provider_key, id`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    providerKey: row.provider_key,
    issuer: row.issuer,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  }));
}

export type AuthTransactionRecord = {
  id: string;
  siteId: number;
  providerInstallationKey: string | null;
  userId: number | null;
  methodKey: string;
  stage: PhiAuthStage;
  stateHash: string;
  nonceHash: string | null;
  payloadCiphertext: string;
  payloadIv: string;
  payloadAuthTag: string;
  nextPath: string;
  expiresAt: string;
  consumedAt: string | null;
};

type AuthTransactionRow = {
  id: string;
  site_id: number;
  provider_installation_key: string | null;
  user_id: number | null;
  method_key: string;
  stage: string;
  state_hash: string;
  nonce_hash: string | null;
  payload_ciphertext: string;
  payload_iv: string;
  payload_auth_tag: string;
  next_path: string;
  expires_at: string;
  consumed_at: string | null;
};

function mapTransaction(row: AuthTransactionRow): AuthTransactionRecord {
  if (!isPhiAuthStage(row.stage)) {
    throw new Error(`Invalid Auth transaction stage ${row.stage}.`);
  }
  return {
    id: row.id,
    siteId: row.site_id,
    providerInstallationKey: row.provider_installation_key,
    userId: row.user_id,
    methodKey: row.method_key,
    stage: row.stage,
    stateHash: row.state_hash,
    nonceHash: row.nonce_hash,
    payloadCiphertext: row.payload_ciphertext,
    payloadIv: row.payload_iv,
    payloadAuthTag: row.payload_auth_tag,
    nextPath: row.next_path,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export async function createAuthTransaction(input: AuthTransactionRecord) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO phis.auth_transactions (
       id, site_id, provider_installation_key, user_id, method_key, stage,
       state_hash, nonce_hash, payload_ciphertext, payload_iv, payload_auth_tag,
       next_path, expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      input.id,
      input.siteId,
      input.providerInstallationKey,
      input.userId,
      input.methodKey,
      input.stage,
      input.stateHash,
      input.nonceHash,
      input.payloadCiphertext,
      input.payloadIv,
      input.payloadAuthTag,
      input.nextPath,
      input.expiresAt,
    ],
  );
}

export async function consumeAuthTransaction(siteId: number, stateHash: string) {
  const pool = getPool();
  const { rows } = await pool.query<AuthTransactionRow>(
    `UPDATE phis.auth_transactions
     SET consumed_at = NOW()
     WHERE site_id = $1
       AND state_hash = $2
       AND consumed_at IS NULL
       AND expires_at > NOW()
     RETURNING id, site_id, provider_installation_key, user_id, method_key, stage,
               state_hash, nonce_hash, payload_ciphertext, payload_iv, payload_auth_tag,
               next_path, expires_at, consumed_at`,
    [siteId, stateHash],
  );
  return rows[0] ? mapTransaction(rows[0]) : null;
}

export async function deleteExpiredAuthTransactions() {
  await getPool().query(
    `DELETE FROM phis.auth_transactions
     WHERE expires_at < NOW() OR consumed_at < NOW() - INTERVAL '1 day'`,
  );
}
