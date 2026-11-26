import "server-only";

import { createHash } from "node:crypto";

import {
  PHIS_MEDIA_SOURCE_CURSOR_MAX_LENGTH,
  PHIS_MEDIA_SOURCE_ITEM_ID_MAX_LENGTH,
  PHIS_MEDIA_SOURCE_PAGE_MAX_ITEMS,
  PHIS_MEDIA_SOURCE_QUERY_MAX_LENGTH,
  PHIS_MEDIA_SOURCE_TAKE_MAX_BYTES,
  PHIS_MEDIA_SOURCE_TEXT_MAX_LENGTH,
  type PhisMediaSourceAdapterV1,
  type PhisMediaSourceItem,
  type PhisMediaSourceKind,
  type PhisMediaSourcePage,
  type PhisMediaSourceProbe,
  type PhisMediaSourceServiceContext,
} from "@phis/contracts/media-source";

import {
  getMediaAssetBySiteAndChecksum,
  getMediaFolderBySiteAndId,
  hasLockedMediaFolder,
  withMediaSourceImportLock,
} from "@/db/media";
import {
  ensureSiteMediaConfig,
  ensureSiteMediaSpace,
  getMediaStorageProfile,
  isPhiMediaObjectSizeAllowed,
  PhiMediaLifecycleStatus,
} from "@/db/media-spaces";
import { PhiMediaKind } from "@/lib/constants/media";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { inspectPhiMediaObject } from "@/lib/media-content-check";
import { openSiteMediaWriteStorage, writeSiteMediaAsset } from "@/lib/site-media-write";

/*
 * Taking a file from somewhere else into the Site's library: `@phis/server/service/media-source`
 * (design/MEDIA_SOURCES.md).
 *
 * Like Support Forwarding and unlike Media Storage, nothing is configured here: a source is any installed
 * implementation that resolves for this Site and says it is usable, and whoever has the picker open
 * chooses. What is chosen is imported as an ordinary Asset; nothing keeps a reference into the source.
 */

const PROBE_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 15_000;
const TAKE_TIMEOUT_MS = 60_000;

/**
 * What Core refuses with. The code is the wire's `error`, so a refusal of the library's own keeps the
 * code an upload's would have and the picker says it in the words it already has.
 */
export type MediaSourceErrorCode =
  | "invalid_request"
  | "media_source_not_found"
  | "media_source_unusable"
  | "media_source_failed"
  | "folder_not_found"
  | "folder_locked"
  | "media_asset_too_large"
  | "content_type_not_allowed"
  | "unsafe_svg_upload"
  | "image_too_large"
  | "media_quota_exceeded"
  | "storage_profile_unavailable"
  | "storage_profile_disabled"
  | "storage_provider_unavailable";

const ERROR_STATUS: Record<MediaSourceErrorCode, number> = {
  invalid_request: 400,
  media_source_not_found: 404,
  media_source_unusable: 409,
  media_source_failed: 502,
  folder_not_found: 404,
  folder_locked: 409,
  media_asset_too_large: 413,
  content_type_not_allowed: 415,
  unsafe_svg_upload: 400,
  image_too_large: 422,
  media_quota_exceeded: 413,
  storage_profile_unavailable: 503,
  storage_profile_disabled: 409,
  storage_provider_unavailable: 503,
};

