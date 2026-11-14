"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import packageJson from "../../../package.json";

import {
  bootstrapLocales,
  getBootstrapLocale,
  getBootstrapMessages,
} from "@/bootstrap/i18n";
import { getBootstrapStep } from "@/bootstrap/setup-flow";
import { SetupLanguageMenu } from "@/components/bootstrap/setup-language-menu";

function subscribeToNothing() {
  return () => undefined;
}

export function SetupLayoutShell({
  children,
  closesAt,
}: {
  children: React.ReactNode;
  /** When the setup window closes (ISO), shown in the reader's own time once the page is in the browser. */
  closesAt: string | null;
}) {
  const searchParams = useSearchParams();
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const locale = getBootstrapLocale(searchParams.get("lang") ?? undefined);
  const step = getBootstrapStep(searchParams.get("step") ?? undefined);
  const messages = getBootstrapMessages(locale);
  // In the browser only: the server's clock zone is not the reader's, and the server render shows nothing.
  const inBrowser = useSyncExternalStore(subscribeToNothing, () => true, () => false);
  const closesAtText = inBrowser && closesAt
    ? new Date(closesAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : null;

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
            {closesAtText ? (
              <p className="ui_page_subtitle">{messages.windowClosesAt.replace("{time}", closesAtText)}</p>
            ) : null}
          </section>
        </div>
        {children}
      </div>
    </main>
  );
}
