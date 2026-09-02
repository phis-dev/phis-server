import { readFileSync } from "node:fs";
import path from "node:path";

import type { Pool } from "pg";

import { choosePhisMediaChecksumAlgorithm, PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/contracts/addon";
import type { PhisMediaStorageAdapter, PhisMediaStorageProbe } from "@phis/contracts/addon";

import { loadInstalledAddonRuntime, readAddonDesiredState } from "./addons.mts";
import { PHI_SERVER_SERVICE_KINDS } from "../lib/addons/core-services.ts";
import {
  reconcilePhiMediaStorageCorsWith,
  type PhiMediaStorageCorsAdapter,
} from "../lib/media-storage-cors-core.ts";
import { buildPhiSecretReference } from "../lib/secrets/reference.ts";

/**
 * Storage Profiles, as an operator writes them.
 *
 * A Profile carries endpoints, a bucket and the reference to a credential, which is deployment state of
 * the same kind as the secrets the CLI already owns -- a Site may not read a secret, so it may not
 * configure one either. What belongs to Site administration is the *selection*: which of the Profiles
 * already set up a Space uses. `use` exists here only because an operator has to be able to bootstrap
 * the first one before any Site surface exists.
 *
 * Nothing here knows what an S3 Profile needs. Validation is the Provider's own: the config is handed
 * to the very factory Core would call, and a Profile that the Provider refuses is never written.
 */

type FlagMap = Map<string, string | boolean>;

export type StorageProfileRecord = {
  id: number;
  siteId: number;
  key: string;
  providerId: string;
  config: Record<string, unknown>;
  secretReference: string | null;
};

function getOptionalFlag(flags: FlagMap, key: string) {
  const value = flags.get(key);
  return typeof value === "string" ? value.trim() : undefined;
}

function getRequiredFlag(flags: FlagMap, key: string) {
  const value = getOptionalFlag(flags, key);
  if (!value) {
    throw new Error(`Missing --${key}.`);
  }
  return value;
}

async function requireSite(pool: Pool, siteKey: string) {
  const { rows } = await pool.query<{ id: number; key: string }>(
    `SELECT id, key FROM phis.sites WHERE key = $1`,
    [siteKey],
  );
  if (!rows[0]) {
    throw new Error(`Site ${siteKey} does not exist.`);
  }
  return rows[0];
}

async function readProfiles(pool: Pool, siteId: number) {
  const { rows } = await pool.query<{
    id: number; site_id: number; key: string; provider_id: string;
    config: Record<string, unknown>; secret_reference: string | null;
  }>(
    `SELECT id, site_id, key, provider_id, config, secret_reference
     FROM phis.media_storage_profiles WHERE site_id = $1 ORDER BY key`,
    [siteId],
  );
  return rows.map((row): StorageProfileRecord => ({
    id: row.id,
    siteId: row.site_id,
    key: row.key,
    providerId: row.provider_id,
    config: row.config ?? {},
    secretReference: row.secret_reference,
  }));
}

/** `--config '{"...":"..."}'` or `--config @path/to.json`, because a bucket policy is not a shell argument. */
function readConfigFlag(flags: FlagMap, root: string) {
  const raw = getOptionalFlag(flags, "config");
  if (raw === undefined) {
    return null;
  }
  const text = raw.startsWith("@")
    ? readFileSync(path.resolve(root, raw.slice(1)), "utf8")
    : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--config must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Hands the configuration to the Provider that will have to live with it.
 *
 * The factory is the one Core resolves at runtime, reached through the installed artifact, so what the
 * CLI accepts and what the Server accepts cannot drift apart. It is called with a context whose secret
 * accessor throws: constructing a Provider must not need a credential, and one that reaches for it here
 * is telling us something worth failing on.
 */
async function validateProfileConfig(
  root: string,
  providerId: string,
  config: Record<string, unknown>,
) {
  if (providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) {
    const rootDir = config.rootDir;
    if (rootDir !== undefined && (typeof rootDir !== "string" || !path.isAbsolute(rootDir))) {
      throw new Error("Local storage rootDir must be an absolute path.");
    }
    const prefix = config.storageKeyPrefix;
    if (prefix !== undefined && (typeof prefix !== "string" || prefix.startsWith("/") || prefix.includes(".."))) {
      throw new Error("Local storage storageKeyPrefix must be relative and must not traverse.");
    }
    return;
  }

  const owner = findProviderEntry(root, providerId);
  if (!owner) {
    throw new Error(
      `No installed Add-on offers Media Storage provider ${providerId}. Install it before configuring a Profile for it.`,
    );
  }
  const { descriptor } = owner;

  const { runtime } = await loadInstalledAddonRuntime(root, owner.addonId);
  const factory = runtime.serviceFactories?.[descriptor.factoryExport];
  if (typeof factory !== "function") {
    throw new Error(
      `${owner.addonId} declares ${descriptor.factoryExport} but its artifact does not export it.`,
    );
  }

  factory(config, {
    providerId,
    siteKey: null,
    readSecret: () => {
      throw new Error("A Provider must not need a credential to be constructed.");
    },
  });
}

/** Which Add-on offers a Media Storage provider key, and under which descriptor. */
function findProviderEntry(root: string, providerId: string) {
  const state = readAddonDesiredState(root);
  for (const addon of state.addons) {
    const descriptor = addon.manifest.serviceProviders.find((provider) =>
      provider.serviceKind === PHI_SERVER_SERVICE_KINDS.mediaStorage &&
      provider.providerKey === providerId);
    if (descriptor) {
      return { addonId: addon.addonId, descriptor };
    }
  }
  return null;
}

function resolveSecretReference(
  root: string,
  flags: FlagMap,
  siteKey: string,
  providerId: string,
) {
  const explicit = getOptionalFlag(flags, "secret-reference");
  if (explicit) {
    return explicit;
  }
  const name = getOptionalFlag(flags, "secret-name");
  if (!name) {
    return undefined;
  }
  const addonId = findProviderEntry(root, providerId)?.addonId ?? null;
  return buildPhiSecretReference({
    owner: addonId ? { kind: "addon", addonId } : { kind: "core" },
    siteKey,
    name,
  });
}

/** Reads the credential a Profile names. The CLI already holds the key; `phis secret check` uses it. */
export type StorageSecretReader = (reference: string) => Promise<string | null>;

/**
 * Builds a Provider the way Core would, through the artifact the operator installed.
 *
 * Returns null for a Provider a browser never addresses -- Core's Local storage is reached only through
 * Core's own routes, so every request to it is same-origin and there is no rule to write.
 */
async function resolveProviderAdapter(
  root: string,
  providerId: string,
  config: Record<string, unknown>,
  secretReference: string | null,
  readSecret: StorageSecretReader,
): Promise<PhiMediaStorageCorsAdapter | null> {
  if (providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) {
    return null;
  }
  const owner = findProviderEntry(root, providerId);
  if (!owner) {
    throw new Error(`No installed Add-on offers Media Storage provider ${providerId}.`);
  }
  const { runtime } = await loadInstalledAddonRuntime(root, owner.addonId);
  const factory = runtime.serviceFactories?.[owner.descriptor.factoryExport];
  if (typeof factory !== "function") {
    throw new Error(
      `${owner.addonId} declares ${owner.descriptor.factoryExport} but its artifact does not export it.`,
    );
  }
  return factory(config, {
    providerId,
    siteKey: null,
    readSecret: () => (secretReference ? readSecret(secretReference) : Promise.resolve(null)),
  }) as PhiMediaStorageCorsAdapter;
}

/**
 * A Provider built for reading and removing objects, which the Local one does not need.
 *
 * Null there is the answer rather than a gap: `phis media check` and the purge both reach Core's own
 * storage through the filesystem, because its adapter carries a `server-only` import a CLI cannot load.
 */
export async function resolvePhiStorageObjectAdapter(
  root: string,
  providerId: string,
  config: Record<string, unknown>,
  secretReference: string | null,
  readSecret: StorageSecretReader,
) {
  const adapter = await resolveProviderAdapter(root, providerId, config, secretReference, readSecret);
  return adapter as unknown as {
    listPrefix(prefix: string): Promise<{ storageKey: string; byteSize: number }[]>;
    deleteObject(storageKey: string): Promise<boolean>;
  } | null;
}

/** The same construction as above, for the one call a probe makes. Local has no adapter to build. */
async function resolveProbeAdapter(
  root: string,
  providerId: string,
  config: Record<string, unknown>,
  secretReference: string | null,
  readSecret: StorageSecretReader,
): Promise<Pick<PhisMediaStorageAdapter, "probeCapabilities">> {
  const adapter = await resolveProviderAdapter(root, providerId, config, secretReference, readSecret);
  if (!adapter || typeof (adapter as { probeCapabilities?: unknown }).probeCapabilities !== "function") {
    throw new Error(
      `${providerId} does not offer a capability probe. Rebuild the Add-on against the current contract.`,
    );
  }
  return adapter as unknown as Pick<PhisMediaStorageAdapter, "probeCapabilities">;
}

/**
 * Writes every storage's CORS rule from the Site registry.
 *
 * A presigned upload is a cross-origin request, and the rule lives in the storage itself -- the
 * browser's preflight never reaches this platform at all. Someone therefore has to push it, and after a
 * Profile changed is exactly when it is wrong. The derivation is shared with the Server; only the way a
 * Provider is reached differs.
 */
export async function reconcileStorageCors(
  root: string,
  pool: Pool,
  readSecret: StorageSecretReader,
) {
  return reconcilePhiMediaStorageCorsWith(pool, (profile) =>
    resolveProviderAdapter(root, profile.providerId, profile.config, profile.secretReference, readSecret));
}

/**
 * Establishes what each configured endpoint can actually do, and records it.
 *
 * The Provider is one adapter over many storages -- AWS, MinIO, Garage -- and no field of a Profile
 * says which is on the other end. Asking the operator would be asking them to know their storage's
 * release notes; trying it costs one small object and answers for certain.
 *
 * It is also where a misconfigured Profile stops being the first uploader's problem. Today a wrong
 * endpoint, a missing permission or a bucket that is not there is discovered by whoever uploads first,
 * and reaches them as their error rather than as an unfinished setup.
 *
 * The Local Provider is skipped for the reason it is skipped for CORS: it is Core's own storage,
 * reached only through Core's own routes, and there is no remote claim for anyone to verify.
 */
export async function probeStorageProfiles(
  root: string,
  pool: Pool,
  flags: FlagMap,
  readSecret: StorageSecretReader,
) {
  const site = await requireSite(pool, getRequiredFlag(flags, "site"));
  const only = getOptionalFlag(flags, "key");
  const profiles = (await readProfiles(pool, site.id))
    .filter((profile) => !only || profile.key === only);
  if (only && profiles.length === 0) {
    throw new Error(`Site ${site.key} has no Storage Profile "${only}".`);
  }

  const results: StorageProfileProbeResult[] = [];

  for (const profile of profiles) {
    results.push(await probeOneStorageProfile(root, pool, profile, readSecret));
  }

  return { ok: true, action: "storage.probe" as const, site: site.key, profiles: results };
}

export type StorageProfileProbeResult = {
  key: string;
  providerId: string;
  probed: boolean;
  writable?: boolean;
  verifiedAlgorithms?: string[];
  verifiesWholeMultipartObject?: boolean;
  chosenAlgorithm?: string | null;
  findings: string[];
};

/**
 * Probes one Profile and records what it found.
 *
 * Separate from the command so the Profile commands can use it too: a capability is a property of an
 * endpoint under a configuration, so the moment that configuration is written is the moment to measure
 * it. Leaving that to a command an operator has to remember is what leaves a Profile in service with
 * nothing recorded -- and a Profile with nothing recorded cannot be given the upload plan that depends
 * on the endpoint checking a digest.
 */
export async function probeOneStorageProfile(
  root: string,
  pool: Pool,
  profile: { id: number; key: string; providerId: string; config: Record<string, unknown>; secretReference: string | null },
  readSecret: StorageSecretReader,
): Promise<StorageProfileProbeResult> {
  if (profile.providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) {
    return {
      key: profile.key,
      providerId: profile.providerId,
      probed: false,
      findings: ["Core's own storage: nothing is delivered to it by a client, so there is nothing to verify."],
    };
  }

  let probe: PhisMediaStorageProbe;
  try {
    const adapter = await resolveProbeAdapter(
      root, profile.providerId, profile.config, profile.secretReference, readSecret,
    );
    probe = await adapter.probeCapabilities();
  } catch (error) {
    // A Provider that cannot be built or refuses outright is an answer, and the operator wants it
    // recorded next to the ones that answered rather than losing the whole run to it.
    probe = {
      writable: false,
      verifiedAlgorithms: [],
      verifiesWholeMultipartObject: false,
      findings: [`The Provider could not be reached: ${
        error instanceof Error ? error.message.trim() : "no reason given"
      }`],
    };
  }

  // The digest this Profile will record, settled here rather than per upload: duplicate detection
  // compares digests, and two are only comparable under the same algorithm.
  const chosenAlgorithm = choosePhisMediaChecksumAlgorithm(probe);
  await pool.query(
    `UPDATE phis.media_storage_profiles
        SET probe = $2::jsonb, probed_at = NOW(), checksum_algorithm = $3, updated_at = NOW()
      WHERE id = $1`,
    [profile.id, JSON.stringify(probe), chosenAlgorithm],
  );
  return { key: profile.key, providerId: profile.providerId, probed: true, ...probe, chosenAlgorithm };
}

export async function listStorageProfiles(pool: Pool, flags: FlagMap) {
  const site = await requireSite(pool, getRequiredFlag(flags, "site"));
  const profiles = await readProfiles(pool, site.id);

  // Which Space uses which Profile is the other half of the answer, and reading it here saves a query
  // an operator would otherwise write by hand every time.
  const { rows: spaces } = await pool.query<{
    id: number; user_id: number | null; group_id: number | null; default_storage_profile_id: number;
  }>(
    `SELECT id, user_id, group_id, default_storage_profile_id
     FROM phis.media_spaces WHERE site_id = $1 ORDER BY id`,
    [site.id],
  );

  return {
    ok: true,
    action: "storage.list" as const,
    site: site.key,
    profiles,
    spaces: spaces.map((space) => ({
      spaceId: space.id,
      // A Space with no owner is the Site's own; that is what makes it the Site Space, not its number.
      scope: space.user_id != null ? "user" : space.group_id != null ? "group" : "site",
      userId: space.user_id,
      groupId: space.group_id,
      defaultStorageProfileId: space.default_storage_profile_id,
    })),
  };
}

export async function addStorageProfile(
  root: string,
  pool: Pool,
  flags: FlagMap,
  readSecret: StorageSecretReader,
) {
  const site = await requireSite(pool, getRequiredFlag(flags, "site"));
  const key = getRequiredFlag(flags, "key");
  const providerId = getRequiredFlag(flags, "provider");
  const config = readConfigFlag(flags, root) ?? {};
  const secretReference = resolveSecretReference(root, flags, site.key, providerId) ?? null;

  const existing = await readProfiles(pool, site.id);
  if (existing.some((profile) => profile.key === key)) {
    throw new Error(`Site ${site.key} already has a Storage Profile "${key}".`);
  }

  await validateProfileConfig(root, providerId, config);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id, config, secret_reference)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [site.id, key, providerId, JSON.stringify(config), secretReference],
  );

  const profile = { id: rows[0]!.id, key, providerId, config, secretReference };
  return {
    ok: true,
    action: "storage.add" as const,
    site: site.key,
    profile,
    // Measured now, while the operator is here to read the finding. A Profile that goes into service
    // with nothing recorded cannot be given the upload plan that depends on the endpoint checking a
    // digest, and the operator would find that out as somebody else's failed upload.
    probe: await probeOneStorageProfile(root, pool, profile, readSecret),
    cors: await reconcileStorageCors(root, pool, readSecret),
  };
}

