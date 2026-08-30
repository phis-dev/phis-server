"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import packageJson from "../../../package.json";

import { OperatorLanguageMenu } from "@/components/operator/operator-language-menu";
import { OperatorLogoutButton } from "@/components/operator/operator-logout-button";
import { OperatorSessionRefresher } from "@/components/operator/operator-session-refresher";

type OperatorShellFrameProps = {
  operatorName: string;
  operationalMode: string;
  logoutLabel: string;
  currentLocale: string;
  localeOptions: Array<{ value: string; label: string }>;
  navLabels: {
    overview: string;
    sites: string;
    translations: string;
    operators: string;
    infrastructure: string;
  };
  children: ReactNode;
};

const SECTION_ORDER = [
  "overview",
  "sites",
  "translations",
  "operators",
  "infrastructure",
] as const;

export function OperatorShellFrame({
  operatorName,
  operationalMode,
  logoutLabel,
  currentLocale,
  localeOptions,
  navLabels,
  children,
}: OperatorShellFrameProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (pathname === "/operator/login") {
    return (
      <>
        <OperatorSessionRefresher />
        {children}
      </>
    );
  }

  const currentSection = searchParams.get("section") ?? "overview";

  return (
    <>
      <OperatorSessionRefresher />
      <div className="operator-shell">
        <header className="operator-header">
          <div className="operator-header_brand">
            <div className="operator-header_title-row">
              <h1 className="operator-header_title">phis operator</h1>
              <span className="ui_version">v{packageJson.version}</span>
              <span className="operator-header_mode">{operationalMode}</span>
            </div>
          </div>

          <div className="operator-header_tools">
            <OperatorLanguageMenu
              value={currentLocale}
              options={localeOptions}
            />
            <span className="ui_control ui_control_pill operator-header_operator">{operatorName}</span>
            <OperatorLogoutButton label={logoutLabel} />
          </div>
        </header>

        <div className="operator-shell_grid">
          <aside className="operator-sidebar">
            <nav className="operator-nav" aria-label="Operator navigation">
              {SECTION_ORDER.map((section) => {
                const selected = currentSection === section;
                const label = navLabels[section];

                return (
                  <Link
                    key={section}
                    href={section === "overview" ? "/operator" : `/operator?section=${section}`}
                    className="operator-nav_link"
                    data-current={selected ? "true" : "false"}
                  >
                    <span>{label}</span>
                  </Link>
                );
              })}
            </nav>
          </aside>

          <section className="operator-main">{children}</section>
        </div>
      </div>
    </>
  );
}
