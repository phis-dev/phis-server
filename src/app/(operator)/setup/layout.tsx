import { SetupLayoutShell } from "@/components/bootstrap/setup-layout-shell";
import { requirePhisOperatorSurface } from "@/lib/operator-surfaces";

export default function SetupLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  requirePhisOperatorSurface("setup");

  return <SetupLayoutShell>{children}</SetupLayoutShell>;
}
