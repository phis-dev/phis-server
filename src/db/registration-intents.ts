import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { getPool, withTransaction } from "@/lib/db";
import { encryptRegistrationPassword } from "@/lib/registration-secret";

const REGISTRATION_INTENT_FLAG_NEWSLETTER_OPT_IN = 1 << 0;
export const REGISTRATION_INTENT_STATUS_PENDING = 0;
export const REGISTRATION_INTENT_STATUS_VERIFIED = 1;
export const REGISTRATION_INTENT_STATUS_SUPERSEDED = 2;
export const REGISTRATION_INTENT_STATUS_EXPIRED = 3;
export const REGISTRATION_INTENT_STATUS_CONSUMED = 4;

export type RegistrationIntentStatus =
  | typeof REGISTRATION_INTENT_STATUS_PENDING
  | typeof REGISTRATION_INTENT_STATUS_VERIFIED
  | typeof REGISTRATION_INTENT_STATUS_SUPERSEDED
  | typeof REGISTRATION_INTENT_STATUS_EXPIRED
  | typeof REGISTRATION_INTENT_STATUS_CONSUMED;

export type CreateRegistrationIntentInput = {
  siteId: number;
  userId?: number | null;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  password?: string | null;
  locale: string;
  newsletterOptIn: boolean;
};

export type RegistrationIntentRecord = {
  id: number;
  siteId: number;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  locale: string;
  verificationToken: string;
  verificationTokenExpiresAt: string;
};

export type RegistrationIntentVerificationRecord = {
  id: number;
  siteId: number;
  userId: number | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  companyName: string | null;
  locale: string;
  newsletterOptIn: boolean;
  status: RegistrationIntentStatus;
  verificationTokenExpiresAt: string;
  verifiedAt: string | null;
  consumedAt: string | null;
  passwordCiphertext: string | null;
  passwordIv: string | null;
  passwordAuthTag: string | null;
};

export type RegistrationIntentProfileRecord = {
  siteId: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  companyName: string | null;
  locale: string;
  newsletterOptIn: boolean;
  status: RegistrationIntentStatus;
  createdAt: string;
  verifiedAt: string | null;
  consumedAt: string | null;
};

export type RegistrationIntentProfileSearchRecord = RegistrationIntentProfileRecord;

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function buildFullName(firstName: string | null, lastName: string | null) {
  return [firstName?.trim() ?? "", lastName?.trim() ?? ""].filter(Boolean).join(" ").trim();
}

function hasFlag(value: number, flag: number) {
  return (value & flag) !== 0;
}

function buildIntentFlags(newsletterOptIn: boolean) {
  return newsletterOptIn ? REGISTRATION_INTENT_FLAG_NEWSLETTER_OPT_IN : 0;
}

function mapVerificationRow(
  row: {
    id: number;
    site_id: number;
    user_id: number | null;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    locale: string;
    flags: number;
    status: RegistrationIntentStatus;
    verification_token_expires_at: string;
    verified_at: string | null;
    consumed_at: string | null;
    password_ciphertext: string | null;
    password_iv: string | null;
    password_auth_tag: string | null;
  },
): RegistrationIntentVerificationRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    userId: row.user_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: buildFullName(row.first_name, row.last_name),
    companyName: row.company_name,
    locale: row.locale,
    newsletterOptIn: hasFlag(row.flags, REGISTRATION_INTENT_FLAG_NEWSLETTER_OPT_IN),
    status: row.status,
    verificationTokenExpiresAt: row.verification_token_expires_at,
    verifiedAt: row.verified_at,
    consumedAt: row.consumed_at,
    passwordCiphertext: row.password_ciphertext,
    passwordIv: row.password_iv,
    passwordAuthTag: row.password_auth_tag,
  };
}

