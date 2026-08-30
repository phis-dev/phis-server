"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { BootstrapMessages } from "@/bootstrap/i18n";
import {
  runtimeCheckOrder,
  type RuntimeCheckKey,
} from "@/bootstrap/runtime-checks";
import { Button } from "@/components/ui/button";

type RuntimeCheckState = {
  status: "idle" | "running" | "verified" | "warning" | "failed";
  detail?: string;
};

type RuntimeCheckResponse = {
  checkId: RuntimeCheckKey;
  status: "verified" | "warning" | "failed";
  detail: string;
};

export function RuntimeCheckRunner({
  messages,
  nextStepHref,
}: {
  messages: BootstrapMessages;
  nextStepHref: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [checks, setChecks] = useState<Record<RuntimeCheckKey, RuntimeCheckState>>(
    () =>
      Object.fromEntries(
        runtimeCheckOrder.map((checkId) => [checkId, { status: "idle" }]),
      ) as Record<RuntimeCheckKey, RuntimeCheckState>,
  );

  function runChecks() {
    startTransition(async () => {
      setChecks(
        Object.fromEntries(
          runtimeCheckOrder.map((checkId) => [checkId, { status: "idle" }]),
        ) as Record<RuntimeCheckKey, RuntimeCheckState>,
      );

      for (const checkId of runtimeCheckOrder) {
        setChecks((current) => ({
          ...current,
          [checkId]: {
            ...current[checkId],
            status: "running",
          },
        }));

        const response = await fetch("/api/setup/runtime-check", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ checkId }),
        });

        const payload = (await response.json()) as RuntimeCheckResponse;

        setChecks((current) => ({
          ...current,
          [checkId]: {
            status: payload.status,
            detail: payload.detail,
          },
        }));
      }
    });
  }

  const hasStarted = runtimeCheckOrder.some((checkId) => checks[checkId].status !== "idle");
  const hasFailed = runtimeCheckOrder.some((checkId) => checks[checkId].status === "failed");
  const isComplete = runtimeCheckOrder.every((checkId) => {
    const status = checks[checkId].status;
    return status !== "idle" && status !== "running";
  });
  const canContinue = hasStarted && isComplete && !hasFailed && !isPending;
  const runLabel = hasStarted
    ? messages.runtimeCheckRerunLabel
    : messages.runtimeCheckRunLabel;

  return (
    <section className="ui_card">
      <div className="ui_status_checks_header">
        <Button
          type="button"
          variant="secondary"
          onClick={runChecks}
          disabled={isPending}
        >
          {isPending ? messages.runtimeCheckRunningLabel : runLabel}
        </Button>
      </div>

      <ol className="ui_status_checks" aria-live="polite">
        {runtimeCheckOrder.map((checkId) => {
          const state = checks[checkId];
          const copy = messages.runtimeChecks[checkId];
          const status =
            state.status === "idle" ? "idle" : state.status === "running" ? "running" : state.status;

          return (
            <li
              key={checkId}
              className="ui_status_check"
              data-status={status}
            >
              <span className="ui_status_check_icon" aria-hidden="true">
                {status === "verified"
                  ? "✓"
                  : status === "warning"
                    ? "!"
                  : status === "failed"
                    ? "×"
                    : status === "running"
                      ? "…"
                      : "·"}
              </span>
              <div className="ui_status_check_body">
                <div className="ui_status_check_title_row">
                  <p className="ui_status_check_title">{copy.title}</p>
                  <span className="ui_status_check_status">
                    {status === "verified"
                      ? messages.runtimeCheckVerifiedLabel
                      : status === "warning"
                        ? messages.runtimeCheckWarningLabel
                      : status === "failed"
                        ? messages.runtimeCheckFailedLabel
                        : status === "running"
                          ? messages.runtimeCheckRunningLabel
                          : ""}
                  </span>
                </div>
                <p className="ui_status_check_description">{copy.description}</p>
                {state.detail ? (
                  <p className="ui_status_check_detail">{state.detail}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="ui_status_checks_footer">
        <Button
          type="button"
          variant="primary"
          onClick={() => router.push(nextStepHref)}
          disabled={!canContinue}
        >
          {messages.runtimeCheckContinueLabel}
        </Button>
      </div>
    </section>
  );
}
