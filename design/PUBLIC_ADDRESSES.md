# Public Addresses: Planned Parts

**Status: design.** Nothing in this document is implemented. What holds today: every Area but Public
places a Module's routes under its package path, `/<scope>/<package>/…`; in Public a Module whose declared
path is taken is offered another address by the Modules workspace dialog and is not enabled without one;
Site Page addresses follow [REFERENCES.md](../REFERENCES.md).

## 1. A Site Page can hold an address too

The collision check of the path-change command looks only in `site_page_scopes`, and a Site path is
validated against `/api`, `/_next`, `/operator`, and `/setup` alone. Site against Module is therefore
unchecked in both directions, in Public and outside it.

The rule is the one already in force for Modules, with a second kind of holder: whoever asks second bears
the cost.

- In Public, a Module that finds its declared path held by a published Site Page is offered another
  address by the same dialog, which needs only a second reason to give for why an address is taken.
- Outside Public the newcomer has nothing to yield with, because its path is its package identity: a Site
  Page authored on `/acme/shop` before that package was installed makes the activation refuse, naming the
  occupied path, until the Site moves the Page. This is written down for Module builders in
  `phis-ui/THIRD_PARTY_MODULES.md`.
- A Site Page may not be moved onto the path of a package active in its Area. Moving the Page is cheap
  once durable redirects (section 4) exist, because a published address survives the move.

## 2. What the collision dialog says

The dialog does not say whether an address is already public. It knows -- the published Area revision
routes it -- and an operator answering the question should see the difference between renaming something
nobody has visited and moving an address that stands in an index.

## 3. A standing list of Public addresses

An address is settled by whoever asks for it second, and an operator who wants the other order switches
the first Module off, the second on, and the first on again. A standing list of the Site's Public
addresses, editable while everything stays enabled, makes that order reachable without switching.

A Module update that introduces a colliding Public path deactivates the Module until the route resolves
again -- the update is what moved. Deactivation is a state with an exit: naming a free path brings the
Module back, nothing is rebuilt, and an assignment already made stays made. The update command reports it
before the rollout, not only in a log. A package update that changes a declared path is also the one
address move without a Site gesture, and belongs to this list rather than to durable redirects.

## 4. Durable redirects

Renaming a Page path drops the old address to a 404 with no trace. Internal links do not notice --
references persist identity, never an href -- so what breaks is everything outside: bookmarks, foreign
links, and the index entry with its history.

- *One source.* A Site-authored Page whose path was published and which the Builder then moves, in every
  Area. Module addresses are not a source: in a Public collision the newcomer yields and never the holder,
  so a published Module address cannot be pulled away, and outside Public a route lives under its package
  path. The off/on gesture that reverses an order does move a published address, but the address then has
  a new holder or none, and neither takes a redirect.
- *What a row holds:* the old path and the target, where the target is a structured internal reference --
  `site_page_scopes.id`, the variant the reference codec already issues -- and never the target path. That
  makes `/a -> /b -> /c` two rows that both resolve in one hop to wherever the Page is now: no chains, no
  cycles, no hop limit.
- *The trigger:* the publish that promotes a pending path. It is the one place a live Site path changes.
  The condition is that the Scope had a published revision before this publish: never published means the
  address was never public, and withdrawn means it has been a 404 since, which a redirect would undo.
- *The invariant:* the history holds only paths that no live Page occupies. A new Page claiming a
  remembered path deletes that row rather than being shadowed by it, and a Page renamed back onto its old
  path drops the row it made. The two sets never intersect, so no precedence rule and no fallback is
  needed.
- *At runtime* the lookup sits on the miss path only. A hit answers 301 to the Scope's current path. The
  locale prefix stays outside it, since paths are locale-neutral, so `/de/old` reaches `/de/new`. The
  target must be live -- not tombstoned, and published -- because a 301 into a 404 is worse than the 404.
- *Open:* whether the Builder shows remembered addresses anywhere. Proposed no: the invariant frees a path
  the moment somebody needs it, so there is nothing to administer.
