import sanitizeHtml from "sanitize-html";

import { classifyPhiReferenceAttribute } from "@/lib/internal-references";

const PHI_SAFE_HTML_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "u",
  "ul",
] as const;

const PHI_SAFE_HTML_ATTRIBUTES = {
  "*": ["style"],
  a: ["href", "rel", "target", "title", "style"],
};

const PHI_SAFE_HTML_IMG_ATTRIBUTES = ["src", "alt", "title", "width", "height", "style"];

const PHI_SAFE_HTML_SCHEMES = ["http", "https", "mailto", "tel"];
const PHI_SAFE_HTML_COLOR_STYLES = [
  /^#[0-9a-fA-F]{3,8}$/,
  /^rgb(a)?\((?:[^()]|\([^()]*\))*\)$/,
  /^hsl(a)?\((?:[^()]|\([^()]*\))*\)$/,
];
const PHI_SAFE_HTML_TEXT_ALIGN_STYLES = [/^(left|center|right|justify)$/];
/**
 * An image sizes itself either through its `width`/`height` attributes, which take bare pixels, or --
 * for the relative widths editorial layouts rely on -- through inline style. Only `img` may carry
 * these, and only as a bounded length: no function, no keyword, nothing that could reach outside the
 * element's own box.
 */
const PHI_SAFE_HTML_IMAGE_LENGTH_STYLES = [/^\d{1,5}(?:\.\d{1,4})?(?:px|%|em|rem|vw|vh)$/];
const PHI_SAFE_HTML_TRAILING_EMPTY_BLOCKS =
  /(?:<(p|blockquote|pre)(?:\s[^>]*)?>\s*(?:<br\s*\/?>|&nbsp;|\u00a0|\s)*<\/\1>\s*)+$/gi;

/**
 * Validates the grammar of one reference-carrying attribute inside the trusted internal content
 * channel. A canonical `phis:page/<reference>` or `phis:asset/<id>` value survives unchanged; anything
 * that only resolves to a `phis:` scheme through encoding tricks loses the attribute. External values
 * are left to the ordinary scheme allowlist.
 */
function sanitizePhiReferenceAttribute(
  tagName: string,
  attribs: sanitizeHtml.Attributes,
  attribute: "href" | "src",
): sanitizeHtml.Tag {
  const value = attribs[attribute];
  if (typeof value !== "string") {
    return { tagName, attribs };
  }

  const classified = classifyPhiReferenceAttribute(value);
  if (classified.kind === "external") {
    return { tagName, attribs };
  }
  if (classified.kind === "internal") {
    return { tagName, attribs: { ...attribs, [attribute]: classified.uri } };
  }

  const remaining = { ...attribs };
  delete remaining[attribute];
  return { tagName, attribs: remaining };
}

/**
 * Authoritative sanitizer for persisted CMS HTML.
 *
 * `allowInternalReferences` selects the declared internal content channel defined by `REFERENCES.md`.
 * Only that channel may carry `phis:page/` and `phis:asset/` URIs, and only it renders `img`, because
 * an Asset reference is expressed as an image source. Every other caller keeps the narrow
 * external-only surface.
 */
export function sanitizePhiPersistedHtml(
  value: string | null | undefined,
  options?: { allowInternalReferences?: boolean },
) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }

  const allowInternalReferences = options?.allowInternalReferences === true;

  return sanitizeHtml(value, {
    allowedTags: [...PHI_SAFE_HTML_TAGS, ...(allowInternalReferences ? ["img"] : [])],
    allowedAttributes: {
      ...PHI_SAFE_HTML_ATTRIBUTES,
      ...(allowInternalReferences ? { img: PHI_SAFE_HTML_IMG_ATTRIBUTES } : {}),
    },
    allowedStyles: {
      "*": {
        color: PHI_SAFE_HTML_COLOR_STYLES,
        "text-align": PHI_SAFE_HTML_TEXT_ALIGN_STYLES,
      },
      img: {
        width: PHI_SAFE_HTML_IMAGE_LENGTH_STYLES,
        height: PHI_SAFE_HTML_IMAGE_LENGTH_STYLES,
      },
    },
    allowedSchemes: [...PHI_SAFE_HTML_SCHEMES, ...(allowInternalReferences ? ["phis"] : [])],
    ...(allowInternalReferences
      ? {
          transformTags: {
            a: (tagName, attribs) => sanitizePhiReferenceAttribute(tagName, attribs, "href"),
            img: (tagName, attribs) => sanitizePhiReferenceAttribute(tagName, attribs, "src"),
          },
        }
      : {}),
    disallowedTagsMode: "discard",
    parseStyleAttributes: true,
  })
    .replace(PHI_SAFE_HTML_TRAILING_EMPTY_BLOCKS, "")
    .trim();
}
