import type { ReactNode } from "react";

import { requirePhisBrowserSurface } from "@/lib/browser-surfaces";

/**
 * Recovery has no shell of its own -- it is reached when the operator surface cannot be. The layout
 * exists so this page passes the same gate as its neighbours: every page under `(browser)` answers
 * only where its surface is offered, and one without a layout would answer everywhere.
 */
export default function RecoveryLayout({ children }: { children: ReactNode }) {
  requirePhisBrowserSurface("recovery");
  return <>{children}</>;
}
