# Authentication: Planned Parts

**Status: design.** Nothing in this document is implemented. The contract that holds today is
[AUTHENTICATION.md](../AUTHENTICATION.md); section numbers below refer to it. The method keys `passkey`,
`email-otp`, and `sms-otp` and the `passkeyPolicy` field already exist in the Site authentication policy
vocabulary (`src/lib/site-auth/contracts.ts`), and `user_auth_factors` reserves a passkey factor type, but
no enrollment, challenge, or verification flow exists for them.

## 1. Passkeys

Passkeys use WebAuthn. Enrollment and assertion validation are server-generated challenges bound to the
Site's approved origin and RP id. A passkey credential stores the credential id, public key, signature
counter/backup state, transports where useful, user handle, RP scope, and timestamps; the private key
never leaves the authenticator. A passkey may serve as primary authentication or satisfy a stronger
factor according to Site policy.

A passkey is a common primary method and may also satisfy second-factor or step-up policy (section 5).
Account-linking confirmation (section 7) extends to a passkey proof without changing the linking decision.

## 2. Email and SMS one-time codes

Email and SMS delivery are transports, not trust authorities. Core creates and validates the one-time
challenge while the configured mail/SMS service only delivers it. Codes are short-lived, attempt-limited,
single-use, and bound to Site, user/workflow, and intended stage.

Email OTP may be enabled as primary, second-factor, or recovery according to Site policy; SMS OTP is
normally second-factor or recovery (section 5).

## 3. Setup token for the first Site Admin

Besides `phis site admin`, the first Site Admin may be created through a single-use, short-lived setup
token produced by `phis-cli`. First-time setup is accepted only while the Site has no Admin and the token
is valid. It may bind a password, passkey, or validated external identity and must create the global user,
Site membership, and Core Admin role claim atomically. Bootstrap tokens follow AUTHENTICATION.md section 15: short-lived,
single-use, and invalid after successful consumption.

## 4. CLI emergency recovery

`phis-cli` owns emergency recovery under explicit operator authority: unlock an Admin, reset factors,
revoke sessions, enable or disable a Site user membership, or issue a new single-use bootstrap flow.
Today the CLI can grant and revoke the Site Admin role and set a Site user's password
(`phis site admin`, `phis site user`), and change Site and platform-operator state, but not a Site user's
membership state, factors, or sessions.
