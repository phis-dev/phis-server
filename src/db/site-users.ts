import "server-only";

import type { PoolClient } from "pg";

import type { PhisEntitlementSubject } from "@phis/contracts/entitlements";
import { PhisSiteAddressFlags, type PhisSiteAddress, type PhisSiteAddressInput } from "@phis/contracts/users";

import { getPool, withTransaction } from "@/lib/db";
import { newEntitlementSubjectReference } from "@/db/entitlement-subject-reference.mts";
import { userDisplayNameSql } from "@/db/user-profiles";
import { announcePhisUserEvent, schedulePhisUserEventDelivery } from "@/lib/addons/user-events";
import {
  PHIS_SITE_ADDRESS_CONTRACT_FLAGS,
  PHIS_SITE_ADDRESS_DEFAULT_FLAGS,
  PHIS_SITE_ADDRESS_FLAG_HANDED_OUT,
  PHIS_SITE_ADDRESS_RETIRED_FLAGS,
  type PhisUsersAccessOperationValue,
  type PhisUsersAccessRoadValue,
} from "@/lib/constants/users";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * A person of the Site as `users:v1` reads them, the Site's address book, and the access log
 * (SERVER_ADDONS.md, users:v1). Who may read what is the capability's question
 * (`src/lib/addons/users-capability.ts`); this file reads and writes what it was told to.
 *
 * Every read that hands an address to an Add-on marks it handed out (`PHIS_SITE_ADDRESS_FLAG_HANDED_OUT`),
 * in the statement that reads it: Core cannot see an Add-on's records, so that mark is what keeps an
 * address a record may point at when the person removes it.
 */

export class PhisSiteUsersError extends Error {}

/** One asked subject as `readPhisUserDescriptions` found it, in the order asked. */
export type PhisUserDescriptionRow = {
  subject: PhisEntitlementSubject;
  /** The person behind the subject on this Site, or null for an unknown subject or one of another Site. */
  userId: number | null;
  member: boolean;
  profile: {
    firstName: string;
    lastName: string;
    displayName: string | null;
    companyName: string | null;
    phone: string | null;
    mobile: string | null;
  } | null;
  email: string | null;
};

/**
 * The people behind `subjects` on the Site, one row per entry asked, duplicates where they stand. Only
 * the parts asked for are read: `email` reads the primary address, `profile` the names and numbers.
 */
export async function readPhisUserDescriptions(input: {
  siteId: number;
  subjects: readonly string[];
  profile: boolean;
  email: boolean;
}): Promise<PhisUserDescriptionRow[]> {
  if (input.subjects.length === 0) {
    return [];
  }
  const { rows } = await getPool().query<{
    subject: string;
    user_id: number | null;
    member: boolean;
    has_profile: boolean;
    first_name: string | null;
    last_name: string | null;
    display_name: string | null;
    company_name: string | null;
    phone: string | null;
    mobile: string | null;
    email: string | null;
  }>(
    `SELECT ask.subject, s.user_id, (m.user_id IS NOT NULL) AS member,
            (p.user_id IS NOT NULL) AS has_profile, p.first_name, p.last_name, p.display_name, p.company_name,
            p.phone, p.mobile, e.email_normalized AS email
     FROM unnest($2::text[]) WITH ORDINALITY AS ask(subject, ord)
     LEFT JOIN phis.entitlement_subjects s ON s.site_id = $1 AND s.reference = ask.subject
     LEFT JOIN phis.user_site_memberships m ON m.site_id = $1 AND m.user_id = s.user_id
     LEFT JOIN phis.user_profiles p ON $3::boolean AND p.user_id = m.user_id
     LEFT JOIN LATERAL (
       SELECT email.email_normalized
       FROM phis.user_emails email
       WHERE $4::boolean AND email.user_id = m.user_id
       ORDER BY (email.flags & 1) DESC, email.verified_at ASC, email.id ASC
       LIMIT 1
     ) e ON TRUE
     ORDER BY ask.ord`,
    [input.siteId, input.subjects, input.profile, input.email],
  );
  return rows.map((row) => ({
    subject: row.subject,
    userId: row.user_id,
    member: row.member,
    profile: row.has_profile
      ? {
          firstName: row.first_name ?? "",
          lastName: row.last_name ?? "",
          displayName: row.display_name,
          companyName: row.company_name,
          phone: row.phone,
          mobile: row.mobile,
        }
      : null,
    email: row.email,
  }));
}