export async function createRegistrationIntent(
  input: CreateRegistrationIntentInput,
): Promise<RegistrationIntentRecord> {
  const verificationToken = randomBytes(32).toString("hex");
  const verificationTokenHash = sha256Hex(verificationToken);
  const encryptedPassword = input.password?.trim()
    ? encryptRegistrationPassword(input.password)
    : null;
  const normalizedEmail = normalizeEmail(input.email);
  const flags = buildIntentFlags(input.newsletterOptIn);

  const rows = await withTransaction(async (client) => {
    // Somebody else's address, not the asking account's own: returning to an address this account held
    // before is an email change like any other, and it used to end here as a 500.
    const existingUser = await client.query<{ id: number }>(
      `SELECT email.user_id AS id
       FROM phis.user_emails AS email
       JOIN phis.user_site_memberships AS membership
         ON membership.user_id = email.user_id
        AND membership.site_id = $2
       WHERE email.email_normalized = $1
         AND email.user_id IS DISTINCT FROM $3::int
       LIMIT 1`,
      [normalizedEmail, input.siteId, input.userId ?? null],
    );

    if (existingUser.rows[0]) {
      throw new Error("ACCOUNT_EXISTS");
    }

    /*
     * The newest request for an address wins, whoever sent the older one. That is deliberate: an intent
     * proves nothing until its link is opened from the mailbox, so the only person who can finish any of
     * them is the one who reads that mail -- and for them the latest link is the one that should work.
     * Somebody else entering the same address can only restart the wait, never take the account.
     */
    await client.query(
      `UPDATE phis.registration_intents
       SET status = $3,
           updated_at = NOW()
       WHERE site_id = $1
         AND email = $2
         AND status = $4`,
      [
        input.siteId,
        normalizedEmail,
        REGISTRATION_INTENT_STATUS_SUPERSEDED,
        REGISTRATION_INTENT_STATUS_PENDING,
      ],
    );

    const { rows } = await client.query<{
      id: number;
      site_id: number;
      email: string;
      first_name: string;
      last_name: string;
      locale: string;
      verification_token_expires_at: string;
    }>(
      `INSERT INTO phis.registration_intents (
         site_id,
         user_id,
         email,
         first_name,
         last_name,
         company_name,
         password_ciphertext,
         password_iv,
         password_auth_tag,
         locale,
         flags,
         verification_token_hash,
         verification_token_expires_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         NOW() + INTERVAL '24 hours'
       )
       RETURNING id, site_id, email, first_name, last_name, locale, verification_token_expires_at`,
      [
        input.siteId,
        input.userId ?? null,
        normalizedEmail,
        input.firstName ?? null,
        input.lastName ?? null,
        input.companyName ?? null,
        encryptedPassword?.ciphertextHex ?? null,
        encryptedPassword?.ivHex ?? null,
        encryptedPassword?.authTagHex ?? null,
        input.locale,
        flags,
        verificationTokenHash,
      ],
    );
    return rows;
  });

  const row = rows[0];
  return {
    id: row.id,
    siteId: row.site_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: buildFullName(row.first_name, row.last_name),
    locale: row.locale,
    verificationToken,
    verificationTokenExpiresAt: row.verification_token_expires_at,
  };
}

export async function getRegistrationIntentByVerificationToken(siteId: number, token: string) {
  const pool = getPool();
  const tokenHash = sha256Hex(token);
  const { rows } = await pool.query<{
    id: number;
    site_id: number;
    user_id: number | null;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    locale: string;
    flags: number;
    status: RegistrationIntentStatus;
    verification_token_expires_at: string;
    verified_at: string | null;
    consumed_at: string | null;
    password_ciphertext: string | null;
    password_iv: string | null;
    password_auth_tag: string | null;
  }>(
    `SELECT id, site_id, user_id, email, first_name, last_name, company_name, locale, flags, status,
            verification_token_expires_at, verified_at, consumed_at,
            password_ciphertext, password_iv, password_auth_tag
     FROM phis.registration_intents
     WHERE site_id = $1
       AND verification_token_hash = $2
     LIMIT 1`,
    [siteId, tokenHash],
  );

  return rows[0] ? mapVerificationRow(rows[0]) : null;
}

export async function markRegistrationIntentExpired(id: number) {
  const pool = getPool();
  await pool.query(
    `UPDATE phis.registration_intents
     SET status = $2,
         updated_at = NOW()
     WHERE id = $1
       AND status = $3`,
    [id, REGISTRATION_INTENT_STATUS_EXPIRED, REGISTRATION_INTENT_STATUS_PENDING],
  );
}

