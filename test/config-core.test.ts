import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  mergeConfig,
  resolvePhiSiteSourceLocale,
  validatePhiConfig,
} from "../src/lib/config-core.ts";

describe("Site source locale config", () => {
  it("resolves an immutable Site override before the installation fallback", () => {
    const config = mergeConfig(
      { translation: { sourceLocale: "en", supportedLocales: ["en", "de"] } },
      { sites: { overrides: { demo: { sourceLocale: "DE" } } } },
    );

    expect(resolvePhiSiteSourceLocale(config, "DEMO")).toBe("de");
    expect(resolvePhiSiteSourceLocale(config, "other")).toBe("en");
  });

  it("preserves sourceLocale while deployment fields are overridden", () => {
    const config = mergeConfig(
      { sites: { overrides: { demo: { sourceLocale: "en" } } } },
      { sites: { overrides: { demo: { instances: [{ host: "node-2" }] } } } },
    );

    expect(config.sites?.overrides?.demo).toMatchObject({
      sourceLocale: "en",
      instances: [{ host: "node-2" }],
    });
  });

  it("rejects source locales outside the supported locale set", () => {
    expect(validatePhiConfig({
      translation: { sourceLocale: "en", supportedLocales: ["en", "de"] },
      sites: { overrides: { demo: { sourceLocale: "fr" } } },
    })).toContain(
      "sites.overrides.demo.sourceLocale must be included in translation.supportedLocales.",
    );
  });
});

describe("Media installation defaults", () => {
  it("configures capacity only, never availability", () => {
    expect(DEFAULT_CONFIG.media?.defaults).toEqual({ userQuotaBytes: null, groupQuotaBytes: null });
  });

  it("accepts null quotas and rejects negative or fractional ones", () => {
    expect(validatePhiConfig({ media: { defaults: { userQuotaBytes: null, groupQuotaBytes: 1024 } } }))
      .toEqual([]);
    expect(validatePhiConfig({ media: { defaults: { userQuotaBytes: -1 } } }))
      .toContain("media.defaults.userQuotaBytes must be null or a non-negative integer.");
    expect(validatePhiConfig({ media: { defaults: { groupQuotaBytes: 1.5 } } }))
      .toContain("media.defaults.groupQuotaBytes must be null or a non-negative integer.");
  });

  it("merges the defaults per key instead of replacing the block", () => {
    const merged = mergeConfig(
      { media: { defaults: { groupQuotaBytes: 5, userQuotaBytes: 10 } } },
      { media: { defaults: { userQuotaBytes: 20 } } },
    );
    expect(merged.media?.defaults).toEqual({ groupQuotaBytes: 5, userQuotaBytes: 20 });
  });
});