type AddressRow = {
  id: number;
  user_id: number | null;
  subject: string | null;
  flags: number;
  company_name: string | null;
  name: string;
  line1: string;
  line2: string | null;
  postal_code: string | null;
  city: string;
  region: string | null;
  country: string;
  replaces_id: number | null;
  created_at: Date;
};

/** The columns of an answered address, its subject joined from the person's subject on the Site. */
const ADDRESS_COLUMNS = `a.id, a.user_id, s.reference AS subject, a.flags, a.company_name, a.name, a.line1, a.line2,
  a.postal_code, a.city, a.region, a.country, a.replaces_id, a.created_at`;
const ADDRESS_SUBJECT_JOIN = `LEFT JOIN phis.entitlement_subjects s ON s.site_id = a.site_id AND s.user_id = a.user_id`;

function mapAddress(row: AddressRow): PhisSiteAddress & { userId: number | null } {
  return {
    id: row.id,
    userId: row.user_id,
    subject: row.subject,
    // Core's own bits never leave it.
    flags: row.flags & PHIS_SITE_ADDRESS_CONTRACT_FLAGS,
    companyName: row.company_name,
    name: row.name,
    line1: row.line1,
    line2: row.line2,
    postalCode: row.postal_code,
    city: row.city,
    region: row.region,
    country: row.country,
    replacesId: row.replaces_id,
    createdAt: row.created_at.toISOString(),
  };
}

/** The statement that marks the addresses in `picked` handed out, once each, beside the read. */
const MARK_HANDED_OUT = `marked AS (
       UPDATE phis.site_addresses target
       SET flags = target.flags | ${PHIS_SITE_ADDRESS_FLAG_HANDED_OUT}
       FROM picked
       WHERE target.id = picked.id AND (target.flags & ${PHIS_SITE_ADDRESS_FLAG_HANDED_OUT}) = 0
     )`;

/**
 * The current addresses of these members on the Site (neither `Superseded` nor `Removed`), by person, oldest
 * first. Every one answered is marked handed out, unless the caller is Core showing them to a person
 * (`handedOut: false`: the account, the customer file), where no Add-on record can come to point at them.
 */
export async function readPhisCurrentSiteAddresses(siteId: number, userIds: readonly number[], options: { handedOut?: boolean } = {}) {
  const byUser = new Map<number, PhisSiteAddress[]>();
  if (userIds.length === 0) {
    return byUser;
  }
  const { rows } = await getPool().query<AddressRow>(
    `WITH picked AS (
       SELECT ${ADDRESS_COLUMNS}
       FROM phis.site_addresses a
       ${ADDRESS_SUBJECT_JOIN}
       WHERE a.site_id = $1 AND a.user_id = ANY($2::int[]) AND (a.flags & ${PHIS_SITE_ADDRESS_RETIRED_FLAGS}) = 0
     )${options.handedOut === false ? "" : `, ${MARK_HANDED_OUT}`}
     SELECT * FROM picked ORDER BY user_id, id`,
    [siteId, [...new Set(userIds)]],
  );
  for (const row of rows) {
    const { userId, ...address } = mapAddress(row);
    const list = byUser.get(userId!) ?? [];
    list.push(address);
    byUser.set(userId!, list);
  }
  return byUser;
}

/**
 * Addresses of the Site's book by id, whatever their flags, in the order asked without duplicates; an id
 * of another Site is absent. `ownerUserId` narrows them to one person's (the person reading their own).
 * Every one answered is marked handed out.
 */
export async function readPhisSiteAddressesByIds(input: {
  siteId: number;
  ids: readonly number[];
  ownerUserId: number | null;
}): Promise<PhisSiteAddress[]> {
  if (input.ids.length === 0) {
    return [];
  }
  const { rows } = await getPool().query<AddressRow & { ord: string }>(
    `WITH picked AS (
       SELECT ${ADDRESS_COLUMNS}, MIN(ask.ord) AS ord
       FROM unnest($2::int[]) WITH ORDINALITY AS ask(id, ord)
       JOIN phis.site_addresses a ON a.id = ask.id AND a.site_id = $1
       ${ADDRESS_SUBJECT_JOIN}
       WHERE ($3::int IS NULL OR a.user_id = $3::int)
       GROUP BY a.id, s.reference
     ), ${MARK_HANDED_OUT}
     SELECT * FROM picked ORDER BY ord`,
    [input.siteId, input.ids, input.ownerUserId],
  );
  return rows.map((row) => {
    const { userId: _userId, ...address } = mapAddress(row);
    return address;
  });
}

