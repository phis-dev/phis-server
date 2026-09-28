/**
 * The configuration as an operator may see it in a browser: its shape and its settings, none of its
 * secrets.
 *
 * The Infrastructure panel hands the text to a client component, so whatever it holds reaches the page,
 * the RSC payload and every cache in between. A secret is recognised by the key it sits under -- tokens,
 * secrets, passwords, hashes, API and encryption keys -- and a URI anywhere keeps its host and user but
 * loses its password, which is what the database URIs and SMTP targets carry. A reference that only
 * names a secret (`secretReference`) is not one and stays readable.
 */

export const REDACTED_CONFIG_VALUE = "[redacted]";

const SECRET_KEY = /(token|secret|password|hash|apikey|encryptionkey)$/i;
const URI_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]*):[^@/?#\s]*@/i;

function redactValue(key: string | null, value: unknown): unknown {
  if (typeof value === "string") {
    if (key !== null && SECRET_KEY.test(key)) {
      return value ? REDACTED_CONFIG_VALUE : value;
    }
    return value.replace(URI_CREDENTIALS, "$1:***@");
  }
  if (Array.isArray(value)) {
    // An entry inherits the key of its array: `targets` holds URIs, a list of tokens stays tokens.
    return value.map((entry) => redactValue(key, entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [entryKey, redactValue(entryKey, entry)]),
    );
  }
  return value;
}

/**
 * Redacts a configuration file's text. Text that is not JSON is not shown at all: nothing here could
 * tell which part of it is a secret.
 */
export function redactConfigText(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "/* The file is not valid JSON, so it is not shown: its secrets could not be told apart. */";
  }
  return JSON.stringify(redactValue(null, parsed), null, 2);
}