/**
 * Takes a pending intent for the one confirmation that may act on it.
 *
 * Two clicks on the same link ran side by side: both created a Medusa customer, and the second account
 * insert failed on the address and answered 500. The first to move the intent to `verified` goes on; the
 * other is answered as already confirmed. `releaseRegistrationIntentClaim` puts it back when that
 * confirmation stopped before consuming it.
 */
export async function claimRegistrationIntent(id: number) {
  const { rowCount } = await getPool().query(
    `UPDATE phis.registration_intents
     SET status = $2, verified_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = $3`,
    [id, REGISTRATION_INTENT_STATUS_VERIFIED, REGISTRATION_INTENT_STATUS_PENDING],
  );
  return (rowCount ?? 0) > 0;
}

/** Undoes a claim that did not end in a consumed intent; a consumed one is left as it is. */
export async function releaseRegistrationIntentClaim(id: number) {
  await getPool().query(
    `UPDATE phis.registration_intents
     SET status = $2, verified_at = NULL, updated_at = NOW()
     WHERE id = $1 AND status = $3`,
    [id, REGISTRATION_INTENT_STATUS_PENDING, REGISTRATION_INTENT_STATUS_VERIFIED],
  );
}

export async function consumeRegistrationIntent(id: number, userId: number) {
  const pool = getPool();
  await pool.query(
    `UPDATE phis.registration_intents
     SET user_id = $2,
         status = $3,
         verified_at = COALESCE(verified_at, NOW()),
         consumed_at = COALESCE(consumed_at, NOW()),
         first_name = NULL,
         last_name = NULL,
         company_name = NULL,
         email = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id, userId, REGISTRATION_INTENT_STATUS_CONSUMED],
  );
}

export async function getLatestRegistrationIntentProfileByEmail(siteId: number, email: string) {
  const pool = getPool();
  const { rows } = await pool.query<{
    site_id: number;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    locale: string;
    flags: number;
    status: RegistrationIntentStatus;
    created_at: string;
    verified_at: string | null;
    consumed_at: string | null;
  }>(
    `SELECT site_id, email, first_name, last_name, company_name, locale, flags, status,
            created_at, verified_at, consumed_at
     FROM phis.registration_intents
     WHERE site_id = $1
       AND email = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [siteId, normalizeEmail(email)],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    siteId: row.site_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: buildFullName(row.first_name, row.last_name),
    companyName: row.company_name,
    locale: row.locale,
    newsletterOptIn: hasFlag(row.flags, REGISTRATION_INTENT_FLAG_NEWSLETTER_OPT_IN),
    status: row.status,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    consumedAt: row.consumed_at,
  } satisfies RegistrationIntentProfileRecord;
}

export async function searchLatestRegistrationIntentProfiles(siteId: number, query: string, limit = 8) {
  const pool = getPool();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [] as RegistrationIntentProfileSearchRecord[];
  }

  const { rows } = await pool.query<{
    site_id: number;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    locale: string;
    flags: number;
    status: RegistrationIntentStatus;
    created_at: string;
    verified_at: string | null;
    consumed_at: string | null;
  }>(
    `SELECT DISTINCT ON (COALESCE(email, CONCAT('__consumed__', id::text)))
        site_id, email, first_name, last_name, company_name, locale, flags, status,
        created_at, verified_at, consumed_at, id
     FROM phis.registration_intents
     WHERE site_id = $1
       AND (
         COALESCE(email, '') ILIKE $2
         OR CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, '')) ILIKE $2
         OR COALESCE(company_name, '') ILIKE $2
       )
     ORDER BY COALESCE(email, CONCAT('__consumed__', id::text)), created_at DESC
     LIMIT $3`,
    [siteId, `%${normalizedQuery}%`, limit],
  );

  return rows.map(
    (row) =>
      ({
        siteId: row.site_id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: buildFullName(row.first_name, row.last_name),
        companyName: row.company_name,
        locale: row.locale,
        newsletterOptIn: hasFlag(row.flags, REGISTRATION_INTENT_FLAG_NEWSLETTER_OPT_IN),
        status: row.status,
        createdAt: row.created_at,
        verifiedAt: row.verified_at,
        consumedAt: row.consumed_at,
      }) satisfies RegistrationIntentProfileSearchRecord,
  );
}
