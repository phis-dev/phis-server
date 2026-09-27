import type { PhisMediaLifecyclePolicy } from "@phis/contracts/addon";

/**
 * What a storage has to be told about the Sites it serves: who may write to it, and what to clean up.
 *
 * Two rules, one occasion. Both are written when a Storage Profile is written, both belong to the storage
 * rather than to a Site, and both are derived rather than configured -- so reconciling them separately would
 * mean resolving every Provider twice to ask the same grouping question.
 *
 * The origins are not configured anywhere. They are derived: a Site's origin is what the registry
 * already says in `public_base_url`, and the Sites a storage serves are the ones whose Storage Profiles
 * resolve to it. Configuring them a second time would mean an origin that quietly goes stale the day a
 * Site moves, in a place nobody thinks to look.
 *
 * The rule belongs to the storage rather than to the Site, so Profiles are grouped by the Provider's own
 * `storageIdentity()`: two Sites sharing one bucket need one rule carrying both origins, and applying
 * each Site's rule in turn would leave whichever went last.
 *
 * How a Provider is reached differs between the Server and the CLI -- one has the application's aliases
 * and its own loader, the other has plain Node and the installed artifact -- so that is the one thing
 * handed in. Everything above it is the same question and lives here once.
 */

/**
 * How long a Client has to deliver a body, which is what both lifecycle figures below are measured from.
 *
 * It lives here rather than beside the upload routes because the storage rules are derived from it and this
 * module is the one place both the Server and the CLI can read. A session that outlived this is released by
 * the next `init` into its Space; what this number additionally decides is when the storage may throw away
 * what such a session left behind.
 */
export const PHI_MEDIA_UPLOAD_SESSION_TTL_MS = 1000 * 60 * 60 * 24;

/**
 * The days a storage waits before cleaning up after an upload nobody finished.
 *
 * One more day than a session may live, and not the same day. An object lifecycle rule takes whole days and
 * is evaluated asynchronously, so a rule of "one day" can fire on an upload that still has hours left --
 * and aborting a body somebody is in the middle of sending is worse than paying for it a little longer.
 */
export const PHI_MEDIA_STORAGE_LIFECYCLE_DAYS =
  Math.ceil(PHI_MEDIA_UPLOAD_SESSION_TTL_MS / (1000 * 60 * 60 * 24)) + 1;

/**
 * The key prefix a Site's staged bodies live under, in Core's key space.
 *
 * `buildPhisMediaUploadTempStorageKey` composes its keys from this, so the shape is stated once. A lifecycle
 * rule that expires staged objects needs exactly this and nothing wider: the prefix is what keeps an expiry
 * rule off every other object in the storage.
 */
export function buildPhiMediaUploadStagingKeyPrefix(input: {
  storageKeyPrefix: string | null | undefined;
  siteKey: string;
}) {
  /*
   * The same normalisation Core's key builder applies, because the prefix has to match the keys it writes
   * exactly. A rule pointing at `Sites/uploads-temp/…` while the objects are at `sites/uploads-temp/…` is a
   * rule that never fires, and nothing would say so -- the objects would simply stay.
   */
  const part = (value: string) => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/gu, "-")
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/")
    .replace(/^\/+|\/+$/gu, "");

  const normalizedPrefix = part(input.storageKeyPrefix ?? "");
  const prefix = !normalizedPrefix || normalizedPrefix.includes("..") ? "sites" : normalizedPrefix;
  const siteKey = part(input.siteKey);
  if (!siteKey) {
    throw new Error("Missing site key for an upload staging key prefix.");
  }
  return `${prefix}/uploads-temp/${siteKey}/`;
}

export type PhiMediaStoragePolicyAdapter = {
  storageIdentity(): string;
  applyCorsPolicy(origins: readonly string[]): Promise<void>;
  applyLifecyclePolicy(policy: PhisMediaLifecyclePolicy): Promise<void>;
};

export type PhiMediaStoragePolicyProfile = {
  id: number;
  siteId: number;
  siteKey: string;
  providerId: string;
  config: Record<string, unknown>;
  secretReference: string | null;
  publicBaseUrl: string;
  /** Core's own key prefix for this installation, which the staging prefix is composed from. */
  storageKeyPrefix: string;
};

/** `null` skips a Profile: a Provider a browser never addresses has no rule to write. */
export type PhiMediaStoragePolicyResolver =
  (profile: PhiMediaStoragePolicyProfile) => Promise<PhiMediaStoragePolicyAdapter | null>;

export type PhiMediaStoragePolicyGroup = {
  identity: string;
  origins: string[];
  /** The staging prefixes an expiry rule was written for, which is never the whole key space. */
  stagingKeyPrefixes: string[];
  profiles: Array<{ profileId: number; siteKey: string }>;
  applied: boolean;
  error: string | null;
  /** Reported apart from CORS: a storage may take one rule and refuse the other. */
  lifecycleApplied: boolean;
  lifecycleError: string | null;
};

