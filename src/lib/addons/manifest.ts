import { createHash } from "node:crypto";

import { isPhiServerServiceInterfaceCurrent, isPhiServerServiceKind } from "./core-services.ts";
import { validatePhiServerAddonQueryCatalog } from "./query-descriptor.ts";
import { validatePhiServerAddonSchemaDescriptor } from "./schema-descriptor.ts";
import { PHI_SERVER_ADDON_ID_PATTERN } from "./schema-name.ts";
import {
  PHI_SERVER_ADDON_ABI_VERSION,
  PHI_SERVER_ADDON_MANIFEST_VERSION,
  type PhiServerAddonApiRouteDescriptor,
  type PhiServerAddonDesiredState,
  type PhiServerAddonHookDescriptor,
  type PhiServerAddonManifestV1,
  type PhiServerAddonQueryCatalog,
  type PhiServerAddonSchemaDescriptor,
} from "./contract.ts";

/**
 * An Add-on id is an npm package name without the `-server` postfix, in which neither `_` nor `.`
 * occurs. Both would have to map to `_` in the derived schema name, and three characters collapsing
 * into one would multiply the collisions the unique index has to catch for nothing in return.
 */
const ADDON_ID_PATTERN = PHI_SERVER_ADDON_ID_PATTERN;
const CAPABILITY_ID_PATTERN =
  /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*:v[1-9]\d*$/;
const DESCRIPTOR_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
/** A provider key is what a profile row stores, so it follows the column's own module-id shape. */
const SERVICE_PROVIDER_KEY_PATTERN =
  /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const HANDLER_ID_PATTERN = /^[a-z][a-zA-Z0-9._-]*$/;
const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ROUTE_SEGMENT_PATTERN = /^(?:[a-z0-9][a-z0-9._-]*|:[a-z][a-zA-Z0-9_]*)$/;
const HTTP_METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);
const AUTH_POLICIES = new Set(["internal", "site-user", "site-admin", "operator"]);
const POSTGRES_SMALLINT_MAX = 32_767;
const COMPATIBLE_SERVER_ABI_PATTERNS = [
  /^1(?:\.0(?:\.0)?)?$/,
  /^\^1(?:\.0(?:\.0)?)?$/,
  /^>=1(?:\.0(?:\.0)?)? <2(?:\.0(?:\.0)?)?$/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, field: string, issues: string[]) {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${field} must be a non-empty string.`);
    return "";
  }
  if (value !== value.trim()) {
    issues.push(`${field} must not contain surrounding whitespace.`);
  }

  return value.trim();
}

function assertUnique(values: string[], field: string, issues: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push(`${field} contains duplicate "${value}".`);
    }
    seen.add(value);
  }
}

function validateRoutePath(path: string, field: string, issues: string[]) {
  if (!path) {
    return;
  }
  if (path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
    issues.push(`${field} must be a canonical relative path without leading or trailing slash.`);
    return;
  }
  for (const segment of path.split("/")) {
    if (!ROUTE_SEGMENT_PATTERN.test(segment)) {
      issues.push(`${field} contains invalid segment "${segment}".`);
    }
  }
}

function validatePositiveInteger(
  value: unknown,
  field: string,
  issues: string[],
  required: boolean,
) {
  if (value === undefined && !required) {
    return;
  }
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    issues.push(`${field} must be a positive integer.`);
  }
}

function validateApiRoute(
  value: unknown,
  index: number,
  issues: string[],
): value is PhiServerAddonApiRouteDescriptor {
  const field = `apiRoutes[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return false;
  }

  const id = readString(value.id, `${field}.id`, issues);
  const method = readString(value.method, `${field}.method`, issues);
  const path = typeof value.path === "string" ? value.path.trim() : "";
  if (typeof value.path !== "string") {
    issues.push(`${field}.path must be a string.`);
  } else if (value.path !== path) {
    issues.push(`${field}.path must not contain surrounding whitespace.`);
  }
  const handler = readString(value.handler, `${field}.handler`, issues);
  const auth = readString(value.auth, `${field}.auth`, issues);

  if (id && !DESCRIPTOR_ID_PATTERN.test(id)) {
    issues.push(`${field}.id is invalid.`);
  }
  if (method && !HTTP_METHODS.has(method)) {
    issues.push(`${field}.method is unsupported.`);
  }
  validateRoutePath(path, `${field}.path`, issues);
  if (handler && !HANDLER_ID_PATTERN.test(handler)) {
    issues.push(`${field}.handler is invalid.`);
  }
  if (auth && !AUTH_POLICIES.has(auth)) {
    issues.push(`${field}.auth is unsupported.`);
  }
  if (typeof value.siteScoped !== "boolean") {
    issues.push(`${field}.siteScoped must be boolean.`);
  }
  if ((auth === "site-user" || auth === "site-admin") && value.siteScoped !== true) {
    issues.push(`${field}.siteScoped must be true for ${auth}.`);
  }
  validatePositiveInteger(value.bodyLimitBytes, `${field}.bodyLimitBytes`, issues, false);
  validatePositiveInteger(value.timeoutMs, `${field}.timeoutMs`, issues, false);
  if (
    value.rateLimitClass !== undefined &&
    (typeof value.rateLimitClass !== "string" || !DESCRIPTOR_ID_PATTERN.test(value.rateLimitClass))
  ) {
    issues.push(`${field}.rateLimitClass is invalid.`);
  }

  return true;
}