/** Text compared as Core stores it: trimmed, and empty as null where the field may be empty. */
const ADDRESS_EQUAL_SQL = `a.name = $3 AND a.line1 = $4 AND a.city = $5 AND a.country = $6
  AND a.company_name IS NOT DISTINCT FROM $7 AND a.line2 IS NOT DISTINCT FROM $8
  AND a.postal_code IS NOT DISTINCT FROM $9 AND a.region IS NOT DISTINCT FROM $10`;

/**
 * Writes an address into the Site's book (`users:v1` `createAddress`); the caller has checked who may
 * and normalized the input and the flags.
 *
 * For a person, under an advisory lock of theirs on the Site, so two writes take turns at the defaults
 * and at the comparison: an address equal in every part to one of their current ones is that one, given
 * the purposes and defaults asked for besides, instead of a second; otherwise a new row. A default asked
 * for moves from the address that held it. `replaces` -- one of the person's current addresses -- is then
 * `Superseded` and gives up its defaults, and the person's `user.changed` with `address` is owed on this
 * Site. A guest's address is always a new row and replaces nothing. The answer is marked handed out.
 */
export async function createPhisSiteAddress(input: {
  siteId: number;
  userId: number | null;
  address: PhisSiteAddressInput;
  flags: number;
  replaces: number | null;
  /** True where the answer goes to an Add-on (`createAddress`); false for the person's own account route. */
  handedOut: boolean;
}): Promise<PhisSiteAddress> {
  const { siteId, userId, address } = input;
  const answeredFlags = input.flags | (input.handedOut ? PHIS_SITE_ADDRESS_FLAG_HANDED_OUT : 0);
  const params = [
    siteId,
    userId,
    address.name,
    address.line1,
    address.city,
    address.country,
    address.companyName,
    address.line2,
    address.postalCode,
    address.region,
  ];
  const result = await withTransaction(async (client) => {
    if (userId == null) {
      const { rows } = await client.query<AddressRow>(
        `WITH written AS (
           INSERT INTO phis.site_addresses (site_id, user_id, flags, name, line1, city, country, company_name, line2, postal_code, region)
           VALUES ($1, $2::int, $11, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *
         )
         SELECT a.id, a.user_id, NULL::text AS subject, a.flags, a.company_name, a.name, a.line1, a.line2,
                a.postal_code, a.city, a.region, a.country, a.replaces_id, a.created_at
         FROM written a`,
        [...params, answeredFlags],
      );
      return { row: rows[0]!, moved: false };
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify(["site-address", siteId, userId])]);
    // The person's subject on the Site, which every answer about the address names.
    await client.query(
      `INSERT INTO phis.entitlement_subjects (site_id, user_id, reference)
       VALUES ($1, $2, $3)
       ON CONFLICT (site_id, user_id) DO NOTHING`,
      [siteId, userId, newEntitlementSubjectReference()],
    );
    if (input.replaces != null) {
      const { rows } = await client.query(
        `SELECT 1 FROM phis.site_addresses
         WHERE id = $1 AND site_id = $2 AND user_id = $3 AND (flags & ${PHIS_SITE_ADDRESS_RETIRED_FLAGS}) = 0`,
        [input.replaces, siteId, userId],
      );
      if (rows.length === 0) {
        throw new PhisSiteUsersError("replaces names no current address of this person on this Site.");
      }
    }
    const { rows: equal } = await client.query<{ id: number }>(
      `SELECT a.id FROM phis.site_addresses a
       WHERE a.site_id = $1 AND a.user_id = $2 AND (a.flags & ${PHIS_SITE_ADDRESS_RETIRED_FLAGS}) = 0
         AND ${ADDRESS_EQUAL_SQL}
       ORDER BY a.id
       LIMIT 1`,
      params,
    );
    const keep = equal[0]?.id ?? null;
    // A default moves: from every other address of the person, the one replaced among them.
    const defaults = input.flags & PHIS_SITE_ADDRESS_DEFAULT_FLAGS;
    if (defaults !== 0) {
      await client.query(
        `UPDATE phis.site_addresses SET flags = flags & ~$4::int
         WHERE site_id = $1 AND user_id = $2 AND id IS DISTINCT FROM $3::int AND (flags & $4::int) <> 0`,
        [siteId, userId, keep, defaults],
      );
    }
    const replaced = input.replaces != null && input.replaces !== keep ? input.replaces : null;
    if (replaced != null) {
      await client.query(
        `UPDATE phis.site_addresses
         SET flags = (flags | ${PhisSiteAddressFlags.Superseded}) & ~${PHIS_SITE_ADDRESS_DEFAULT_FLAGS}
         WHERE id = $1`,
        [replaced],
      );
    }
    const { rows } = keep != null
      ? await client.query<AddressRow>(
        `WITH written AS (
           UPDATE phis.site_addresses SET flags = flags | $2::int WHERE id = $1 RETURNING *
         )
         SELECT ${ADDRESS_COLUMNS} FROM written a ${ADDRESS_SUBJECT_JOIN}`,
        [keep, answeredFlags],
      )
      : await client.query<AddressRow>(
        `WITH written AS (
           INSERT INTO phis.site_addresses (site_id, user_id, flags, name, line1, city, country, company_name, line2, postal_code, region, replaces_id)
           VALUES ($1, $2, $11, $3, $4, $5, $6, $7, $8, $9, $10, $12)
           RETURNING *
         )
         SELECT ${ADDRESS_COLUMNS} FROM written a ${ADDRESS_SUBJECT_JOIN}`,
        [...params, answeredFlags, replaced],
      );
    const sites = replaced != null
      ? await announcePhisUserEvent(client, { userId, siteIds: [siteId], event: "user.changed", fields: ["address"] })
      : [];
    return { row: rows[0]!, moved: sites.length > 0 };
  });
  if (result.moved) {
    schedulePhisUserEventDelivery([siteId]);
  }
  const { userId: _userId, ...answered } = mapAddress(result.row);
  return answered;
}

