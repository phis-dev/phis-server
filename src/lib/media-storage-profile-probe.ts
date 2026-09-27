import "server-only";

import { choosePhisMediaChecksumAlgorithm } from "@phis/contracts/addon";
import type { PhisMediaStorageProbe } from "@phis/contracts/addon";

import {
  readMediaStorageProfileProbe,
  writeMediaStorageProfileProbe,
} from "@/db/media-spaces";
import {
  createPhisMediaStorageServiceForProfile,
  PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID,
} from "@/lib/media-storage";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";

/**
 * What Core's own storage can do, without asking it.
 *
 * Local is reached only through Core's own routes, so no client ever hands it bytes and there is no
 * remote claim for anyone to verify. Answering from here rather than from a recorded probe keeps a
 * Local Profile's `probed_at` empty, which is the same thing the operator command reports about it.
 */
const LOCAL_PROBE: PhisMediaStorageProbe = {
  writable: true,
  verifiedAlgorithms: [],
  findings: ["Core's own storage: nothing is delivered to it by a client, so there is nothing to verify."],
};

export type PhiMediaStorageProfileForProbe = {
  id: number;
  siteId: number;
  providerId: string;
  config: Record<string, unknown> | null;
  secretReference?: string | null;
};

/**
 * The probe for a Profile, running one if nothing was ever recorded.
 *
 * A capability nobody measured is not a capability, and the decision that reads it -- whether a body
 * may go straight to the Provider and still yield a trustworthy digest -- has no safe default it could
 * fall back on. `phis storage probe` and the Profile commands cover the operator's paths, but a Profile
 * can also reach an upload without having passed through either: restored from a dump, written by a
 * migration, or configured before the probe existed. This is the case those leave.
 *
 * Which makes it the one thing the maintenance contract allows a request to do: the request that needs
 * the result is the one that pays for it, once, and every request after it reads what was written.
 *
 * A failed probe is recorded like any other answer, and the failure is not retried per request. An
 * endpoint that is unreachable now would otherwise be dialled again on every upload into it, and the
 * uploads would stall behind the same timeout every time. What such a Profile has is a recorded finding
 * saying so, and the operator's `phis storage probe` to try it again once the cause is fixed.
 *
 * Two requests arriving together will both probe, and the second overwrites the first with the same
 * answer. That is cheaper than what preventing it would cost, and the maintenance contract rules out
 * the lock it would take.
 */
export async function ensurePhiMediaStorageProfileProbe(
  profile: PhiMediaStorageProfileForProbe,
  siteKey?: string | null,
): Promise<PhisMediaStorageProbe | null> {
  if (profile.providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) return LOCAL_PROBE;

  const recorded = await readMediaStorageProfileProbe(profile.siteId, profile.id);
  if (!recorded) return null;
  if (recorded.probedAt) return recorded.probe;

  let probe: PhisMediaStorageProbe;
  try {
    const service = await createPhisMediaStorageServiceForProfile(
      {
        providerId: profile.providerId as never,
        config: profile.config,
        secretReference: profile.secretReference ?? null,
        siteId: profile.siteId,
      },
      siteKey ?? null,
    );
    probe = await service.probeCapabilities();
  } catch (error) {
    // A Provider that cannot be built or refuses outright is an answer too, and it is the answer that
    // keeps the upload on the path that does not depend on the endpoint checking anything.
    probe = {
      writable: false,
      verifiedAlgorithms: [],
      findings: [`The Provider could not be reached: ${
        error instanceof Error ? error.message.trim() : "no reason given"
      }`],
    };
    logRuntimeEvent("warn", "media.storage.probe.failed", {
      message: "A Storage Profile could not be probed on first use.",
      siteKey: siteKey ?? null,
      error: normalizeLogThrowable(error),
      meta: { storageProfileId: profile.id, providerId: profile.providerId },
    });
  }

  await writeMediaStorageProfileProbe(
    profile.siteId, profile.id, probe, choosePhisMediaChecksumAlgorithm(probe),
  );
  logRuntimeEvent("info", "media.storage.probe.recorded", {
    message: "A Storage Profile was probed on first use.",
    siteKey: siteKey ?? null,
    meta: {
      storageProfileId: profile.id,
      providerId: profile.providerId,
      writable: probe.writable,
      verifiedAlgorithms: probe.verifiedAlgorithms.join(",") || "none",
      chosenAlgorithm: choosePhisMediaChecksumAlgorithm(probe) ?? "none",
      findings: probe.findings.length,
    },
  });
  return probe;
}

/*
 * Whether a body arrives in parts is not probed and is not a property of the Profile.
 *
 * It used to be: the permission followed from the probe answering whether a whole-object digest survives
 * an assembly. That answer can never be yes -- `ChecksumType: FULL_OBJECT` is accepted for the CRC
 * algorithms alone -- so the permission never opened. It is a size question now, in
 * `phiMediaUploadMayAssembleFromParts`, and what an assembled object carries is `sha256-composite`.
 */

/**
 * The digest this Profile records for a body delivered straight to the endpoint, probing once if
 * nobody ever asked.
 *
 * Null means no digest may be asserted, and the body goes through Core to be hashed there instead.
 * Absent evidence reads as null: treating silence as a yes is how an unverified digest ends up
 * recorded as a checked one.
 */
export async function phiMediaStorageProfileChecksumAlgorithm(
  profile: PhiMediaStorageProfileForProbe,
  siteKey?: string | null,
): Promise<string | null> {
  if (profile.providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) return null;

  /*
   * The recorded choice, read rather than derived afresh.
   *
   * Deriving it every time would work today, because the rule is deterministic -- and would quietly
   * stop working the day the rule changes, moving every already-probed Profile onto a new algorithm
   * and splitting its Space's objects into two cohorts that can never be told to match. The column
   * exists so that a choice, once made, stays made until somebody probes again.
   */
  const recorded = await readMediaStorageProfileProbe(profile.siteId, profile.id);
  if (!recorded) return null;
  if (recorded.probedAt) return recorded.checksumAlgorithm;

  await ensurePhiMediaStorageProfileProbe(profile, siteKey);
  return (await readMediaStorageProfileProbe(profile.siteId, profile.id))?.checksumAlgorithm ?? null;
}
