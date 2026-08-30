import { afterEach, describe, expect, it } from "vitest";

import { register } from "./instrumentation";

const VALID_KEY = "5lgTC2J/WHPz+1sxVDxm7lqc/OPPKcr/TeVYyX6xZB4=";
const TOUCHED = ["NEXT_RUNTIME", "NODE_ENV", "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY"] as const;

// NODE_ENV is typed read-only, so the tests reach the environment through a mutable view of it.
const env = process.env as Record<string, string | undefined>;
const original = new Map(TOUCHED.map((key) => [key, env[key]]));

function setEnv(values: Partial<Record<(typeof TOUCHED)[number], string>>) {
  for (const key of TOUCHED) {
    delete env[key];
  }
  Object.assign(env, values);
}

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
});

describe("register", () => {
  it("refuses to start in production without a Server Actions key", async () => {
    setEnv({ NEXT_RUNTIME: "nodejs", NODE_ENV: "production" });
    await expect(register()).rejects.toThrow("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is not set");
  });

  it("accepts base64 of 32 bytes", async () => {
    setEnv({
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "production",
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: VALID_KEY,
    });
    await expect(register()).resolves.toBeUndefined();
  });

  it("refuses a key of the wrong length", async () => {
    setEnv({
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "production",
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "Irwk7FifZ3yjrlw6acFQEw==",
    });
    await expect(register()).rejects.toThrow("must decode to 32 bytes, not 16");
  });

  it("refuses a value that is not base64", async () => {
    setEnv({
      NEXT_RUNTIME: "nodejs",
      NODE_ENV: "production",
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "!!!!",
    });
    await expect(register()).rejects.toThrow("is not valid base64");
  });

  it("leaves development alone, where every build makes its own key", async () => {
    setEnv({ NEXT_RUNTIME: "nodejs", NODE_ENV: "development" });
    await expect(register()).resolves.toBeUndefined();
  });

  it("does not run outside the Node runtime, which never decrypts an action", async () => {
    setEnv({ NEXT_RUNTIME: "edge", NODE_ENV: "production" });
    await expect(register()).resolves.toBeUndefined();
  });
});