/**
 * A person removes one of their current addresses on the Site (`DELETE /api/site/account/addresses/{id}`).
 *
 * The address and the versions it followed go: every one never handed to an Add-on is deleted, and every
 * one that was is kept as `Removed` without its defaults, for the records that may point at it (a newer
 * version's `replaces_id` to a deleted one is cleared by its foreign key). Owes the person's
 * `user.changed` with `address` on this Site. Answers what became of the address named -- `deleted`, or
 * `removed` where it was handed out -- and null for an id that is no current address of theirs.
 */
export async function removePhisSiteAddress(input: { siteId: number; userId: number; addressId: number }): Promise<"deleted" | "removed" | null> {
  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify(["site-address", input.siteId, input.userId])]);
    const { rows } = await client.query<{ id: number; flags: number }>(
      `WITH RECURSIVE chain(id) AS (
         SELECT a.id FROM phis.site_addresses a
         WHERE a.id = $3 AND a.site_id = $1 AND a.user_id = $2 AND (a.flags & ${PHIS_SITE_ADDRESS_RETIRED_FLAGS}) = 0
         UNION
         SELECT older.id
         FROM chain
         JOIN phis.site_addresses newer ON newer.id = chain.id
         JOIN phis.site_addresses older ON older.id = newer.replaces_id AND older.site_id = $1 AND older.user_id = $2
       )
       SELECT chain.id, a.flags FROM chain JOIN phis.site_addresses a ON a.id = chain.id`,
      [input.siteId, input.userId, input.addressId],
    );
    if (rows.length === 0) {
      return null;
    }
    const ids = rows.map((row) => row.id);
    const named = rows.find((row) => row.id === input.addressId)!;
    const outcome = (named.flags & PHIS_SITE_ADDRESS_FLAG_HANDED_OUT) !== 0 ? "removed" as const : "deleted" as const;
    await client.query(
      `UPDATE phis.site_addresses
       SET flags = (flags | ${PhisSiteAddressFlags.Removed}) & ~${PHIS_SITE_ADDRESS_DEFAULT_FLAGS}
       WHERE id = ANY($1::int[]) AND (flags & ${PHIS_SITE_ADDRESS_FLAG_HANDED_OUT}) <> 0`,
      [ids],
    );
    await client.query(
      `DELETE FROM phis.site_addresses
       WHERE id = ANY($1::int[]) AND (flags & ${PHIS_SITE_ADDRESS_FLAG_HANDED_OUT}) = 0`,
      [ids],
    );
    const sites = await announcePhisUserEvent(client, { userId: input.userId, siteIds: [input.siteId], event: "user.changed", fields: ["address"] });
    return { outcome, sites };
  });
  if (result == null) {
    return null;
  }
  schedulePhisUserEventDelivery(result.sites);
  return result.outcome;
}

/**
 * The person behind a subject on the Site, and whether they are a member; null for an unknown subject
 * and for one of another Site.
 */
export async function findPhisSiteSubjectMember(siteId: number, subject: string) {
  const { rows } = await getPool().query<{ user_id: number; member: boolean }>(
    `SELECT s.user_id,
            EXISTS (SELECT 1 FROM phis.user_site_memberships m WHERE m.site_id = s.site_id AND m.user_id = s.user_id) AS member
     FROM phis.entitlement_subjects s
     WHERE s.site_id = $1 AND s.reference = $2`,
    [siteId, subject],
  );
  return rows[0] ? { userId: rows[0].user_id, member: rows[0].member } : null;
}

