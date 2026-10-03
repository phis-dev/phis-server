import { createHash } from "node:crypto";

import { isPhisServiceInterfaceCurrent, isPhisServiceKind } from "./core-services.ts";
import { validatePhisAddonQueryCatalog } from "./query-descriptor.ts";
import { validatePhisAddonSchemaDescriptor } from "./schema-descriptor.ts";
import { PHIS_ADDON_ID_PATTERN } from "./schema-name.ts";
import {
  PHIS_ADDON_ABI_VERSION,
  PHIS_ADDON_EVENTS,
  PHIS_ADDON_MANIFEST_VERSION,
  PHIS_SITE_ACCESS,
  type PhisAddonApiRouteDescriptor,
  type PhisAddonDesiredState,
  type PhisAddonHookDescriptor,
  type PhisAddonManifestV1,
  type PhisAddonSchemaDescriptor,
} from "./contract.ts";
import { isPhiRecord } from "../helpers/record.ts";

/**
 * An Add-on id is an npm package name in which neither `_` nor `.` occurs. Both would have to map to `_` in the derived schema name, and three characters collapsing
 * into one would multiply the collisions the unique index has to catch for nothing in return.
 */
const ADDON_ID_PATTERN = PHIS_ADDON_ID_PATTERN;
/** `<npm-package>/modules/<module>`, the Module id grammar `@phis/ui` enforces on the other side. */
const MODULE_ID_PATTERN = (packageName: string) =>
  new RegExp(`^${packageName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}/modules/[a-z0-9][a-z0-9-]*$`);

/** What `phis.site_groups.key` accepts, so a manifest is refused here rather than at the first Site. */
const GROUP_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/;

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
const SETTING_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SITE_ACCESS_VALUES = new Set<string>(Object.values(PHIS_SITE_ACCESS));
/** A header name, lowercase, because that is how `Headers.get` will look for it. */
const HTTP_HEADER_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/**
 * What `buildPhiSecretReference` accepts as a name.
 *
 * Stated here rather than imported: a manifest is validated by the CLI as well as by the server, and a
 * validator that pulled in the secret machinery would pull a backend and a database with it. A name
 * this refuses is one the reference builder would have thrown on at the first delivery instead.
 */
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOOK_VERIFICATION_SCHEMES = new Set(["hmac-sha256"]);
const ADDON_EVENT_IDS = new Set<string>(Object.values(PHIS_ADDON_EVENTS));

/**
 * Whether at least one role can be reached without already holding another.
 *
 * A graph where every role is granted by a role is a set nobody enters. The Site Admin floor means it is
 * not a lock-out at runtime, but it is never what an author meant to write, and it is free to notice.
 */
