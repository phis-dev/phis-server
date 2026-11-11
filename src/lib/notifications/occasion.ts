import "server-only";

import type { PhisAddonOccasionDescriptor, PhisAddonOccasionLine } from "@phis/contracts/addon";

import { PHIS_SPECIAL_AREA_KEYS } from "@/lib/constants/cms-areas";
import { buildBaseUrlWithLocale } from "@/lib/email";
import { escapeHtml } from "@/lib/email-templates";
import { PHI_CANONICAL_SOURCE_LOCALE, normalizeLocale } from "@/lib/locale";
import { translateWithCache } from "@/lib/translations";

/**
 * The words of an Add-on's occasion, rendered in Core's frame.
 *
 * The Add-on wrote the sentences and the manifest digest sealed them; what happens here is Core's part
 * of the split in `design/NOTIFICATIONS.md` section 2: the salutation, the translation, the escaping,
 * the paragraphs, and the links -- a `path` parameter becomes an absolute address on the Site's own
 * public URL, so nothing an occasion carries can point a Site's mail at another host. A Public path is
 * given the recipient's language; a path into another Area is left as it is.
 *
 * Each line is translated as the unparameterised sentence and the values are put in afterwards, exactly
 * as `resolveEmailTemplate` does for Core's own templates, so a declared line translates like a Core one.
 */

/**
 * Whether a Site path lies in an Area other than Public.
 *
 * Only Public addresses name the language they are read in (`/de/shop`); the App, Admin and the other
 * Areas are served at `/app/…` for every language and take the reader's from the account. A locale put
 * in front of such a path is an address nobody serves.
 */
function isSpecialAreaPath(path: string) {
  const first = path.split(/[/?#]/).find((segment) => segment.length > 0);
  return first !== undefined && (PHIS_SPECIAL_AREA_KEYS as readonly string[]).includes(first);
}

const SALUTATION: PhisAddonOccasionLine = { text: "Hello %1,", parameters: ["recipientName"] };

type RenderedOccasion = {
  subject: string;
  bodyHtml: string;
  bodyText: string;
};

function translate(locale: string, text: string, ctx: string) {
  return locale === PHI_CANONICAL_SOURCE_LOCALE
    ? Promise.resolve(text)
    : translateWithCache({ locale, msg: text, ctx });
}

/**
 * `%1`, `%2`, … stand for the parameters in the order the manifest names them.
 *
 * Read in one pass: replacing one token after another had `%1` eat the start of `%10`, and a value that
 * itself contained `%2` replaced again by the next step. A token the manifest names no parameter for
 * stays as it is.
 */
function substitute(
  text: string,
  names: readonly string[] | undefined,
  value: (name: string) => string,
) {
  if (!names || names.length === 0) {
    return text;
  }
  return text.replace(/%(\d+)/g, (token, digits: string) => {
    const name = names[Number(digits) - 1];
    return name === undefined ? token : value(name);
  });
}

export async function renderPhiAddonOccasion(input: {
  addonId: string;
  occasion: PhisAddonOccasionDescriptor;
  params: Readonly<Record<string, unknown>>;
  locale: string;
  recipientName: string;
  publicBaseUrl: string;
}): Promise<RenderedOccasion> {
  const locale = normalizeLocale(input.locale);
  const types = new Map(input.occasion.parameters.map((parameter) => [parameter.name, parameter.type]));
  const localized = buildBaseUrlWithLocale(input.publicBaseUrl, locale);
  const unlocalized = input.publicBaseUrl.trim().replace(/\/+$/, "");
  const address = (path: string) => `${isSpecialAreaPath(path) ? unlocalized : localized}${path}`;

  const raw = (name: string) => {
    if (name === "recipientName") return input.recipientName;
    const value = input.params[name];
    return typeof value === "string" ? value : "";
  };
  // What a reader of plain text sees: the value, or for a path the whole address.
  const asText = (name: string) => (types.get(name) === "path" ? address(raw(name)) : raw(name));
  // What an HTML reader sees: the value escaped, or for a path a link to that address.
  const asHtml = (name: string) => {
    if (types.get(name) !== "path") return escapeHtml(raw(name));
    const url = escapeHtml(address(raw(name)));
    return `<a href="${url}">${url}</a>`;
  };

  const ctx = `${input.addonId} ${input.occasion.name} email`;
  const [subject, salutation, ...lines] = await Promise.all([
    translate(locale, input.occasion.subject.text, `${ctx} subject`),
    translate(locale, SALUTATION.text, "email salutation"),
    ...input.occasion.lines.map((line, index) =>
      translate(locale, line.text, `${ctx} body line ${index + 1}`),
    ),
  ]);

  const paragraphs = [
    { text: salutation, parameters: SALUTATION.parameters },
    ...input.occasion.lines.map((line, index) => ({ text: lines[index] ?? line.text, parameters: line.parameters })),
  ];

  return {
    subject: substitute(subject, input.occasion.subject.parameters, asText),
    bodyHtml: paragraphs.map((line) => `<p>${substitute(escapeHtml(line.text), line.parameters, asHtml)}</p>`).join(""),
    bodyText: paragraphs.map((line) => substitute(line.text, line.parameters, asText)).join("\n\n"),
  };
}
