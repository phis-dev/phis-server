export type TranslationContextFlag = "html" | "extern";

const TRANSLATION_CONTEXT_FLAG_ORDER = ["html", "extern"] as const satisfies readonly TranslationContextFlag[];
const TRANSLATION_CONTEXT_FLAG_SET = new Set<string>(TRANSLATION_CONTEXT_FLAG_ORDER);

export type ParsedTranslationContext = {
  flags: TranslationContextFlag[];
  providerContext: string;
};

export function parseTranslationContext(input?: string | null): ParsedTranslationContext {
  const context = input?.trim() ?? "";
  if (!context.startsWith("[")) {
    return { flags: [], providerContext: context };
  }

  const closingIndex = context.indexOf("]");
  if (closingIndex < 1) {
    throw new Error("Invalid translation context flag envelope.");
  }

  const rawFlags = context.slice(1, closingIndex).split(":").filter(Boolean);
  if (rawFlags.length === 0 || rawFlags.some((flag) => !TRANSLATION_CONTEXT_FLAG_SET.has(flag))) {
    throw new Error("Unknown translation context flag.");
  }

  const flags = TRANSLATION_CONTEXT_FLAG_ORDER.filter((flag) => rawFlags.includes(flag));
  if (rawFlags.length !== new Set(rawFlags).size) {
    throw new Error("Duplicate translation context flag.");
  }

  return {
    flags: [...flags],
    providerContext: context.slice(closingIndex + 1).trim(),
  };
}

export function buildTranslationContext(input: {
  context?: string | null;
  flags?: readonly TranslationContextFlag[];
}) {
  const parsed = parseTranslationContext(input.context);
  const requestedFlags = input.flags ?? [];
  if (requestedFlags.some((flag) => !TRANSLATION_CONTEXT_FLAG_SET.has(flag))) {
    throw new Error("Unknown translation context flag.");
  }

  const flags = TRANSLATION_CONTEXT_FLAG_ORDER.filter(
    (flag) => parsed.flags.includes(flag) || requestedFlags.includes(flag),
  );
  const envelope = flags.length > 0 ? `[${flags.join(":")}]` : "";
  const context = `${envelope}${parsed.providerContext}`;
  if (context.length > 128) {
    throw new Error("Translation context exceeds 128 characters.");
  }

  return context;
}

export function getProviderTranslationContext(input?: string | null) {
  return parseTranslationContext(input).providerContext || undefined;
}

export function hasTranslationContextFlag(
  input: string | null | undefined,
  flag: TranslationContextFlag,
) {
  return parseTranslationContext(input).flags.includes(flag);
}
