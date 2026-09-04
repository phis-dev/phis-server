import { redirect } from "next/navigation";

import { OPERATOR_LOGIN_LABELS } from "@/components/operator/label-sets";
import { OperatorLoginForm } from "@/components/operator/operator-login-form";
import { isBootstrapEnabled } from "@/lib/config";
import { readPhiRuntimeConfigSync } from "@/lib/config-files";
import { getOperatorSession } from "@/lib/operator-auth";
import { trGlobalLabelSet } from "@/lib/landing-tr";
import { isDatabaseAvailable } from "@/db/runtime-health";

const WEB_UI_LABEL_CONTEXT = "Web UI label";

export default async function OperatorLoginPage() {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }

  const session = await getOperatorSession();
  if (session) {
    const runtimeConfig = readPhiRuntimeConfigSync();
    const dbAvailable = await isDatabaseAvailable(runtimeConfig.database?.uri);
    if (!dbAvailable) {
      redirect("/recovery");
    }

    redirect("/operator");
  }

  const labels = await trGlobalLabelSet(OPERATOR_LOGIN_LABELS, WEB_UI_LABEL_CONTEXT);

  return (
    <main className="ui_shell ui_shell--narrow">
      <section className="ui_card operator-login-panel">
        <p className="ui_section_eyebrow">{labels.eyebrow}</p>
        <p className="ui_section_title">{labels.title}</p>
        <p className="ui_section_body">{labels.description}</p>
        <OperatorLoginForm
          labels={{
            email: labels.email,
            password: labels.password,
            submit: labels.submit,
            pending: labels.pending,
          }}
          errors={{
            initSession: labels.errorInitSession,
            invalidCredentials: labels.errorInvalidCredentials,
            loginFailed: labels.errorLoginFailed,
            network: labels.errorNetwork,
          }}
        />
      </section>
    </main>
  );
}