export class MediaSourceError extends Error {
  constructor(
    readonly code: MediaSourceErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status() {
    return ERROR_STATUS[this.code];
  }
}

type Site = { id: number; key: string };

/** One implementation, built for one Site. */
type MediaSourceTarget = {
  providerKey: string;
  providerId: string;
  adapter: PhisMediaSourceAdapterV1;
};

/**
 * Where the implementations come from: the installed Add-ons in production, a list a test hands in.
 *
 * The resolver loads Add-on code and checks the registry; a test of what Core does around a source has
 * no business doing either.
 */
export type MediaSourceTargetSource = (site: Site) => Promise<MediaSourceTarget[]>;

const installedTargets: MediaSourceTargetSource = async (site) => {
  // Imported here rather than at the top, as the other service kinds do: the resolver reaches the
  // installed manifest, the registry and the database, and most requests never ask for a source.
  const { listPhisServiceProviders, resolvePhisServiceProvider } = await import("@/lib/addons/services");
  const { PHIS_SERVICE_KINDS } = await import("@/lib/addons/core-services");
  const { getPhisAddonInstalledManifest } = await import("@/lib/addons/installed");
  const { buildPhisAddonSecretsCapability } = await import("@/lib/addons/secrets-capability");
  const { buildPhisAddonSettingsCapability } = await import("@/lib/addons/settings-capability");

  const targets: MediaSourceTarget[] = [];
  for (const provider of listPhisServiceProviders(PHIS_SERVICE_KINDS.mediaSource)) {
    if (!provider.enabled || !provider.interfaceCurrent) continue;
    try {
      const resolved = await resolvePhisServiceProvider(
        PHIS_SERVICE_KINDS.mediaSource,
        provider.providerKey,
        { siteId: site.id },
      );
      // The implementation's own configuration on this Site, read the way its hooks and jobs read it.
      const context: PhisMediaSourceServiceContext = {
        providerId: resolved.addonId,
        siteKey: site.key,
        secrets: buildPhisAddonSecretsCapability({ addonId: resolved.addonId, siteKey: site.key }),
        settings: buildPhisAddonSettingsCapability({
          addonId: resolved.addonId,
          siteId: site.id,
          declared: getPhisAddonInstalledManifest()[resolved.addonId]?.manifest.settings ?? [],
        }),
      };
      const adapter = resolved.factory(null, context) as PhisMediaSourceAdapterV1;
      if (
        typeof adapter?.probe !== "function"
        || typeof adapter?.list !== "function"
        || typeof adapter?.take !== "function"
      ) {
        throw new Error(`${resolved.addonId} built something that is not a media source adapter.`);
      }
      targets.push({ providerKey: provider.providerKey, providerId: resolved.addonId, adapter });
    } catch (error) {
      // Not offered, and said where an operator looks: whoever has the picker open can do nothing about it.
      logRuntimeEvent("warn", "media.source.unavailable", {
        message: "A media source add-on could not be used on this Site.",
        siteKey: site.key,
        error: normalizeLogThrowable(error),
        meta: { providerKey: provider.providerKey },
      });
    }
  }
  return targets;
};

let targetSource: MediaSourceTargetSource = installedTargets;

/** For tests: answer with these implementations instead of the installed ones. Null restores them. */
export function setMediaSourceTargetSourceForTests(source: MediaSourceTargetSource | null) {
  targetSource = source ?? installedTargets;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** The probe's answer as the contract states it, or null where it does not hold. */
function readProbe(value: unknown): PhisMediaSourceProbe | null {
  if (!isRecord(value) || typeof value.usable !== "boolean" || !Array.isArray(value.sources)) return null;
  if (!Array.isArray(value.findings) || value.findings.some((finding) => typeof finding !== "string")) return null;
  const sources: PhisMediaSourceProbe["sources"] = [];
  for (const entry of value.sources) {
    if (!isRecord(entry) || !isNonEmptyString(entry.key, PHIS_MEDIA_SOURCE_ITEM_ID_MAX_LENGTH)) return null;
    if (!isNonEmptyString(entry.label, PHIS_MEDIA_SOURCE_TEXT_MAX_LENGTH)) return null;
    sources.push({ key: entry.key, label: entry.label });
  }
  return { usable: value.usable, sources, findings: value.findings as string[] };
}

async function probe(site: Site, target: MediaSourceTarget) {
  try {
    const answer = readProbe(await target.adapter.probe({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }));
    if (!answer) throw new Error("The probe answered something that is not a media source probe.");
    if (!answer.usable) {
      logRuntimeEvent("warn", "media.source.unusable", {
        message: "A media source add-on says it cannot be used on this Site.",
        siteKey: site.key,
        meta: { providerKey: target.providerKey, findings: answer.findings },
      });
    }
    return answer;
  } catch (error) {
    // A probe that throws has said "not usable" less clearly than it should have.
    logRuntimeEvent("warn", "media.source.probe_failed", {
      message: "A media source add-on did not answer its probe.",
      siteKey: site.key,
      error: normalizeLogThrowable(error),
      meta: { providerKey: target.providerKey },
    });
    return null;
  }
}

/**
 * One source as a single value: the implementation and its own key for the place, `<providerKey>#<key>`.
 *
 * The provider key comes first and never contains `#`; the source key is the implementation's own and is
 * split off at the first.
 */
export function formatMediaSource(providerKey: string, key: string) {
  return `${providerKey}#${key}`;
}

function parseMediaSource(value: string) {
  const at = value.indexOf("#");
  return at <= 0 || at === value.length - 1
    ? null
    : { providerKey: value.slice(0, at), key: value.slice(at + 1) };
}

/**
 * The sources this Site is offered right now: every source of every implementation that resolves here
 * and answers its probe with `usable`, by the name the implementation gives it.
 */
export async function listMediaSources(site: Site) {
  const implementations = await targetSource(site);
  const probed = await Promise.all(
    implementations.map(async (implementation) => ({ implementation, answer: await probe(site, implementation) })),
  );
  return probed.flatMap(({ implementation, answer }) =>
    answer?.usable
      ? answer.sources.map((source) => ({
        source: formatMediaSource(implementation.providerKey, source.key),
        label: source.label,
      }))
      : []);
}

/** The implementation and the source a request names, asked once more whether it can answer now. */
async function resolveSource(site: Site, address: string) {
  const chosen = parseMediaSource(address);
  const target = chosen
    ? (await targetSource(site)).find((candidate) => candidate.providerKey === chosen.providerKey)
    : undefined;
  if (!chosen || !target) {
    throw new MediaSourceError("media_source_not_found", "That is not a media source this Site is offered.");
  }
  const answer = await probe(site, target);
  if (!answer) {
    throw new MediaSourceError("media_source_failed", "The media source did not answer.");
  }
  if (!answer.usable) {
    throw new MediaSourceError("media_source_unusable", "That media source cannot be used right now.");
  }
  const place = answer.sources.find((candidate) => candidate.key === chosen.key);
  if (!place) {
    throw new MediaSourceError("media_source_not_found", "That is not a media source this Site is offered.");
  }
  return { target, place };
}

const KNOWN_KINDS = new Set<string>(Object.values(PhiMediaKind));

/** The page as the contract states it, rebuilt field by field, or null where anything does not hold. */
function readPage(
  value: unknown,
  asked: { limit: number; kinds: readonly PhisMediaSourceKind[] | null },
): PhisMediaSourcePage | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > asked.limit) return null;
  const items: PhisMediaSourceItem[] = [];
  for (const item of value.items) {
    if (!isRecord(item)) return null;
    if (!isNonEmptyString(item.id, PHIS_MEDIA_SOURCE_ITEM_ID_MAX_LENGTH)) return null;
    if (typeof item.kind !== "string" || !KNOWN_KINDS.has(item.kind)) return null;
    if (asked.kinds && !asked.kinds.includes(item.kind as PhisMediaSourceKind)) return null;
    if (typeof item.title !== "string" || item.title.length > PHIS_MEDIA_SOURCE_TEXT_MAX_LENGTH) return null;
    if (typeof item.thumbnailUrl !== "string") return null;
    let thumbnail: URL;
    try {
      thumbnail = new URL(item.thumbnailUrl);
    } catch {
      return null;
    }
    if (thumbnail.protocol !== "https:" || thumbnail.username || thumbnail.password) return null;
    for (const edge of [item.width, item.height]) {
      if (edge !== null && !(typeof edge === "number" && Number.isInteger(edge) && edge > 0)) return null;
    }
    if (item.credit !== null && !(typeof item.credit === "string" && item.credit.length <= PHIS_MEDIA_SOURCE_TEXT_MAX_LENGTH)) {
      return null;
    }
    items.push({
      id: item.id,
      kind: item.kind as PhisMediaSourceKind,
      title: item.title,
      thumbnailUrl: item.thumbnailUrl,
      width: item.width as number | null,
      height: item.height as number | null,
      credit: item.credit as string | null,
    });
  }
  if (value.nextCursor !== null && !isNonEmptyString(value.nextCursor, PHIS_MEDIA_SOURCE_CURSOR_MAX_LENGTH)) {
    return null;
  }
  return { items, nextCursor: value.nextCursor as string | null };
}

