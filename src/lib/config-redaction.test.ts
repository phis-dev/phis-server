import { describe, expect, it } from "vitest";

import { REDACTED_CONFIG_VALUE, redactConfigText } from "./config-redaction";

describe("redactConfigText", () => {
  it("hides every secret the runtime config carries and keeps the settings around them", () => {
    const redacted = JSON.parse(redactConfigText(JSON.stringify({
      platformSuperUsers: [{ email: "op@example.test", passwordHash: "$argon2id$v=19$abc", enabled: true }],
      database: {
        uri: "postgres://phis:hunter2@db.internal:5432/phis",
        migrationUri: "postgres://owner:s3cret@db.internal/phis",
      },
      api: { publicToken: "pub", internalToken: "int", disableRateLimit: false },
      deepl: { apiKey: "deepl-key", apiUrl: "https://api.deepl.com" },
      registration: { intentEncryptionKey: "k1" },
      auth: { transactionEncryptionKey: "k2" },
      operator: { sessionSecret: "k3" },
      secrets: { encryptionKey: "k4", encryptionKeyVersion: 2 },
      email: { smtp: { targets: ["smtp://mailer:pw@mail.internal:587", "smtp://mail2.internal"] } },
      translation: { secretReference: "addon:@scope/name:api-key", providerKey: "deepl" },
      media: { storageKeyPrefix: "sites" },
    })));

    expect(redacted.platformSuperUsers[0]).toEqual({
      email: "op@example.test", passwordHash: REDACTED_CONFIG_VALUE, enabled: true,
    });
    expect(redacted.database).toEqual({
      uri: "postgres://phis:***@db.internal:5432/phis",
      migrationUri: "postgres://owner:***@db.internal/phis",
    });
    expect(redacted.api).toEqual({
      publicToken: REDACTED_CONFIG_VALUE, internalToken: REDACTED_CONFIG_VALUE, disableRateLimit: false,
    });
    expect(redacted.deepl).toEqual({ apiKey: REDACTED_CONFIG_VALUE, apiUrl: "https://api.deepl.com" });
    expect(redacted.registration.intentEncryptionKey).toBe(REDACTED_CONFIG_VALUE);
    expect(redacted.auth.transactionEncryptionKey).toBe(REDACTED_CONFIG_VALUE);
    expect(redacted.operator.sessionSecret).toBe(REDACTED_CONFIG_VALUE);
    expect(redacted.secrets).toEqual({ encryptionKey: REDACTED_CONFIG_VALUE, encryptionKeyVersion: 2 });
    expect(redacted.email.smtp.targets).toEqual(["smtp://mailer:***@mail.internal:587", "smtp://mail2.internal"]);
    // Names of secrets and ordinary keys are settings, not secrets.
    expect(redacted.translation).toEqual({ secretReference: "addon:@scope/name:api-key", providerKey: "deepl" });
    expect(redacted.media).toEqual({ storageKeyPrefix: "sites" });
  });

  it("shows nothing of a file it cannot parse", () => {
    const text = redactConfigText('{ "database": { "uri": "postgres://phis:hunter2@db" ');
    expect(text).not.toContain("hunter2");
    expect(text.startsWith("/*")).toBe(true);
  });
});