/** One answer that carried personal data, written to the Site's access log before it is handed over. */
export async function recordPhisUsersAccess(db: DbQueryable | null, entry: {
  siteId: number;
  addonId: string;
  actorUserId: number | null;
  road: PhisUsersAccessRoadValue;
  operation: PhisUsersAccessOperationValue;
  subjects: readonly string[];
  addressIds: readonly number[];
  fields: number;
}) {
  await (db ?? getPool()).query(
    `INSERT INTO phis.users_access_log (site_id, addon_id, actor_user_id, road, operation, subjects, address_ids, fields)
     VALUES ($1, $2, $3, $4, $5, $6::varchar(40)[], $7::int[], $8)`,
    [
      entry.siteId,
      entry.addonId,
      entry.actorUserId,
      entry.road,
      entry.operation,
      [...new Set(entry.subjects)],
      [...new Set(entry.addressIds)],
      entry.fields,
    ],
  );
}

/** The Site's retention of the access log, in days (`sites.users_access_log_days`); null for no such Site. */
export async function readPhisUsersAccessLogDays(siteId: number): Promise<number | null> {
  const { rows } = await getPool().query<{ days: number }>(
    `SELECT users_access_log_days AS days FROM phis.sites WHERE id = $1`,
    [siteId],
  );
  return rows[0]?.days ?? null;
}

/** Sets the Site's retention of the access log; the caller holds it to 1..3650 days. */
export async function setPhisUsersAccessLogDays(siteId: number, days: number): Promise<void> {
  await getPool().query(
    `UPDATE phis.sites SET users_access_log_days = $2, updated_at = NOW() WHERE id = $1`,
    [siteId, days],
  );
}

export type PhisUsersAccessLogEntry = {
  at: string;
  addonId: string;
  actor: { userId: number; displayName: string } | null;
  road: number;
  operation: number;
  subjects: string[];
  addressIds: number[];
  fields: number;
};

/**
 * A page of the Site's access log, newest first, narrowed to one subject, one Add-on, or both. The actor
 * is named as the person is shown (`userDisplayNameSql`, `#<id>` without a name); an account that is gone
 * since is still named by its id.
 */
export async function listPhisUsersAccessLog(input: {
  siteId: number;
  subject: string | null;
  addonId: string | null;
  page: number;
  pageSize: number;
}): Promise<PhisUsersAccessLogEntry[]> {
  const { rows } = await getPool().query<{
    created_at: Date;
    addon_id: string;
    actor_user_id: number | null;
    actor_name: string | null;
    road: number;
    operation: number;
    subjects: string[];
    address_ids: number[];
    fields: number;
  }>(
    `SELECT l.created_at, l.addon_id, l.actor_user_id, ${userDisplayNameSql("p")} AS actor_name,
            l.road, l.operation, l.subjects, l.address_ids, l.fields
     FROM phis.users_access_log l
     LEFT JOIN phis.user_profiles p ON p.user_id = l.actor_user_id
     WHERE l.site_id = $1
       AND ($2::text IS NULL OR $2::text = ANY(l.subjects))
       AND ($3::text IS NULL OR l.addon_id = $3::text)
     ORDER BY l.id DESC
     LIMIT $4 OFFSET $5`,
    [input.siteId, input.subject, input.addonId, input.pageSize, (input.page - 1) * input.pageSize],
  );
  return rows.map((row) => ({
    at: row.created_at.toISOString(),
    addonId: row.addon_id,
    actor: row.actor_user_id == null ? null : { userId: row.actor_user_id, displayName: row.actor_name ?? `#${row.actor_user_id}` },
    road: row.road,
    operation: row.operation,
    subjects: row.subjects,
    addressIds: row.address_ids,
    fields: row.fields,
  }));
}

/** A member of the Site by user id, with the name they are shown under; null for anybody who is no member. */
export async function readPhisSiteMember(siteId: number, userId: number): Promise<{ userId: number; displayName: string } | null> {
  const { rows } = await getPool().query<{ display_name: string | null }>(
    `SELECT ${userDisplayNameSql("p")} AS display_name
     FROM phis.user_site_memberships m
     LEFT JOIN phis.user_profiles p ON p.user_id = m.user_id
     WHERE m.site_id = $1 AND m.user_id = $2`,
    [siteId, userId],
  );
  return rows[0] ? { userId, displayName: rows[0].display_name ?? `#${userId}` } : null;
}
