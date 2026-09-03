import { describe, expect, it } from "vitest";

import { parsePhisAddonSettingValue } from "@/db/server-addon-settings.mts";

/**
 * What an operator may type, checked where they type it.
 *
 * A setting that does not parse is refused at the prompt rather than stored and later read back as its
 * default -- which would look like configuration nobody had done.
 */
describe("reading an operator's value against the declared type", () => {
  it("takes text as it stands", () => {
    expect(parsePhisAddonSettingValue({ name: "n", type: "text" }, " keep me "))
      .toEqual({ value: " keep me " });
  });

  it("takes an integer and nothing that merely starts like one", () => {
    expect(parsePhisAddonSettingValue({ name: "n", type: "integer" }, "12"))
      .toEqual({ value: 12 });
    // `parseInt` would have read this as 12, which is how a typo becomes a stored value.
    expect(parsePhisAddonSettingValue({ name: "n", type: "integer" }, "12x"))
      .toEqual({ error: '"12x" is not an integer.' });
    expect(parsePhisAddonSettingValue({ name: "n", type: "integer" }, "1.5"))
      .toHaveProperty("error");
  });

  it("takes the words an operator actually types for a switch", () => {
    for (const raw of ["true", "1", "yes", "ON"]) {
      expect(parsePhisAddonSettingValue({ name: "n", type: "boolean" }, raw))
        .toEqual({ value: true });
    }
    for (const raw of ["false", "0", "no", "Off"]) {
      expect(parsePhisAddonSettingValue({ name: "n", type: "boolean" }, raw))
        .toEqual({ value: false });
    }
    expect(parsePhisAddonSettingValue({ name: "n", type: "boolean" }, "maybe"))
      .toHaveProperty("error");
  });
});
