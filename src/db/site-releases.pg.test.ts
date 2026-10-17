import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  withPhiTestClient,
  type PhiTestSite,
} from "../../test/pg/harness";
import { createPhiDraftCmsInstanceId } from "@/lib/cms/instance-id";
import { saveSiteContentEntryDraft, submitSiteContentEntry } from "./site-content-entries";
import { listSiteReleases } from "./site-releases";
import { submitSiteWidgetContent, writeSiteWidgetContentWithClient } from "./site-widget-content";

/** The Publisher's queue: what was submitted, and nothing that was merely saved (CONTENT.md, Submission). */
describe("the Publisher's queue against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("releases");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function writeText(instanceId: string, value: string) {
    return withPhiTestClient(async (client) => {
      await client.query("BEGIN");
      const result = await writeSiteWidgetContentWithClient(client, {
        siteId: site.id,
        instanceId,
        storage: "text",
        value,
        baseVersionId: null,
        slug: `pgtest-${instanceId}`,
        referenceAreaId: 1,
        place: { scope: "page", area: "public", path: "/about", ownerModuleId: null, presetKey: null },
      });
      await client.query("COMMIT");
      return result;
    });
  }

  it("lists submitted content with where it is shown, and leaves saved-only content out", async () => {
    const submitted = createPhiDraftCmsInstanceId({ domain: "page", draftRevisionId: 9, sequence: 1 });
    const saved = createPhiDraftCmsInstanceId({ domain: "page", draftRevisionId: 9, sequence: 2 });
    const first = await writeText(submitted, "Über uns, neu geschrieben");
    await writeText(saved, "Nur gespeichert");
    await submitSiteWidgetContent({ siteId: site.id, contentId: first.contentId, versionId: first.versionId });

    const entry = await saveSiteContentEntryDraft({
      kind: "news", siteId: site.id, slug: "queued", title: "Queued entry", content: "Body.",
    });
    if (!entry.ok) throw new Error("save failed");
    await submitSiteContentEntry({ kind: "news", siteId: site.id, contentId: entry.contentId, versionId: entry.versionId });

    const items = await listSiteReleases(site.id);
    const content = items.filter((item) => item.kind === "content");
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      instanceId: submitted,
      storage: "text",
      submittedVersionId: first.versionId,
      preview: "Über uns, neu geschrieben",
      place: { scope: "page", area: "public", path: "/about" },
    });
    expect(items.find((item) => item.kind === "entry")).toMatchObject({
      entryKind: "news",
      contentId: entry.contentId,
      title: "Queued entry",
    });
  });
});
