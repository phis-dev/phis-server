import type { PhisAddonRoleDescriptor } from "./contract.ts";

/**
 * The roles a person holds, from the roles they were granted: each granted role, and every role it
 * `includes`, followed through.
 *
 * One function, because every place Core asks whether somebody holds a role -- a guarded query, a slot,
 * `roles:v1`, a grant policy, the Site viewer -- must give the same answer. A role the current manifest
 * does not declare opens nothing, granted or implied: a grant left behind by an older version stays
 * stored and stays silent.
 *
 * Answered in declaration order, which is the order an Add-on reads back.
 */
export function expandPhisAddonHeldRoles(
  declared: readonly PhisAddonRoleDescriptor[],
  granted: Iterable<string>,
): string[] {
  const byName = new Map(declared.map((role) => [role.name, role] as const));
  const held = new Set<string>();
  const pending = [...granted].filter((name) => byName.has(name));
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (held.has(name)) {
      continue;
    }
    held.add(name);
    for (const implied of byName.get(name)?.includes ?? []) {
      if (byName.has(implied) && !held.has(implied)) {
        pending.push(implied);
      }
    }
  }
  return declared.map((role) => role.name).filter((name) => held.has(name));
}

/**
 * The one rule for what somebody holds of an Add-on's roles: a Site Admin holds every declared role,
 * whether or not an assignment is stored; anybody else holds what was granted and what it includes.
 *
 * Every "does the actor hold this role" answer -- `roles:v1`, `requiresRole` and `alsoAllowedByRole`,
 * a slot's `requiresRole`, the viewer's `addonRoleClaims` -- ends here. "Hold" is not "stored": the
 * stored assignments stay what user administration shows and what a recipient list reads, because an
 * assignment that triggers something (mail to everybody who is a clerk) must not start at the admin.
 */
export function resolvePhisAddonHeldRoles(
  declared: readonly PhisAddonRoleDescriptor[],
  granted: Iterable<string>,
  siteAdmin: boolean,
): string[] {
  return siteAdmin ? declared.map((role) => role.name) : expandPhisAddonHeldRoles(declared, granted);
}

/**
 * The declared roles whose holder holds `role`: the role itself and every role that includes it,
 * followed through. Which stored grants make somebody a holder of `role`, by the same expansion every
 * `has()` uses.
 */
export function listPhisAddonRolesImplying(
  declared: readonly PhisAddonRoleDescriptor[],
  role: string,
): string[] {
  return declared
    .map((candidate) => candidate.name)
    .filter((name) => expandPhisAddonHeldRoles(declared, [name]).includes(role));
}

/**
 * The first cycle among the inclusions, as the names along it, or null when there is none.
 *
 * Two roles that imply each other are one role under two names; the validator refuses that rather than
 * guessing which of the two the author meant.
 */
export function findPhisAddonRoleInclusionCycle(
  roles: readonly { name: string; includes?: readonly string[] }[],
): string[] | null {
  const byName = new Map(roles.map((role) => [role.name, role.includes ?? []] as const));
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    const seen = state.get(name);
    if (seen === "done") return null;
    if (seen === "open") return [...path.slice(path.indexOf(name)), name];
    state.set(name, "open");
    path.push(name);
    for (const next of byName.get(name) ?? []) {
      if (!byName.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(name, "done");
    return null;
  };
  for (const role of roles) {
    const cycle = visit(role.name);
    if (cycle) return cycle;
  }
  return null;
}
