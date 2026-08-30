"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import packageJson from "../../../package.json";

import {
  bootstrapLocales,
  getBootstrapLocale,
  getBootstrapMessages,
} from "@/bootstrap/i18n";
import { getBootstrapStep } from "@/bootstrap/setup-flow";
import { SetupLanguageMenu } from "@/components/bootstrap/setup-language-menu";

export function SetupLayoutShell({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const locale = getBootstrapLocale(searchParams.get("lang") ?? undefined);
  const step = getBootstrapStep(searchParams.get("step") ?? undefined);
  const messages = getBootstrapMessages(locale);

  useEffect(() => {
    const element = headerRef.current;

    if (!element) {
      return;
    }

    const updateHeight = () => {
      setHeaderHeight(element.getBoundingClientRect().height);
    };

    updateHeight();

    const observer = new ResizeObserver(() => {
      updateHeight();
    });

    observer.observe(element);
    window.addEventListener("resize", updateHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  return (
    <main className="ui_shell ui_shell--setup">
      <div
        className="ui_shell_content"
        style={{ paddingTop: headerHeight > 0 ? `${headerHeight + 21}px` : undefined }}
      >
        <div className="ui_shell_fixed_header" ref={headerRef}>
          <section className="ui_hero ui_hero--sticky">
            <div className="ui_hero_meta">
              <div className="ui_hero_heading">
                <p className="ui_page_eyebrow">{messages.introEyebrow}</p>
                <div className="ui_title_row">
                  <h1 className="ui_display_title">{messages.title}</h1>
                  <span className="ui_version">v{packageJson.version}</span>
                </div>
              </div>
              <SetupLanguageMenu
                locale={locale}
                currentStep={step}
                options={bootstrapLocales.map((entry) => {
                  const entryMessages = getBootstrapMessages(entry);

                  return {
                    value: entry,
                    label: entryMessages.languages[entry],
                  };
                })}
              />
            </div>
            <p className="ui_page_subtitle">{messages.subtitle}</p>
          </section>
        </div>
        {children}
      </div>
    </main>
  );
}
