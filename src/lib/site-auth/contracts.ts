export const PHI_AUTH_STAGES = [
  "primary",
  "second-factor",
  "step-up",
  "recovery",
] as const;

export type PhiAuthStage = (typeof PHI_AUTH_STAGES)[number];

export const PHI_AUTH_REGISTRATION_MODES = [
  "disabled",
  "invite-only",
  "automatic",
] as const;

export type PhiAuthRegistrationMode = (typeof PHI_AUTH_REGISTRATION_MODES)[number];

export const PHI_AUTH_LINKING_MODES = [
  "disabled",
  "verified-email-confirm",
  "verified-email-auto",
] as const;

export type PhiAuthLinkingMode = (typeof PHI_AUTH_LINKING_MODES)[number];

export const PHI_AUTH_FACTOR_ENFORCEMENT_MODES = [
  "next-login",
  "immediate",
  "grace",
] as const;

export type PhiAuthFactorEnforcementMode =
  (typeof PHI_AUTH_FACTOR_ENFORCEMENT_MODES)[number];

export type PhiAuthFactorPolicy = {
  requiredMethod: "totp" | null;
  enforcement: PhiAuthFactorEnforcementMode;
  graceUntil: string | null;
  roleFlags: number;
};

export const PHI_AUTH_SESSION_STATES = {
  factorEnrollmentRequired: 1,
  factorChallengeRequired: 2,
  complete: 3,
} as const;

export type PhiAuthSessionState =
  (typeof PHI_AUTH_SESSION_STATES)[keyof typeof PHI_AUTH_SESSION_STATES];

/**
 * The methods Core knows, and how each one presents itself when the Site says nothing.
 *
 * `icon` is the provider's own mark, because that is what a person scans a row of sign-in buttons for:
 * the word "Google" and the word "GitHub" are the same shape from a metre away, the marks are not. It
 * sits beside the label for the same reason the label is here -- a Site may override either through
 * `PhiAuthMethodPresentation`, and what it does not override has to come from somewhere.
 *
 * The names are the `antd:` set, which the icon registry bundles. Not `iconify:`, although that prefix
 * is supported: these are Core defaults on a public Login page, so every Site ships them without anyone
 * choosing them, and an Iconify icon is fetched from Iconify's API by the visitor's browser. A Builder
 * picking one opts into that; a default may not opt in on their behalf. A method with no mark of its own
 * (a password, a code) states none and its button stays text.
 */
export const PHI_CORE_AUTH_METHODS = {
  password: { stages: ["primary", "step-up"], label: "Email and password" },
  passkey: { stages: ["primary", "second-factor", "step-up"], label: "Passkey" },
  google: { stages: ["primary", "step-up"], label: "Google", icon: "antd:google" },
  apple: { stages: ["primary", "step-up"], label: "Apple", icon: "antd:apple" },
  github: { stages: ["primary", "step-up"], label: "GitHub", icon: "antd:github" },
  microsoft: { stages: ["primary", "step-up"], label: "Microsoft", icon: "antd:windows" },
  totp: { stages: ["second-factor", "step-up"], label: "Authenticator app" },
  "email-otp": { stages: ["primary", "second-factor", "recovery"], label: "Email code" },
  "sms-otp": { stages: ["second-factor", "recovery"], label: "SMS code" },
  "recovery-code": { stages: ["recovery"], label: "Recovery code" },
} as const satisfies Record<string, { stages: readonly PhiAuthStage[]; label: string; icon?: string }>;

export type PhiCoreAuthMethodKey = keyof typeof PHI_CORE_AUTH_METHODS;

export const PHI_OIDC_PROVIDER_ISSUERS = {
  google: "https://accounts.google.com",
  apple: "https://appleid.apple.com",
} as const;

export const PHI_GITHUB_IDENTITY_ISSUER = "https://github.com";
export const PHI_MICROSOFT_IDENTITY_ORIGIN = "https://login.microsoftonline.com";
export const PHI_MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

export function buildMicrosoftIssuer(tenant: string) {
  return `${PHI_MICROSOFT_IDENTITY_ORIGIN}/${encodeURIComponent(tenant)}/v2.0`;
}

export type PhiAuthMethodPresentation = {
  label?: string;
  icon?: string;
};

export type PhiPublicAuthMethod = {
  methodKey: string;
  stage: PhiAuthStage;
  label: string;
  icon?: string;
  installationKey?: string;
  startPath: string;
};

export type PhiPublicAuthManifest = {
  version: 1;
  registrationMode: PhiAuthRegistrationMode;
  methods: readonly PhiPublicAuthMethod[];
};

export function isPhiAuthStage(value: unknown): value is PhiAuthStage {
  return typeof value === "string" && PHI_AUTH_STAGES.includes(value as PhiAuthStage);
}

export function isPhiAuthRegistrationMode(value: unknown): value is PhiAuthRegistrationMode {
  return typeof value === "string" &&
    PHI_AUTH_REGISTRATION_MODES.includes(value as PhiAuthRegistrationMode);
}

export function isPhiAuthLinkingMode(value: unknown): value is PhiAuthLinkingMode {
  return typeof value === "string" && PHI_AUTH_LINKING_MODES.includes(value as PhiAuthLinkingMode);
}

export function isPhiAuthFactorEnforcementMode(
  value: unknown,
): value is PhiAuthFactorEnforcementMode {
  return typeof value === "string" &&
    PHI_AUTH_FACTOR_ENFORCEMENT_MODES.includes(value as PhiAuthFactorEnforcementMode);
}

export function isPhiAuthSessionState(value: unknown): value is PhiAuthSessionState {
  return typeof value === "number" && Number.isInteger(value) &&
    Object.values(PHI_AUTH_SESSION_STATES).includes(value as PhiAuthSessionState);
}

export function isPhiCoreAuthMethodStage(methodKey: string, stage: PhiAuthStage) {
  const method = PHI_CORE_AUTH_METHODS[methodKey as PhiCoreAuthMethodKey];
  return Boolean(method?.stages.includes(stage as never));
}

export function normalizeAuthNextPath(value: unknown, fallback = "/") {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  if (
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return fallback;
  }
  try {
    const parsed = new URL(normalized, "https://phi.invalid");
    return parsed.origin === "https://phi.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeProviderKey(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized) ? normalized : null;
}