export async function setStorageProfile(
  root: string,
  pool: Pool,
  flags: FlagMap,
  readSecret: StorageSecretReader,
) {
  const site = await requireSite(pool, getRequiredFlag(flags, "site"));
  const key = getRequiredFlag(flags, "key");
  const profiles = await readProfiles(pool, site.id);
  const existing = profiles.find((profile) => profile.key === key);
  if (!existing) {
    throw new Error(`Site ${site.key} has no Storage Profile "${key}".`);
  }

  const patch = readConfigFlag(flags, root);
  // Merged unless asked otherwise: changing one endpoint should not mean retyping a bucket, and a
  // removal is rare enough to say out loud.
  const replace = Boolean(flags.get("replace"));
  const config = patch === null
    ? existing.config
    : replace ? patch : { ...existing.config, ...patch };

  const secretReference =
    resolveSecretReference(root, flags, site.key, existing.providerId) ?? existing.secretReference;

  await validateProfileConfig(root, existing.providerId, config);

  await pool.query(
    `UPDATE phis.media_storage_profiles
     SET config = $3::jsonb, secret_reference = $4, updated_at = NOW()
     WHERE site_id = $1 AND key = $2`,
    [site.id, key, JSON.stringify(config), secretReference],
  );

  const profile = { id: existing.id, key, providerId: existing.providerId, config, secretReference };
  return {
    ok: true,
    action: "storage.set" as const,
    site: site.key,
    replaced: replace,
    profile,
    // The recorded answer described the endpoint the old configuration reached. Once that moved, it
    // describes somewhere else -- so it is replaced rather than left standing, even when the new
    // endpoint turns out to answer worse.
    probe: await probeOneStorageProfile(root, pool, profile, readSecret),
    cors: await reconcileStorageCors(root, pool, readSecret),
  };
}