/** The browser origin of a Site, as the registry states it. Anything unparseable is left out. */
function readSiteOrigin(publicBaseUrl: string) {
  try {
    return new URL(publicBaseUrl.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Takes the Profiles rather than a pool, because both callers reach the database differently.
 *
 * The Server asks its database layer; the CLI, which cannot import that layer, asks under its own
 * exemption. Either way the shared half is what follows -- grouping by storage identity, deriving the
 * origins and the staging prefixes, writing one rule of each kind per storage -- and it holds no SQL, which
 * is what lets it be shared at all.
 *
 * The two rules are reported apart because a storage may take one and refuse the other: an endpoint that
 * does not implement object lifecycle still has a CORS rule worth writing, and an operator reading the
 * output needs to know which half is in force.
 */
export async function reconcilePhiMediaStoragePoliciesWith(
  profiles: readonly PhiMediaStoragePolicyProfile[],
  resolve: PhiMediaStoragePolicyResolver,
): Promise<PhiMediaStoragePolicyGroup[]> {
  const groups = new Map<string, {
    origins: Set<string>;
    stagingKeyPrefixes: Set<string>;
    profiles: Array<{ profileId: number; siteKey: string }>;
    // One Profile of the group is enough to write the rules; they address the same storage by definition.
    applyCors: (origins: readonly string[]) => Promise<void>;
    applyLifecycle: (policy: PhisMediaLifecyclePolicy) => Promise<void>;
  }>();

  const unresolved: PhiMediaStoragePolicyGroup[] = [];
  for (const profile of profiles) {
    let adapter: PhiMediaStoragePolicyAdapter | null;
    try {
      adapter = await resolve(profile);
    } catch (error) {
      // A Profile whose Provider cannot be reached at all -- an Add-on removed under it, an artifact
      // that no longer matches -- is reported and stepped over. Leaving every other storage
      // unreconciled because of it would turn one broken Profile into a broken installation.
      unresolved.push({
        identity: `profile:${profile.id}`,
        origins: [],
        stagingKeyPrefixes: [],
        profiles: [{ profileId: profile.id, siteKey: profile.siteKey }],
        applied: false,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
        lifecycleApplied: false,
        lifecycleError: null,
      });
      continue;
    }
    if (!adapter) {
      continue;
    }
    const identity = adapter.storageIdentity();
    const group = groups.get(identity) ?? {
      origins: new Set<string>(),
      stagingKeyPrefixes: new Set<string>(),
      profiles: [],
      applyCors: (origins: readonly string[]) => adapter.applyCorsPolicy(origins),
      applyLifecycle: (policy: PhisMediaLifecyclePolicy) => adapter.applyLifecyclePolicy(policy),
    };
    const origin = readSiteOrigin(profile.publicBaseUrl);
    if (origin) {
      group.origins.add(origin);
    }
    /*
     * One prefix per Site rather than one for the storage. Two Sites sharing a bucket stage under
     * different prefixes, and an expiry rule wide enough to cover both would be wide enough to cover
     * everything else as well.
     */
    group.stagingKeyPrefixes.add(buildPhiMediaUploadStagingKeyPrefix({
      storageKeyPrefix: profile.storageKeyPrefix,
      siteKey: profile.siteKey,
    }));
    group.profiles.push({ profileId: profile.id, siteKey: profile.siteKey });
    groups.set(identity, group);
  }

  const results: PhiMediaStoragePolicyGroup[] = [];
  for (const [identity, group] of groups) {
    const origins = [...group.origins].sort();
    const stagingKeyPrefixes = [...group.stagingKeyPrefixes].sort();
    let applied = false;
    let error: string | null = null;
    let lifecycleApplied = false;
    let lifecycleError: string | null = null;

    try {
      await group.applyCors(origins);
      applied = true;
    } catch (caught) {
      // One storage refusing must not stop the others: a rule that could not be written is a report,
      // not a reason to leave every other storage unreconciled.
      error = caught instanceof Error ? caught.message.split("\n")[0] : String(caught);
    }

    try {
      await group.applyLifecycle({
        abortIncompleteMultipartUploadAfterDays: PHI_MEDIA_STORAGE_LIFECYCLE_DAYS,
        stagingKeyPrefixes,
        expireStagedObjectsAfterDays: PHI_MEDIA_STORAGE_LIFECYCLE_DAYS,
      });
      lifecycleApplied = true;
    } catch (caught) {
      lifecycleError = caught instanceof Error ? caught.message.split("\n")[0] : String(caught);
    }

    results.push({
      identity, origins, stagingKeyPrefixes, profiles: group.profiles,
      applied, error, lifecycleApplied, lifecycleError,
    });
  }
  return [...unresolved, ...results];
}
