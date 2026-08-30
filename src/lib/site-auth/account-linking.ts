import type {
  PhiAuthLinkingMode,
  PhiAuthRegistrationMode,
} from "./contracts";

export type PhiExternalAccountResolutionDecision =
  | "use-linked-user"
  | "create-user"
  | "link-existing-user"
  | "link-required"
  | "membership-required"
  | "registration-disabled"
  | "verified-email-required"
  | "account-disabled";

export function decideExternalAccountResolution(input: {
  identityUserId: number | null;
  emailUserId: number | null;
  hasMembership: boolean;
  accountEnabled: boolean;
  emailVerified: boolean;
  registrationMode: PhiAuthRegistrationMode;
  linkingMode: PhiAuthLinkingMode;
  trustedForAutoLink: boolean;
  privileged: boolean;
  allowPrivilegedAutoLink: boolean;
}): PhiExternalAccountResolutionDecision {
  if (!input.accountEnabled && (input.identityUserId || input.emailUserId)) {
    return "account-disabled";
  }

  if (input.identityUserId) {
    if (input.hasMembership) {
      return "use-linked-user";
    }
    return input.registrationMode === "automatic"
      ? "use-linked-user"
      : "membership-required";
  }

  if (!input.emailVerified) {
    return "verified-email-required";
  }

  if (input.emailUserId) {
    if (
      input.linkingMode === "verified-email-auto" &&
      input.trustedForAutoLink &&
      (!input.privileged || input.allowPrivilegedAutoLink)
    ) {
      return input.hasMembership || input.registrationMode === "automatic"
        ? "link-existing-user"
        : "membership-required";
    }
    return "link-required";
  }

  return input.registrationMode === "automatic"
    ? "create-user"
    : "registration-disabled";
}