function hasReachableRoleRoot(roles: { name: string; grantableBy: unknown }[]) {
  return roles.some((role) =>
    isPhiRecord(role.grantableBy) && typeof role.grantableBy.siteAccess === "string"
  );
}
const SETTING_TYPES = new Set(["text", "integer", "boolean"]);
const POSTGRES_SMALLINT_MAX = 32_767;
const COMPATIBLE_SERVER_ABI_PATTERNS = [
  /^1(?:\.0(?:\.0)?)?$/,
  /^\^1(?:\.0(?:\.0)?)?$/,
  /^>=1(?:\.0(?:\.0)?)? <2(?:\.0(?:\.0)?)?$/,
];

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
): value is PhisAddonApiRouteDescriptor {
  const field = `apiRoutes[${index}]`;
  if (!isPhiRecord(value)) {
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
): value is PhisAddonHookDescriptor {
  const field = `hooks[${index}]`;
  if (!isPhiRecord(value)) {
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
  // Stated at all means stated correctly; absent means false, which is what every hook written before
  // the field existed meant.
  if (value.siteScoped !== undefined && typeof value.siteScoped !== "boolean") {
    issues.push(`${field}.siteScoped must be a boolean when it is stated at all.`);
  }
  validateHookVerification(value, field, issues);

  return true;
}

/**
 * How this hook's caller can be believed, where it can be at all.
 *
 * Absent is a complete answer and the one most hooks give: an unverified hook reads and writes nothing,
 * which is the rule rather than a degraded mode. What is refused here is a half-stated one -- a header
 * without a secret, a scheme Core does not implement -- because each of those would be discovered at
 * the first delivery, which is the worst moment to discover it.
 */
function validateHookVerification(
  hook: Record<string, unknown>,
  hookField: string,
  issues: string[],
) {
  const value = hook.verification;
  if (value === undefined) {
    return;
  }
  const field = `${hookField}.verification`;
  if (!isPhiRecord(value)) {
    issues.push(`${field} must be an object when it is stated at all.`);
    return;
  }

  const scheme = readString(value.scheme, `${field}.scheme`, issues);
  if (scheme && !HOOK_VERIFICATION_SCHEMES.has(scheme)) {
    issues.push(`${field}.scheme is unsupported.`);
  }

  const header = readString(value.header, `${field}.header`, issues);
  if (header && !HTTP_HEADER_PATTERN.test(header)) {
    issues.push(`${field}.header must be a lowercase header name.`);
  }

  const secret = readString(value.secret, `${field}.secret`, issues);
  if (secret && !SECRET_NAME_PATTERN.test(secret)) {
    issues.push(`${field}.secret is not a secret name an operator could set.`);
  }

  if (value.prefix !== undefined && (typeof value.prefix !== "string" || value.prefix === "")) {
    issues.push(`${field}.prefix must be a non-empty string when it is stated at all.`);
  }

  if (value.deliveryIdHeader !== undefined) {
    const deliveryHeader = readString(
      value.deliveryIdHeader,
      `${field}.deliveryIdHeader`,
      issues,
    );
    if (deliveryHeader && !HTTP_HEADER_PATTERN.test(deliveryHeader)) {
      issues.push(`${field}.deliveryIdHeader must be a lowercase header name.`);
    }
  }

  /*
   * The secret is the operator's, set per Site. A hook that is not told which Site it was called for
   * has no secret to check against, so the two fields are stated together or the hook is refused --
   * the alternative is a hook that looks verified in the manifest and can never verify anything.
   */
  if (hook.siteScoped !== true) {
    issues.push(`${hookField}.siteScoped must be true for a verified hook.`);
  }
}

export function stablePhiJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stablePhiJson).join(",")}]`;
  }
  if (isPhiRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stablePhiJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validatePhisAddonManifest(
  value: unknown,
): { manifest: PhisAddonManifestV1 | null; issues: string[] } {
  const issues: string[] = [];
  if (!isPhiRecord(value)) {
    return {
      manifest: null,
      issues: ["Add-on manifest must be an object."],
    };
  }

  if (value.manifestVersion !== PHIS_ADDON_MANIFEST_VERSION) {
    issues.push(
      `manifestVersion must be ${PHIS_ADDON_MANIFEST_VERSION}.`,
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
  if (!isPhisAddonAbiCompatible(serverAbi)) {
    issues.push(
      `serverAbi must be a range compatible only with ABI ${PHIS_ADDON_ABI_VERSION}.`,
    );
  }

  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  if (!Array.isArray(value.capabilities)) {
    issues.push("capabilities must be an array.");
  }
  const capabilityIds: string[] = [];
  for (const [index, capability] of capabilities.entries()) {
    if (!isPhiRecord(capability)) {
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
    if (!isPhiRecord(provider)) {
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
    if (serviceKind && !isPhisServiceKind(serviceKind)) {
      issues.push(`serviceProviders[${index}].serviceKind "${serviceKind}" is not a Core service kind.`);
    } else if (serviceKind && digest && !isPhisServiceInterfaceCurrent(serviceKind, digest)) {
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
      .filter(isPhiRecord)
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
    if (!isPhiRecord(job)) {
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

  /*
   * The events this Add-on wants told about. Absent means none, like every field added after this
   * manifest version was in the wild.
   *
   * Declaring one is not receiving it: an event reaches an Add-on only for a thread somebody linked it
   * to. What is checked here is that the name is one Core emits -- a handler waiting on a typo would
   * wait forever, and there is nothing at runtime that could report it.
   */
  const eventHandlers = Array.isArray(value.eventHandlers) ? value.eventHandlers : [];
  if (value.eventHandlers !== undefined && !Array.isArray(value.eventHandlers)) {
    issues.push("eventHandlers must be an array when it is stated at all.");
  }
  const eventHandlerIds: string[] = [];
  const eventNames: string[] = [];
  for (const [index, entry] of eventHandlers.entries()) {
    if (!isPhiRecord(entry)) {
      issues.push(`eventHandlers[${index}] must be an object.`);
      continue;
    }
    const id = readString(entry.id, `eventHandlers[${index}].id`, issues);
    const event = readString(entry.event, `eventHandlers[${index}].event`, issues);
    const handler = readString(entry.handler, `eventHandlers[${index}].handler`, issues);
    if (id && !DESCRIPTOR_ID_PATTERN.test(id)) {
      issues.push(`eventHandlers[${index}].id is invalid.`);
    }
    if (event && !ADDON_EVENT_IDS.has(event)) {
      issues.push(`eventHandlers[${index}].event is not an event Core emits.`);
    }
    if (handler && !HANDLER_ID_PATTERN.test(handler)) {
      issues.push(`eventHandlers[${index}].handler is invalid.`);
    }
    eventHandlerIds.push(id);
    eventNames.push(event);
  }
  assertUnique(eventHandlerIds, "eventHandlers", issues);
  // One handler per event. Two would need an order Core does not define, and an Add-on that wants two
  // things to happen can do both in one function where the order is visible.
  assertUnique(eventNames, "eventHandlers events", issues);

  let schema: PhisAddonSchemaDescriptor | null = null;
  if (value.schema === null) {
    schema = null;
  } else if (value.schema === undefined) {
    issues.push("schema must be a descriptor object or null.");
  } else {
    schema = validatePhisAddonSchemaDescriptor(value.schema, "schema", issues);
  }

  /*
   * Absent is a valid answer for a field that arrived after this manifest version was in the wild: the
   * Add-on that stored this manifest had not forgotten it, it did not exist. Only a wrong shape is an
   * issue, never a missing one.
   */
  const settings = Array.isArray(value.settings) ? value.settings : [];
  if (value.settings !== undefined && !Array.isArray(value.settings)) {
    issues.push("settings must be an array when it is stated at all.");
  }
  const settingNames: string[] = [];
  for (const [index, setting] of settings.entries()) {
    if (!isPhiRecord(setting)) {
      issues.push(`settings[${index}] must be an object.`);
      continue;
    }
    const name = readString(setting.name, `settings[${index}].name`, issues);
    if (name && !SETTING_NAME_PATTERN.test(name)) {
      issues.push(`settings[${index}].name is invalid.`);
    }
    settingNames.push(name);
    if (!SETTING_TYPES.has(String(setting.type))) {
      issues.push(`settings[${index}].type must be text, integer, or boolean.`);
    }
    // A default that does not match its own type would be handed to the Add-on as if an operator had
    // set it, which is a worse failure than refusing the manifest.
    const expected = setting.type === "integer"
      ? "number"
      : setting.type === "boolean"
        ? "boolean"
        : "string";
    if (setting.default !== undefined && typeof setting.default !== expected) {
      issues.push(`settings[${index}].default is not a ${String(setting.type)}.`);
    }
  }
  assertUnique(settingNames, "settings", issues);

  const roles = Array.isArray(value.roles) ? value.roles : [];
  if (value.roles !== undefined && !Array.isArray(value.roles)) {
    issues.push("roles must be an array when it is stated at all.");
  }
  const roleNames: string[] = [];
  for (const [index, role] of roles.entries()) {
    if (!isPhiRecord(role)) {
      issues.push(`roles[${index}] must be an object.`);
      continue;
    }
    const name = readString(role.name, `roles[${index}].name`, issues);
    if (name && !SETTING_NAME_PATTERN.test(name)) {
      issues.push(`roles[${index}].name is invalid.`);
    }
    roleNames.push(name);
    if (role.description !== undefined && typeof role.description !== "string") {
      issues.push(`roles[${index}].description must be a string when it is stated at all.`);
    }
    const grantableBy = role.grantableBy;
    if (!isPhiRecord(grantableBy)) {
      issues.push(`roles[${index}].grantableBy must be an object.`);
      continue;
    }
    // One source or the other, never both: two answers to "who may grant this" would need a rule about
    // which one wins, and that rule would live nowhere the author can see it.
    const bySiteAccess = grantableBy.siteAccess !== undefined;
    const byRole = grantableBy.role !== undefined;
    if (bySiteAccess === byRole) {
      issues.push(`roles[${index}].grantableBy states either siteAccess or role, and not both.`);
    } else if (bySiteAccess && !SITE_ACCESS_VALUES.has(String(grantableBy.siteAccess))) {
      issues.push(`roles[${index}].grantableBy.siteAccess is not a Site access.`);
    } else if (byRole && typeof grantableBy.role !== "string") {
      issues.push(`roles[${index}].grantableBy.role must be a string.`);
    }
  }
  assertUnique(roleNames, "roles", issues);
  for (const [index, role] of roles.entries()) {
    // A role granted by another role has to name one this same Add-on declares. Pointing at a stranger
    // would be a policy nobody here can evaluate.
    const grantedBy = isPhiRecord(role) && isPhiRecord(role.grantableBy) ? role.grantableBy.role : undefined;
    if (typeof grantedBy === "string" && !roleNames.includes(grantedBy)) {
      issues.push(`roles[${index}].grantableBy.role does not name a role this Add-on declares.`);
    }
  }
  if (roleNames.length > 0 && !hasReachableRoleRoot(roles as { name: string; grantableBy: unknown }[])) {
    // Every role granted by another role, in a cycle, is a set nobody can ever enter. A Site Admin can
    // still grant anything, so this is not fatal at runtime -- but it is never what the author meant.
    issues.push("roles form a cycle: at least one role must be grantable by a Site access.");
  }

  if (value.groupWriter !== undefined) {
    /*
     * The right to make a group is stated the way the right to grant a role is, and checked the same
     * way -- one source, never both, and a role it names has to be one this Add-on declares. A policy
     * pointing at a stranger's role is one nobody here can evaluate, and would fail closed at the worst
     * moment: when somebody is trying to enter a group nobody can enter.
     */
    const writer = value.groupWriter;
    if (!isPhiRecord(writer) || !isPhiRecord(writer.allowedBy)) {
      issues.push("groupWriter states an allowedBy object when it is stated at all.");
    } else {
      const bySiteAccess = writer.allowedBy.siteAccess !== undefined;
      const byRole = writer.allowedBy.role !== undefined;
      if (bySiteAccess === byRole) {
        issues.push("groupWriter.allowedBy states either siteAccess or role, and not both.");
      } else if (bySiteAccess && !SITE_ACCESS_VALUES.has(String(writer.allowedBy.siteAccess))) {
        issues.push("groupWriter.allowedBy.siteAccess is not a Site access.");
      } else if (byRole && typeof writer.allowedBy.role !== "string") {
        issues.push("groupWriter.allowedBy.role must be a string.");
      } else if (byRole && !roleNames.includes(String(writer.allowedBy.role))) {
        issues.push("groupWriter.allowedBy.role does not name a role this Add-on declares.");
      }
    }
  }

  const modules = Array.isArray(value.modules) ? value.modules : [];
  if (value.modules !== undefined && !Array.isArray(value.modules)) {
    issues.push("modules must be an array when it is stated at all.");
  }
  for (const [index, moduleId] of modules.entries()) {
    if (typeof moduleId !== "string") {
      issues.push(`modules[${index}] must be a string.`);
      continue;
    }
    /*
     * The grammar `@phis/ui` states and enforces: `<npm-package>/modules/<module>`.
     *
     * Both halves of it matter. The package prefix, because one package carries one product and a
     * manifest has no standing to declare somebody else's half. And the `modules/` segment, because
     * that is what a Module id *is* -- `@acme/thing/widgets/x` is a leaf inside a module, not a module,
     * and accepting one here would put a name into the desired state that the Site build cannot
     * resolve.
     */
    if (packageName && !MODULE_ID_PATTERN(packageName).test(moduleId)) {
      issues.push(`modules[${index}] must be "${packageName}/modules/<module>".`);
    }
  }
  assertUnique(modules.filter((id): id is string => typeof id === "string"), "modules", issues);

  const groups = Array.isArray(value.groups) ? value.groups : [];
  if (value.groups !== undefined && !Array.isArray(value.groups)) {
    issues.push("groups must be an array when it is stated at all.");
  }
  const groupKeys: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (!isPhiRecord(group)) {
      issues.push(`groups[${index}] must be an object.`);
      continue;
    }
    // The same shape `phis.site_groups` enforces. Checked here as well as there, because a manifest
    // that cannot produce its groups should be refused at install and not on the first Site that
    // enables it.
    const key = typeof group.key === "string" ? group.key : "";
    if (!GROUP_KEY_PATTERN.test(key)) {
      issues.push(`groups[${index}].key is invalid.`);
    }
    groupKeys.push(key);
    if (typeof group.name !== "string" || group.name.trim() === "") {
      issues.push(`groups[${index}].name must be a non-empty string.`);
    } else if (group.name.length > 255) {
      issues.push(`groups[${index}].name is longer than a Site group name may be.`);
    }
    if (group.description !== undefined && typeof group.description !== "string") {
      issues.push(`groups[${index}].description must be a string when it is stated at all.`);
    }
  }
  assertUnique(groupKeys, "groups", issues);

  // A slot's role is checked here rather than in the schema, which does not know the roles.
  const declaredRoleNames = new Set(roleNames.filter((name) => name !== ""));
  for (const [tableIndex, table] of (schema?.tables ?? []).entries()) {
    for (const [slotIndex, slot] of (table.assets ?? []).entries()) {
      if (slot.requiresRole !== undefined && !declaredRoleNames.has(slot.requiresRole)) {
        issues.push(
          `schema.tables[${tableIndex}].assets[${slotIndex}].requiresRole does not name a role this ` +
          "Add-on declares.",
        );
      }
    }
  }

  // As with `settings`: absent means none, and is what every manifest written before queries existed
  // says. Stating it is only required to be right, not to be present.
  if (value.queries != null) {
    validatePhisAddonQueryCatalog(
      value.queries,
      schema,
      "queries",
      issues,
      new Set(roleNames.filter((name) => name !== "")),
    );
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
      .filter(isPhiRecord)
      .map((route) => `api:${String(route.method)}:${String(route.path)}`),
    ...hooks
      .filter(isPhiRecord)
      .map((route) => `hook:${String(route.method)}:${String(route.path)}`),
  ];
  assertUnique(routeKeys, "route descriptors", issues);

  return {
    manifest: issues.length === 0 ? (value as PhisAddonManifestV1) : null,
    issues,
  };
}

export function isPhisAddonAbiCompatible(serverAbi: string) {
  return COMPATIBLE_SERVER_ABI_PATTERNS.some((pattern) => pattern.test(serverAbi.trim()));
}

export function assertPhisAddonManifest(value: unknown) {
  const result = validatePhisAddonManifest(value);
  if (!result.manifest) {
    throw new Error(`Invalid Phi server Add-on manifest:\n- ${result.issues.join("\n- ")}`);
  }
  return result.manifest;
}

export function digestPhisAddonManifest(manifest: PhisAddonManifestV1) {
  return createHash("sha256").update(stablePhiJson(manifest)).digest("hex");
}

export function validatePhisAddonDesiredState(
  value: unknown,
): { state: PhisAddonDesiredState | null; issues: string[] } {
  const issues: string[] = [];
  if (!isPhiRecord(value)) {
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
    if (!isPhiRecord(addon)) {
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
    const embedded = validatePhisAddonManifest(addon.manifest);
    if (!embedded.manifest) {
      for (const issue of embedded.issues) {
        issues.push(`addons[${index}].manifest: ${issue}`);
      }
    } else {
      if (manifestDigest && digestPhisAddonManifest(embedded.manifest) !== manifestDigest) {
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
    state: issues.length === 0 ? (value as PhisAddonDesiredState) : null,
    issues,
  };
}