export async function removeStorageProfile(pool: Pool, flags: FlagMap) {
  const site = await requireSite(pool, getRequiredFlag(flags, "site"));
  const key = getRequiredFlag(flags, "key");
  const profiles = await readProfiles(pool, site.id);
  const existing = profiles.find((profile) => profile.key === key);
  if (!existing) {
    throw new Error(`Site ${site.key} has no Storage Profile "${key}".`);
  }

  // A Profile still named by a Space or still carrying files is not a Profile to delete: the rows that
  // point at it are what tells us where those files are.
  const { rows: usedBySpaces } = await pool.query<{ count: string }>(
    `SELECT count(*)::text FROM phis.media_spaces
     WHERE site_id = $1 AND default_storage_profile_id = $2`,
    [site.id, existing.id],
  );
  const { rows: usedByAssets } = await pool.query<{ count: string }>(
    `SELECT count(*)::text FROM phis.media_assets WHERE storage_profile_id = $1`,
    [existing.id],
  );
  if (Number(usedBySpaces[0]?.count ?? 0) > 0 || Number(usedByAssets[0]?.count ?? 0) > 0) {
    throw new Error(
      `Storage Profile "${key}" is still used by ${usedBySpaces[0]?.count ?? 0} Space(s) and ` +
      `${usedByAssets[0]?.count ?? 0} Asset(s). Point them elsewhere first.`,
    );
  }

  await pool.query(
    `DELETE FROM phis.media_storage_profiles WHERE site_id = $1 AND key = $2`,
    [site.id, key],
  );
  return { ok: true, action: "storage.del" as const, site: site.key, key };
}

export async function useStorageProfile(pool: Pool, flags: FlagMap) {
  const site = await requireSite(pool, getRequiredFlag(flags, "site"));
  const key = getRequiredFlag(flags, "key");
  const profiles = await readProfiles(pool, site.id);
  const profile = profiles.find((entry) => entry.key === key);
  if (!profile) {
    throw new Error(`Site ${site.key} has no Storage Profile "${key}".`);
  }

  // The Site Space only. A Space belonging to a user or a group is that person's or that group's, and
  // pointing it somewhere else is Site administration rather than an operator's business.
  const { rowCount } = await pool.query(
    `UPDATE phis.media_spaces
     SET default_storage_profile_id = $2, updated_at = NOW()
     WHERE site_id = $1 AND user_id IS NULL AND group_id IS NULL`,
    [site.id, profile.id],
  );
  if (!rowCount) {
    throw new Error(
      `Site ${site.key} has no Site Space yet. It is created the first time media is used.`,
    );
  }

  return {
    ok: true,
    action: "storage.use" as const,
    site: site.key,
    key,
    profileId: profile.id,
    note: "Existing Assets keep the Profile they were written to; only new uploads follow this.",
  };
}
