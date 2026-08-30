export function normalizeSiteCmsPath(input: string | null | undefined) {
  const trimmed = (input ?? "").trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withoutLeading = trimmed.replace(/^\/+/, "");
  const withoutTrailing = withoutLeading.replace(/\/+$/, "");
  return withoutTrailing ? `/${withoutTrailing}` : "/";
}