/** One page of one source, checked before it reaches a browser. */
export async function listMediaSourcePage(input: {
  site: Site;
  /** `<providerKey>#<key>`, as `listMediaSources` names it. */
  source: string;
  query: string | null;
  kinds: readonly string[];
  cursor: string | null;
  limit: number;
  locale: string;
}): Promise<PhisMediaSourcePage> {
  const cursor = input.cursor?.length ? input.cursor : null;
  if (cursor && cursor.length > PHIS_MEDIA_SOURCE_CURSOR_MAX_LENGTH) {
    throw new MediaSourceError("invalid_request", "That is not a cursor this source gave.");
  }
  const kinds = [...new Set(input.kinds)].filter((kind): kind is PhisMediaSourceKind => KNOWN_KINDS.has(kind));
  const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), PHIS_MEDIA_SOURCE_PAGE_MAX_ITEMS);
  const query = (input.query ?? "").trim().slice(0, PHIS_MEDIA_SOURCE_QUERY_MAX_LENGTH);
  const asked = kinds.length > 0 ? kinds : null;

  const { target, place } = await resolveSource(input.site, input.source);
  let answer: unknown;
  try {
    answer = await target.adapter.list({
      source: place.key,
      query,
      kinds: asked,
      cursor,
      limit,
      locale: input.locale,
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (error) {
    logRuntimeEvent("warn", "media.source.list_failed", {
      message: "A media source add-on did not answer a listing.",
      siteKey: input.site.key,
      error: normalizeLogThrowable(error),
      meta: { source: input.source },
    });
    throw new MediaSourceError("media_source_failed", `${place.label} did not answer.`);
  }
  const page = readPage(answer, { limit, kinds: asked });
  if (!page) {
    logRuntimeEvent("warn", "media.source.list_invalid", {
      message: "A media source add-on answered a listing out of contract.",
      siteKey: input.site.key,
      meta: { source: input.source },
    });
    throw new MediaSourceError("media_source_failed", `${place.label} answered with something that is not a page.`);
  }
  return page;
}

/** The text of a taken file that may be absent: null, or a string within the limit; undefined where it is neither. */
function readOptionalText(value: unknown) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.length <= PHIS_MEDIA_SOURCE_TEXT_MAX_LENGTH ? value : undefined;
}

/** What was taken, as the contract states it, or null where anything does not hold. */
function readFile(value: unknown) {
  if (!isRecord(value)) return null;
  const { bytes } = value;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PHIS_MEDIA_SOURCE_TAKE_MAX_BYTES) {
    return null;
  }
  if (typeof value.contentType !== "string" || !value.contentType.trim()) return null;
  if (typeof value.fileName !== "string") return null;
  // As an upload names its file: trimmed, and no longer than a text of the library may be.
  const fileName = value.fileName.trim().slice(0, PHIS_MEDIA_SOURCE_TEXT_MAX_LENGTH);
  if (!fileName) return null;
  if (typeof value.title !== "string") return null;
  const title = value.title.trim();
  if (!title || title.length > PHIS_MEDIA_SOURCE_TEXT_MAX_LENGTH) return null;
  const altText = readOptionalText(value.altText);
  const credit = readOptionalText(value.credit);
  if (altText === undefined || credit === undefined) return null;
  return {
    body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    contentType: value.contentType.trim(),
    fileName,
    title,
    altText,
    credit,
  };
}

