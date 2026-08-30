import Link from "next/link";
import { redirect } from "next/navigation";

import { isBootstrapEnabled } from "@/lib/config";
import { readPhiRuntimeConfigSync } from "@/lib/config-files";
import { getOperatorSession } from "@/lib/operator-auth";
import { isDatabaseAvailable } from "@/db/runtime-health";

export default async function RecoveryPage() {
  if (isBootstrapEnabled()) {
    redirect("/setup");
  }

  const session = await getOperatorSession();
  if (!session) {
    redirect("/operator/login");
  }

  const runtimeConfig = readPhiRuntimeConfigSync();
  const dbAvailable = await isDatabaseAvailable(runtimeConfig.database?.uri);

  if (dbAvailable) {
    redirect("/operator");
  }

  return (
    <main className="ui_shell">
      <section className="ui_card">
        <p className="ui_section_eyebrow">Recovery</p>
        <p className="ui_section_title">phis recovery</p>
        <p className="ui_section_body">
          The normal operator flow is not available because the database could not be
          reached.
        </p>
        <p className="ui_section_body">
          Restore database connectivity, verify the runtime configuration, and then
          return to the operator panel.
        </p>
        <p className="ui_section_body">
          <Link href="/operator" className="ui_text_link">
            Back to /operator
          </Link>
        </p>
      </section>
    </main>
  );
}