function validateHook(
  value: unknown,
  index: number,
  issues: string[],
): value is PhiServerAddonHookDescriptor {
  const field = `hooks[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return false;
  }

  const id = readString(value.id, `${field}.id`, issues);
  const method = readString(value.method, `${field}.method`, issues);
  const path = typeof value.path === "string" ? value.path.trim() : "";
  if (typeof value.path !== "string") {
    issues.push(`${field}.path must be a string.`);
  } else if (value.path !== path) {
    issues.push(`${field}.path must not contain surrounding whitespace.`);
  }
  const handler = readString(value.handler, `${field}.handler`, issues);
  const rateLimitClass = readString(value.rateLimitClass, `${field}.rateLimitClass`, issues);

  if (id && !DESCRIPTOR_ID_PATTERN.test(id)) {
    issues.push(`${field}.id is invalid.`);
  }
  if (method && !HTTP_METHODS.has(method)) {
    issues.push(`${field}.method is unsupported.`);
  }
  validateRoutePath(path, `${field}.path`, issues);
  if (handler && !HANDLER_ID_PATTERN.test(handler)) {
    issues.push(`${field}.handler is invalid.`);
  }
  if (rateLimitClass && !DESCRIPTOR_ID_PATTERN.test(rateLimitClass)) {
    issues.push(`${field}.rateLimitClass is invalid.`);
  }
  validatePositiveInteger(value.bodyLimitBytes, `${field}.bodyLimitBytes`, issues, true);
  validatePositiveInteger(value.timeoutMs, `${field}.timeoutMs`, issues, true);

  return true;
}

export function stablePhiJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stablePhiJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stablePhiJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validatePhiServerAddonManifest(
  value: unknown,
): { manifest: PhiServerAddonManifestV1 | null; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return {
      manifest: null,
      issues: ["Add-on manifest must be an object."],
    };
  }

  if (value.manifestVersion !== PHI_SERVER_ADDON_MANIFEST_VERSION) {
    issues.push(
      `manifestVersion must be ${PHI_SERVER_ADDON_MANIFEST_VERSION}.`,
    );
  }

  const addonId = readString(value.addonId, "addonId", issues);
  const packageName = readString(value.packageName, "packageName", issues);
  const packageVersion = readString(value.packageVersion, "packageVersion", issues);
  const serverAbi = readString(value.serverAbi, "serverAbi", issues);

  if (addonId && !ADDON_ID_PATTERN.test(addonId)) {
    issues.push("addonId must be a scoped logical id such as @phis/github.");
  }
  if (packageName && !ADDON_ID_PATTERN.test(packageName)) {
    issues.push("packageName must be a scoped package name.");
  }
  if (packageVersion && !PACKAGE_VERSION_PATTERN.test(packageVersion)) {
    issues.push("packageVersion must be an exact semantic version.");
  }
  if (!isPhiServerAddonAbiCompatible(serverAbi)) {
    issues.push(
      `serverAbi must be a range compatible only with ABI ${PHI_SERVER_ADDON_ABI_VERSION}.`,
    );
  }

  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  if (!Array.isArray(value.capabilities)) {
    issues.push("capabilities must be an array.");
  }
  const capabilityIds: string[] = [];
  for (const [index, capability] of capabilities.entries()) {
    if (!isRecord(capability)) {
      issues.push(`capabilities[${index}] must be an object.`);
      continue;
    }
    const id = readString(capability.id, `capabilities[${index}].id`, issues);
    const digest = readString(
      capability.interfaceDigest,
      `capabilities[${index}].interfaceDigest`,
      issues,
    );
    if (id && !CAPABILITY_ID_PATTERN.test(id)) {
      issues.push(`capabilities[${index}].id is invalid.`);
    }
    if (digest && !DIGEST_PATTERN.test(digest)) {
      issues.push(`capabilities[${index}].interfaceDigest must be a SHA-256 digest.`);
    }
    capabilityIds.push(id);
  }
  assertUnique(capabilityIds, "capabilities", issues);

  const serviceProviders = Array.isArray(value.serviceProviders) ? value.serviceProviders : [];
  if (!Array.isArray(value.serviceProviders)) {
    issues.push("serviceProviders must be an array.");
  }
  const serviceProviderKeys: string[] = [];
  for (const [index, provider] of serviceProviders.entries()) {
    if (!isRecord(provider)) {
      issues.push(`serviceProviders[${index}] must be an object.`);
      continue;
    }
    const serviceKind = readString(provider.serviceKind, `serviceProviders[${index}].serviceKind`, issues);
    const providerKey = readString(provider.providerKey, `serviceProviders[${index}].providerKey`, issues);
    const digest = readString(
      provider.interfaceDigest,
      `serviceProviders[${index}].interfaceDigest`,
      issues,
    );
    const factoryExport = readString(
      provider.factoryExport,
      `serviceProviders[${index}].factoryExport`,
      issues,
    );
    if (serviceKind && !isPhiServerServiceKind(serviceKind)) {
      issues.push(`serviceProviders[${index}].serviceKind "${serviceKind}" is not a Core service kind.`);
    } else if (serviceKind && digest && !isPhiServerServiceInterfaceCurrent(serviceKind, digest)) {
      // The digest exists so an Add-on built against an older interface is refused here rather than
      // called with arguments it does not expect.
      issues.push(
        `serviceProviders[${index}].interfaceDigest does not match the ${serviceKind} interface this release offers.`,
      );
    }
    if (providerKey && !SERVICE_PROVIDER_KEY_PATTERN.test(providerKey)) {
      issues.push(`serviceProviders[${index}].providerKey is invalid.`);
    } else if (providerKey && addonId && !providerKey.startsWith(`${addonId}/`)) {
      // Section 10 calls it a package-qualified key. Without that check an Add-on could claim a key
      // that reads as another's, and a Storage Profile row naming it would point at the wrong package.
      issues.push(
        `serviceProviders[${index}].providerKey must start with "${addonId}/".`,
      );
    }
    if (factoryExport && !HANDLER_ID_PATTERN.test(factoryExport)) {
      issues.push(`serviceProviders[${index}].factoryExport is invalid.`);
    }
    const providerRequired = Array.isArray(provider.requiredCoreCapabilities)
      ? provider.requiredCoreCapabilities
      : [];
    if (!Array.isArray(provider.requiredCoreCapabilities)) {
      issues.push(`serviceProviders[${index}].requiredCoreCapabilities must be an array.`);
    }
    for (const [requiredIndex, required] of providerRequired.entries()) {
      const requiredId = readString(
        required,
        `serviceProviders[${index}].requiredCoreCapabilities[${requiredIndex}]`,
        issues,
      );
      if (requiredId && !CAPABILITY_ID_PATTERN.test(requiredId)) {
        issues.push(
          `serviceProviders[${index}].requiredCoreCapabilities[${requiredIndex}] is invalid.`,
        );
      }
    }
    serviceProviderKeys.push(`${serviceKind}:${providerKey}`);
  }
  // Section 10 requires (service kind, provider key) to be unique, because a Storage Profile row names
  // exactly that pair and two implementations answering to it would make the row ambiguous.
  assertUnique(serviceProviderKeys, "serviceProviders", issues);

  const requiredCoreCapabilities = Array.isArray(value.requiredCoreCapabilities)
    ? value.requiredCoreCapabilities
    : [];
  if (!Array.isArray(value.requiredCoreCapabilities)) {
    issues.push("requiredCoreCapabilities must be an array.");
  }
  const requiredIds: string[] = [];
  for (const [index, required] of requiredCoreCapabilities.entries()) {
    const id = readString(required, `requiredCoreCapabilities[${index}]`, issues);
    if (id && !CAPABILITY_ID_PATTERN.test(id)) {
      issues.push(`requiredCoreCapabilities[${index}] is invalid.`);
    }
    requiredIds.push(id);
  }
  assertUnique(requiredIds, "requiredCoreCapabilities", issues);

  const apiRoutes = Array.isArray(value.apiRoutes) ? value.apiRoutes : [];
  if (!Array.isArray(value.apiRoutes)) {
    issues.push("apiRoutes must be an array.");
  }
  apiRoutes.forEach((route, index) => validateApiRoute(route, index, issues));

  const hooks = Array.isArray(value.hooks) ? value.hooks : [];
  if (!Array.isArray(value.hooks)) {
    issues.push("hooks must be an array.");
  }
  hooks.forEach((hook, index) => validateHook(hook, index, issues));
  assertUnique(
    [...apiRoutes, ...hooks]
      .filter(isRecord)
      .map((route) => String(route.id ?? "")),
    "route descriptor ids",
    issues,
  );

  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  if (!Array.isArray(value.jobs)) {
    issues.push("jobs must be an array.");
  }
  const jobIds: string[] = [];
  for (const [index, job] of jobs.entries()) {
    if (!isRecord(job)) {
      issues.push(`jobs[${index}] must be an object.`);
      continue;
    }
    const id = readString(job.id, `jobs[${index}].id`, issues);
    const handler = readString(job.handler, `jobs[${index}].handler`, issues);
    if (id && !DESCRIPTOR_ID_PATTERN.test(id)) {
      issues.push(`jobs[${index}].id is invalid.`);
    }
    if (handler && !HANDLER_ID_PATTERN.test(handler)) {
      issues.push(`jobs[${index}].handler is invalid.`);
    }
    jobIds.push(id);
  }
  assertUnique(jobIds, "jobs", issues);

  let schema: PhiServerAddonSchemaDescriptor | null = null;
  if (value.schema === null) {
    schema = null;
  } else if (value.schema === undefined) {
    issues.push("schema must be a descriptor object or null.");
  } else {
    schema = validatePhiServerAddonSchemaDescriptor(value.schema, "schema", issues);
  }

  let queries: PhiServerAddonQueryCatalog | null = null;
  if (value.queries === null) {
    queries = null;
  } else if (value.queries === undefined) {
    issues.push("queries must be a catalog object or null.");
  } else {
    queries = validatePhiServerAddonQueryCatalog(value.queries, schema, "queries", issues);
  }

  const migrationVersion = value.migrationVersion;
  if (!Number.isSafeInteger(migrationVersion) || Number(migrationVersion) < 0) {
    issues.push("migrationVersion must be a non-negative integer.");
  } else if (Number(migrationVersion) > POSTGRES_SMALLINT_MAX) {
    issues.push("migrationVersion must fit PostgreSQL SMALLINT.");
  } else if (value.schema !== undefined) {
    const declared = schema ? schema.version : 0;
    if (Number(migrationVersion) !== declared) {
      issues.push(
        `migrationVersion must equal the schema descriptor version (${declared}).`,
      );
    }
  }

  const routeKeys = [
    ...apiRoutes
      .filter(isRecord)
      .map((route) => `api:${String(route.method)}:${String(route.path)}`),
    ...hooks
      .filter(isRecord)
      .map((route) => `hook:${String(route.method)}:${String(route.path)}`),
  ];
  assertUnique(routeKeys, "route descriptors", issues);

  return {
    manifest: issues.length === 0 && queries !== undefined
      ? (value as PhiServerAddonManifestV1)
      : null,
    issues,
  };
}

export function isPhiServerAddonAbiCompatible(serverAbi: string) {
  return COMPATIBLE_SERVER_ABI_PATTERNS.some((pattern) => pattern.test(serverAbi.trim()));
}

export function assertPhiServerAddonManifest(value: unknown) {
  const result = validatePhiServerAddonManifest(value);
  if (!result.manifest) {
    throw new Error(`Invalid Phi server Add-on manifest:\n- ${result.issues.join("\n- ")}`);
  }
  return result.manifest;
}

export function digestPhiServerAddonManifest(manifest: PhiServerAddonManifestV1) {
  return createHash("sha256").update(stablePhiJson(manifest)).digest("hex");
}

export function validatePhiServerAddonDesiredState(
  value: unknown,
): { state: PhiServerAddonDesiredState | null; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { state: null, issues: ["Desired state must be an object."] };
  }
  if (value.formatVersion !== 1) {
    issues.push("formatVersion must be 1.");
  }
  if (!Array.isArray(value.addons)) {
    issues.push("addons must be an array.");
    return { state: null, issues };
  }

  const addonIds: string[] = [];
  const packageNames: string[] = [];
  for (const [index, addon] of value.addons.entries()) {
    if (!isRecord(addon)) {
      issues.push(`addons[${index}] must be an object.`);
      continue;
    }
    const addonId = readString(addon.addonId, `addons[${index}].addonId`, issues);
    const packageName = readString(
      addon.packageName,
      `addons[${index}].packageName`,
      issues,
    );
    const packageVersion = readString(
      addon.packageVersion,
      `addons[${index}].packageVersion`,
      issues,
    );
    const manifestDigest = readString(
      addon.manifestDigest,
      `addons[${index}].manifestDigest`,
      issues,
    );
    if (addonId && !ADDON_ID_PATTERN.test(addonId)) {
      issues.push(`addons[${index}].addonId is invalid.`);
    }
    if (packageName && !ADDON_ID_PATTERN.test(packageName)) {
      issues.push(`addons[${index}].packageName is invalid.`);
    }
    if (packageVersion && !PACKAGE_VERSION_PATTERN.test(packageVersion)) {
      issues.push(`addons[${index}].packageVersion is invalid.`);
    }
    if (manifestDigest && !DIGEST_PATTERN.test(manifestDigest)) {
      issues.push(`addons[${index}].manifestDigest must be a SHA-256 digest.`);
    }
    const artifactDigest = readString(
      addon.artifactDigest,
      `addons[${index}].artifactDigest`,
      issues,
    );
    if (artifactDigest && !DIGEST_PATTERN.test(artifactDigest)) {
      issues.push(`addons[${index}].artifactDigest must be a SHA-256 digest.`);
    }
    if (typeof addon.enabled !== "boolean") {
      issues.push(`addons[${index}].enabled must be boolean.`);
    }

    // The descriptors are cached here so the server does not have to evaluate an artifact to learn
    // what it declares. Validating them and binding them to the digest is what makes that safe: a
    // hand-edited entry cannot widen an Add-on's routes, capabilities, or schema without also
    // matching a digest it cannot compute for code it does not have.
    const embedded = validatePhiServerAddonManifest(addon.manifest);
    if (!embedded.manifest) {
      for (const issue of embedded.issues) {
        issues.push(`addons[${index}].manifest: ${issue}`);
      }
    } else {
      if (manifestDigest && digestPhiServerAddonManifest(embedded.manifest) !== manifestDigest) {
        issues.push(`addons[${index}].manifest does not match manifestDigest.`);
      }
      if (addonId && embedded.manifest.addonId !== addonId) {
        issues.push(`addons[${index}].manifest.addonId does not match the entry.`);
      }
      if (packageName && embedded.manifest.packageName !== packageName) {
        issues.push(`addons[${index}].manifest.packageName does not match the entry.`);
      }
      if (packageVersion && embedded.manifest.packageVersion !== packageVersion) {
        issues.push(`addons[${index}].manifest.packageVersion does not match the entry.`);
      }
    }

    addonIds.push(addonId);
    packageNames.push(packageName);
  }
  assertUnique(addonIds, "addons.addonId", issues);
  assertUnique(packageNames, "addons.packageName", issues);

  return {
    state: issues.length === 0 ? (value as PhiServerAddonDesiredState) : null,
    issues,
  };
}
