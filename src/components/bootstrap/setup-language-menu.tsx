"use client";

import { useRouter } from "next/navigation";

import type { BootstrapLocale } from "@/bootstrap/i18n";
import { SelectMenu } from "@/components/ui/select-menu";

export function SetupLanguageMenu({
  locale,
  currentStep,
  options,
}: {
  locale: BootstrapLocale;
  currentStep: string;
  options: Array<{ value: BootstrapLocale; label: string }>;
}) {
  const router = useRouter();

  return (
    <SelectMenu
      label=""
      value={locale}
      options={options}
      onChange={(nextLocale) => {
        document.cookie = `phis_locale=${encodeURIComponent(nextLocale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
        router.push(`/setup?lang=${nextLocale}&step=${currentStep}`);
      }}
    />
  );
}
