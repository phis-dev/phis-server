/**
 * Which browser origins may deliver a body straight to a storage Provider.
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

export type PhiMediaStorageCorsAdapter = {
  storageIdentity(): string;
  applyCorsPolicy(origins: readonly string[]): Promise<void>;
};

export type PhiMediaStorageCorsProfile = {
  id: number;
  siteId: number;
  siteKey: string;
  providerId: string;
  config: Record<string, unknown>;
  secretReference: string | null;
  publicBaseUrl: string;
};

/** `null` skips a Profile: a Provider a browser never addresses has no rule to write. */
export type PhiMediaStorageCorsResolver =
  (profile: PhiMediaStorageCorsProfile) => Promise<PhiMediaStorageCorsAdapter | null>;

export type PhiMediaStorageCorsGroup = {
  identity: string;
  origins: string[];
  profiles: Array<{ profileId: number; siteKey: string }>;
  applied: boolean;
  error: string | null;
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
 * origins, writing one rule per storage -- and it holds no SQL, which is what lets it be shared at all.
 */
export async function reconcilePhiMediaStorageCorsWith(
  profiles: readonly PhiMediaStorageCorsProfile[],
  resolve: PhiMediaStorageCorsResolver,
): Promise<PhiMediaStorageCorsGroup[]> {
  const groups = new Map<string, {
    origins: Set<string>;
    profiles: Array<{ profileId: number; siteKey: string }>;
    // One Profile of the group is enough to write the rule; they address the same storage by definition.
    apply: (origins: readonly string[]) => Promise<void>;
  }>();

  const unresolved: PhiMediaStorageCorsGroup[] = [];
  for (const profile of profiles) {
    let adapter: PhiMediaStorageCorsAdapter | null;
    try {
      adapter = await resolve(profile);
    } catch (error) {
      // A Profile whose Provider cannot be reached at all -- an Add-on removed under it, an artifact
      // that no longer matches -- is reported and stepped over. Leaving every other storage
      // unreconciled because of it would turn one broken Profile into a broken installation.
      unresolved.push({
        identity: `profile:${profile.id}`,
        origins: [],
        profiles: [{ profileId: profile.id, siteKey: profile.siteKey }],
        applied: false,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
      continue;
    }
    if (!adapter) {
      continue;
    }
    const identity = adapter.storageIdentity();
    const group = groups.get(identity) ?? {
      origins: new Set<string>(),
      profiles: [],
      apply: (origins: readonly string[]) => adapter.applyCorsPolicy(origins),
    };
    const origin = readSiteOrigin(profile.publicBaseUrl);
    if (origin) {
      group.origins.add(origin);
    }
    group.profiles.push({ profileId: profile.id, siteKey: profile.siteKey });
    groups.set(identity, group);
  }

  const results: PhiMediaStorageCorsGroup[] = [];
  for (const [identity, group] of groups) {
    const origins = [...group.origins].sort();
    try {
      await group.apply(origins);
      results.push({ identity, origins, profiles: group.profiles, applied: true, error: null });
    } catch (error) {
      // One storage refusing must not stop the others: a rule that could not be written is a report,
      // not a reason to leave every other storage unreconciled.
      results.push({
        identity,
        origins,
        profiles: group.profiles,
        applied: false,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
    }
  }
  return [...unresolved, ...results];
}
