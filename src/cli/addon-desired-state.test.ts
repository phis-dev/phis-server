import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { forgetAddon, readAddonDesiredState, readAddonDesiredStateForChange } from "./addons.mts";

/**
 * What `config/phis-addons.json` means when it is not there.
 *
 * It used to mean a fault: every `addon` command refused until somebody created the file by hand, and
 * the installation docs said so. That made deployment state something a checkout had to carry, which
 * put it under version control -- and then every install showed up in the history as a source change.
 *
 * Absence is an empty state instead, the rule `modules.mts` already had for the Module half. The file
 * is what the CLI writes, not what a repository ships.
 */
describe("the Add-on desired state when the file is absent", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function phiRoot() {
    const root = await mkdtemp(path.join(tmpdir(), "phis-addons-"));
    roots.push(root);
    await mkdir(path.join(root, "config"), { recursive: true });
    return root;
  }

  it("reads as no Add-ons installed", async () => {
    const root = await phiRoot();
    expect(readAddonDesiredState(root)).toEqual({ formatVersion: 1, addons: [] });
  });

  it("reads as an empty state with nothing to recover, for the commands that change it", async () => {
    const root = await phiRoot();
    expect(readAddonDesiredStateForChange(root)).toEqual({
      state: { formatVersion: 1, addons: [] },
      invalid: [],
    });
  });

  /*
   * A shared literal would let one caller's edit reach the next reader, and the empty state is exactly
   * the value every fresh root gets -- so it is the one most likely to be handed around and appended to.
   */
  it("hands out a fresh state each time rather than one shared object", async () => {
    const root = await phiRoot();
    const first = readAddonDesiredState(root);
    first.addons.push({ addonId: "@acme/ghost" } as (typeof first.addons)[number]);
    expect(readAddonDesiredState(root).addons).toEqual([]);
  });

  /* Absence is no entry, and "no entry" is what `forget` already had the words for. */
  it("lets forget say the Add-on is not in the state, not that the file is missing", async () => {
    const root = await phiRoot();
    expect(() => forgetAddon(root, new Map([["addon", "@acme/ghost"]]))).toThrow(
      /is not in the desired state/u,
    );
  });

  /* The empty file and no file must not disagree, or a fresh root behaves by whether somebody made one. */
  it("agrees with an empty file that is present", async () => {
    const root = await phiRoot();
    await writeFile(
      path.join(root, "config", "phis-addons.json"),
      '{\n  "formatVersion": 1,\n  "addons": []\n}\n',
    );
    expect(readAddonDesiredState(root)).toEqual({ formatVersion: 1, addons: [] });
    expect(readAddonDesiredStateForChange(root)).toEqual({
      state: { formatVersion: 1, addons: [] },
      invalid: [],
    });
  });
});
