"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

type OperatorInfrastructurePanelProps = {
  labels: {
    title: string;
    intro: string;
    runtimeTitle: string;
    pathsTitle: string;
    configFilesTitle: string;
    staticConfigTitle: string;
    runtimeConfigTitle: string;
    appRoot: string;
    workingDirectory: string;
    nodeEnv: string;
    processId: string;
    user: string;
    staticConfigPath: string;
    runtimeConfigPath: string;
    readable: string;
    writable: string;
    yes: string;
    no: string;
    viewConfig: string;
    close: string;
    staticConfigNote: string;
    runtimeConfigNote: string;
  };
  snapshot: {
    appRoot: string;
    workingDirectory: string;
    nodeEnv: string;
    processId: number;
    userName: string;
    staticConfigPath: string;
    staticConfigReadable: boolean;
    staticConfigContent: string;
    runtimeConfigPath: string;
    runtimeConfigReadable: boolean;
    runtimeConfigWritable: boolean;
    runtimeConfigContent: string;
  };
};

type OpenDialog = "static" | "runtime" | null;

export function OperatorInfrastructurePanel({
  labels,
  snapshot,
}: OperatorInfrastructurePanelProps) {
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);

  const dialogTitle =
    openDialog === "static" ? labels.staticConfigTitle : labels.runtimeConfigTitle;
  const dialogContent =
    openDialog === "static" ? snapshot.staticConfigContent : snapshot.runtimeConfigContent;
  const dialogSubtitle =
    openDialog === "static" ? snapshot.staticConfigPath : snapshot.runtimeConfigPath;

  return (
    <div className="operator-overview">
      <section className="ui_card">
        <p className="ui_section_title">{labels.title}</p>
        <p className="ui_section_body">{labels.intro}</p>
      </section>

      <section className="ui_card">
        <p className="ui_section_eyebrow">{labels.runtimeTitle}</p>
        <ul className="ui_list">
          <li>
            <strong>{labels.appRoot}:</strong> {snapshot.appRoot}
          </li>
          <li>
            <strong>{labels.workingDirectory}:</strong> {snapshot.workingDirectory}
          </li>
          <li>
            <strong>{labels.nodeEnv}:</strong> {snapshot.nodeEnv}
          </li>
          <li>
            <strong>{labels.processId}:</strong> {snapshot.processId}
          </li>
          <li>
            <strong>{labels.user}:</strong> {snapshot.userName}
          </li>
        </ul>
      </section>

      <section className="ui_card">
        <p className="ui_section_eyebrow">{labels.pathsTitle}</p>
        <ul className="ui_list">
          <li>
            <strong>{labels.staticConfigPath}:</strong> {snapshot.staticConfigPath}
            <br />
            <strong>{labels.readable}:</strong> {snapshot.staticConfigReadable ? labels.yes : labels.no}
          </li>
          <li>
            <strong>{labels.runtimeConfigPath}:</strong> {snapshot.runtimeConfigPath}
            <br />
            <strong>{labels.readable}:</strong> {snapshot.runtimeConfigReadable ? labels.yes : labels.no}
            {" · "}
            <strong>{labels.writable}:</strong> {snapshot.runtimeConfigWritable ? labels.yes : labels.no}
          </li>
        </ul>
        <p className="ui_section_body">{labels.staticConfigNote}</p>
        <p className="ui_section_body">{labels.runtimeConfigNote}</p>
      </section>

      <section className="ui_card">
        <p className="ui_section_eyebrow">{labels.configFilesTitle}</p>
        <div className="ui_stack_list">
          <div className="ui_section_header_inline">
            <div>
              <p className="ui_section_title">{labels.staticConfigTitle}</p>
              <p className="ui_section_body">{snapshot.staticConfigPath}</p>
            </div>
            <Button variant="secondary" type="button" onClick={() => setOpenDialog("static")}>
              {labels.viewConfig}
            </Button>
          </div>

          <div className="ui_section_header_inline">
            <div>
              <p className="ui_section_title">{labels.runtimeConfigTitle}</p>
              <p className="ui_section_body">{snapshot.runtimeConfigPath}</p>
            </div>
            <Button variant="secondary" type="button" onClick={() => setOpenDialog("runtime")}>
              {labels.viewConfig}
            </Button>
          </div>
        </div>
      </section>

      {openDialog ? (
        <div className="ui_overlay" role="presentation" onClick={() => setOpenDialog(null)}>
          <div
            className="ui_dialog ui_dialog_panel ui_dialog_panel--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="operator-infrastructure-config-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ui_dialog_header">
              <div className="ui_dialog_heading">
                <p className="ui_section_title" id="operator-infrastructure-config-title">
                  {dialogTitle}
                </p>
              </div>
              <Button
                variant="ghost"
                type="button"
                className="ui_icon_button operator-icon_button ui_dialog_close"
                aria-label={labels.close}
                title={labels.close}
                onClick={() => setOpenDialog(null)}
              >
                ×
              </Button>
            </div>

            <p className="ui_section_body ui_dialog_subtitle">{dialogSubtitle}</p>
            <pre className="ui_code_block">
              <code>{dialogContent}</code>
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
