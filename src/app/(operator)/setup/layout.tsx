import { SetupLayoutShell } from "@/components/bootstrap/setup-layout-shell";
import { requirePhisOperatorSurface } from "@/lib/operator-surfaces";

/*
 * Whether this page exists is the installation's answer, read from its configuration per request. Left
 * to prerendering, the build machine's configuration decided it: a machine without one baked in a 404,
 * and one with `bootstrap.enabled` failed the build on the shell's search params.
 */
export const dynamic = "force-dynamic";

export default function SetupLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  requirePhisOperatorSurface("setup");

  return <SetupLayoutShell>{children}</SetupLayoutShell>;
}
