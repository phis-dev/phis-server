import { notFound } from "next/navigation";

import { SetupLayoutShell } from "@/components/bootstrap/setup-layout-shell";
import { isBootstrapEnabled } from "@/lib/config";

export default function SetupLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  if (!isBootstrapEnabled()) {
    notFound();
  }

  return <SetupLayoutShell>{children}</SetupLayoutShell>;
}
