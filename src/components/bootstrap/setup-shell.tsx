import type { ReactNode } from "react";

import type { BootstrapLocale, BootstrapMessages } from "@/bootstrap/i18n";
import { getBootstrapMessages } from "@/bootstrap/i18n";
import {
  bootstrapStepOrder,
  type BootstrapStepKey,
} from "@/bootstrap/setup-flow";
import { VerticalSteps } from "@/components/ui/vertical-steps";

function buildStepHref(locale: BootstrapLocale, step: BootstrapStepKey) {
  return `/setup?lang=${locale}&step=${step}`;
}

export function SetupShell({
  locale,
  currentStep,
  children,
}: {
  locale: BootstrapLocale;
  currentStep: BootstrapStepKey;
  children: ReactNode;
}) {
  const messages = getBootstrapMessages(locale);
  const currentIndex = bootstrapStepOrder.indexOf(currentStep);
  const currentStepContent = messages.steps[currentStep];

  const items = bootstrapStepOrder.map((step, index) => {
    const status: "complete" | "current" | "upcoming" =
      index < currentIndex
        ? "complete"
        : index === currentIndex
          ? "current"
          : "upcoming";
    const statusLabel =
      status === "complete"
        ? messages.statusComplete
        : status === "current"
          ? messages.statusCurrent
          : messages.statusUpcoming;

    return {
      key: step,
      index: index + 1,
      title: messages.steps[step].title,
      summary: messages.steps[step].summary,
      status,
      statusLabel,
      href: status === "complete" ? buildStepHref(locale, step) : undefined,
    };
  });

  return (
    <section className="ui_split_layout">
      <aside className="ui_split_sidebar">
        <div className="ui_split_sidebar_sticky">
          <div className="ui_card">
            <div className="ui_section_header">
              <p className="ui_section_eyebrow">{messages.stepLabel}</p>
              <h2 className="ui_section_title">{messages.steps[currentStep].title}</h2>
            </div>
            <VerticalSteps label={messages.title} items={items} />
          </div>
        </div>
      </aside>

      <section className="ui_split_main">
        <div className="ui_card">
          <div className="ui_section_header">
            <p className="ui_section_eyebrow">
              {messages.stepLabel} {currentIndex + 1}
            </p>
            <h2 className="ui_section_title">{currentStepContent.title}</h2>
            <p className="ui_section_lead">{currentStepContent.description}</p>
          </div>
          {children}
        </div>
      </section>
    </section>
  );
}

export function SetupChecklist({
  messages,
  step,
}: {
  messages: BootstrapMessages;
  step: BootstrapStepKey;
}) {
  return (
    <div className="ui_section_stack">
      <section className="ui_card">
        <ul className="ui_list">
          {messages.steps[step].actions.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
      <SetupGoodToKnow messages={messages} step={step} />
    </div>
  );
}

export function SetupGoodToKnow({
  messages,
  step,
}: {
  messages: BootstrapMessages;
  step: BootstrapStepKey;
}) {
  return (
    <section className="ui_card ui_card_accent">
      <p className="ui_section_eyebrow">{messages.continueLabel}</p>
      <p className="ui_section_title">
        {messages.steps[step].goodToKnowTitle ??
          (step === "finish"
            ? messages.steps.finish.summary
            : messages.steps[bootstrapStepOrder[bootstrapStepOrder.indexOf(step) + 1]].title)}
      </p>
      {messages.steps[step].goodToKnowBodyBeforeLink ||
      messages.steps[step].goodToKnowLinkHref ||
      messages.steps[step].goodToKnowBodyAfterLink ? (
        <p className="ui_section_body">
          {messages.steps[step].goodToKnowBodyBeforeLink}
          {messages.steps[step].goodToKnowLinkHref && messages.steps[step].goodToKnowLinkLabel ? (
            <a
              className="ui_text_link"
              href={messages.steps[step].goodToKnowLinkHref}
              target="_blank"
              rel="noreferrer noopener"
            >
              {messages.steps[step].goodToKnowLinkLabel}
            </a>
          ) : null}
          {messages.steps[step].goodToKnowBodyAfterLink}
        </p>
      ) : null}
    </section>
  );
}
