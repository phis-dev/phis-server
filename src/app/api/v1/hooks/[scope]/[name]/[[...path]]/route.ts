import type { NextRequest } from "next/server";

import { dispatchPhiServerAddonRequest } from "@/lib/addons/dispatcher";

type RouteContext = {
  params: Promise<{
    scope: string;
    name: string;
    path?: string[];
  }>;
};

async function dispatch(request: NextRequest, context: RouteContext) {
  return dispatchPhiServerAddonRequest(request, "hook", await context.params);
}

export const DELETE = dispatch;
export const GET = dispatch;
export const PATCH = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
