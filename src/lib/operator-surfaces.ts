import "server-only";

import { notFound } from "next/navigation";

import { isBootstrapEnabled } from "@/lib/config";

/**
 * The operator's pages, and what each one depends on.
 *
 * They are the only pages this service renders; everything else it answers is an API. All three are
 * the operator's rather than a visitor's -- setting an installation up and recovering it are the same
 * job as running it, which is why they share a gate and a route group.
 *
 * Which pages exist used to be decided in `middleware.ts`, a file that
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
export const PHIS_OPERATOR_SURFACES = {
  /** The control plane. It has to work when no Site does, so nothing switches it off. */
  operator: () => true,
  /** Runs before any Site exists, and only while the installation says it is being set up. */
  setup: () => isBootstrapEnabled(),
  /** The way back in when the operator surface itself cannot be reached. */
  recovery: () => true,
} as const;

export type PhisOperatorSurface = keyof typeof PHIS_OPERATOR_SURFACES;

/** Renders `notFound()` unless this installation offers the surface. */
export function requirePhisOperatorSurface(surface: PhisOperatorSurface) {
  if (!PHIS_OPERATOR_SURFACES[surface]()) {
    notFound();
  }
}
