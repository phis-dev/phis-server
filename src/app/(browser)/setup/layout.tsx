import { SetupLayoutShell } from "@/components/bootstrap/setup-layout-shell";
import { requirePhisBrowserSurface } from "@/lib/browser-surfaces";

export default function SetupLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  requirePhisBrowserSurface("setup");

  return <SetupLayoutShell>{children}</SetupLayoutShell>;
}
