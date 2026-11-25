import type { NextRequest } from "next/server";

import { dispatchPhisAddonRequest } from "@/lib/addons/dispatcher";

type RouteContext = {
  params: Promise<{
    scope: string;
    name: string;
    path?: string[];
  }>;
};

async function dispatch(request: NextRequest, context: RouteContext) {
  return dispatchPhisAddonRequest(request, "api", await context.params);
}

export const DELETE = dispatch;
export const GET = dispatch;
// Answered by the GET descriptor, without a body (`dispatchPhisAddonRequest`).
export const HEAD = dispatch;
export const PATCH = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
