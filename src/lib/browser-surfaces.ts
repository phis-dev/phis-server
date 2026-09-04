import "server-only";

import { notFound } from "next/navigation";

import { isBootstrapEnabled } from "@/lib/config";

/**
 * The pages this service answers in a browser, and what each one depends on.
 *
 * Everything else here is an API. Which pages exist used to be decided in `middleware.ts`, a file that
 * ran on every request, sat outside `src/` where `next dev` never loaded it, and answered `404` to the
 * operator, setup and recovery pages for as long as they had existed -- visible only in a production
 * build. The decision now sits beside the pages it governs, costs nothing per request, and is one
 * table rather than a list somebody has to remember to extend.
 *
 * `offered` is not `enabled`. A surface that is offered still decides for itself who may see it: the
 * operator pages have their own session, and this only answers whether the installation serves them at
 * all. `notFound` rather than a refusal, because a surface an installation does not offer should not
 * announce that it exists.
 */
export const PHIS_BROWSER_SURFACES = {
  /** The control plane. It has to work when no Site does, so nothing switches it off. */
  operator: () => true,
  /** Runs before any Site exists, and only while the installation says it is being set up. */
  setup: () => isBootstrapEnabled(),
  /** The way back in when the operator surface itself cannot be reached. */
  recovery: () => true,
} as const;

export type PhisBrowserSurface = keyof typeof PHIS_BROWSER_SURFACES;

/** Renders `notFound()` unless this installation offers the surface. */
export function requirePhisBrowserSurface(surface: PhisBrowserSurface) {
  if (!PHIS_BROWSER_SURFACES[surface]()) {
    notFound();
  }
}