/**
 * Takes one item of one source into the Site Space, as the person who chose it.
 *
 * The steps an upload takes, with the bytes in hand instead of a session (design/MEDIA_SOURCES.md,
 * section 5). The same bytes already in the Site Space answer with the Asset that is there and write
 * nothing. A failure after the object was written removes it again.
 */
export async function importMediaSourceItem(input: {
  site: Site;
  /** `<providerKey>#<key>`, as `listMediaSources` names it. */
  source: string;
  itemId: string;
  /** Null: the top level of the Space. */
  folderId: number | null;
  actorUserId: number;
}) {
  const { site } = input;
  if (!isNonEmptyString(input.itemId, PHIS_MEDIA_SOURCE_ITEM_ID_MAX_LENGTH)) {
    throw new MediaSourceError("invalid_request", "That is not an item id.");
  }
  const { target, place } = await resolveSource(site, input.source);

  // What can be refused without fetching anything is refused first: the Folder, and the Profile.
  const { space } = await ensureSiteMediaSpace(site.id);
  if (input.folderId !== null) {
    if (!await getMediaFolderBySiteAndId(site.id, space.id, input.folderId)) {
      throw new MediaSourceError("folder_not_found", "Folder not found in the Site Space.");
    }
    if (await hasLockedMediaFolder(site.id, space.id, [input.folderId])) {
      throw new MediaSourceError("folder_locked", "The Media Folder is locked.");
    }
  }
  const mediaConfig = await ensureSiteMediaConfig(site.id);

  let answer: unknown;
  try {
    answer = await target.adapter.take({
      source: place.key,
      itemId: input.itemId,
      signal: AbortSignal.timeout(TAKE_TIMEOUT_MS),
    });
  } catch (error) {
    logRuntimeEvent("warn", "media.source.take_failed", {
      message: "A media source add-on did not hand over an item.",
      siteKey: site.key,
      error: normalizeLogThrowable(error),
      meta: { source: input.source, itemId: input.itemId },
    });
    throw new MediaSourceError("media_source_failed", `${place.label} did not hand over the file.`);
  }
  const file = readFile(answer);
  if (!file) {
    logRuntimeEvent("warn", "media.source.take_invalid", {
      message: "A media source add-on handed over a file out of contract.",
      siteKey: site.key,
      meta: { source: input.source, itemId: input.itemId },
    });
    throw new MediaSourceError("media_source_failed", `${place.label} handed over something that is not a file.`);
  }
  // The Site's own ceiling, with the refusal an upload would give.
  if (!isPhiMediaObjectSizeAllowed(file.body.byteLength, mediaConfig)) {
    throw new MediaSourceError(
      "media_asset_too_large",
      `This file is larger than the ${mediaConfig.maxObjectBytes} byte limit for this site.`,
    );
  }

  const sha256 = createHash("sha256").update(file.body).digest("hex");
  const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
  if (!profile) throw new MediaSourceError("storage_profile_unavailable", "Storage Profile unavailable.");

  /*
   * The object is written inside the transaction but outlives a failure of it: whatever rejects after
   * `putObject` succeeded -- the callback or the COMMIT -- leaves an object no Asset points at, so the
   * cleanup covers the whole transaction.
   */
  const written: { discard?: () => Promise<void> } = {};
  try {
    return await withMediaSourceImportLock({ spaceId: space.id, checksum: sha256 }, async (db) => {
      // The same lookup the upload's duplicate check makes; here it is the answer, not a refusal.
      const existing = await getMediaAssetBySiteAndChecksum(site.id, space.id, { algorithm: "sha256", value: sha256 });
      if (existing && existing.lifecycleStatus === PhiMediaLifecycleStatus.Ready) return existing;

      const opened = await openSiteMediaWriteStorage(site, profile);
      if ("reason" in opened) {
        throw opened.reason === "storage_profile_disabled"
          ? new MediaSourceError("storage_profile_disabled", "Uploads into this Media Space are paused: its Storage Profile is disabled.")
          : new MediaSourceError("storage_provider_unavailable", "Storage is not available on this server.");
      }
      const inspection = await inspectPhiMediaObject({
        body: file.body,
        declaredContentType: file.contentType,
        space,
        mediaConfig,
      });
      if (!inspection.ok) throw new MediaSourceError(inspection.code, inspection.message);

      const asset = await writeSiteMediaAsset(db, {
        site, space, profile, inspection, storage: opened.storage, body: file.body, written,
        folderId: input.folderId,
        actorUserId: input.actorUserId,
        originalName: file.fileName,
        // A record of where it came from, not a link: nothing reads it to find the file again.
        meta: {
          source: "media-source",
          providerKey: target.providerKey,
          sourceKey: place.key,
          itemId: input.itemId,
          credit: file.credit,
        },
        title: file.title,
        altText: file.altText,
      });
      if (!asset) throw new MediaSourceError("media_quota_exceeded", "Media Space quota exceeded.");
      return asset;
    });
  } catch (error) {
    await written.discard?.();
    throw error;
  }
}
