import type { ReactNode } from "react";

import { requirePhisOperatorSurface } from "@/lib/operator-surfaces";

/**
 * Recovery has no shell of its own -- it is reached when the operator pages cannot be. The layout
 * exists so this page passes the same gate as its neighbours: every page under `(operator)` answers
 * only where its surface is offered, and one without a layout would answer everywhere.
 */
export default function RecoveryLayout({ children }: { children: ReactNode }) {
  requirePhisOperatorSurface("recovery");
  return <>{children}</>;
}
