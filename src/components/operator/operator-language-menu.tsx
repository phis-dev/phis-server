"use client";

import { useRouter } from "next/navigation";

import { SelectMenu } from "@/components/ui/select-menu";

type OperatorLanguageMenuProps = {
  value: string;
  options: Array<{ value: string; label: string }>;
};

export function OperatorLanguageMenu({
  value,
  options,
}: OperatorLanguageMenuProps) {
  const router = useRouter();

  return (
    <SelectMenu
      label=""
      value={value}
      options={options}
      rootClassName="operator-language-menu"
      buttonClassName="operator-language-menu_button"
      onChange={(nextLocale) => {
        document.cookie = `phis_locale=${encodeURIComponent(nextLocale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
        router.refresh();
      }}
    />
  );
}
