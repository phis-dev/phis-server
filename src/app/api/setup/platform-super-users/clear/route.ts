import { NextResponse } from "next/server";

import { isBootstrapEnabled } from "@/lib/config";
import {
  readPhiRuntimeConfigSync,
  writePhiRuntimeConfigSync,
} from "@/lib/config-files";

export async function POST() {
  if (!isBootstrapEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const runtimeConfig = readPhiRuntimeConfigSync();

  writePhiRuntimeConfigSync({
    ...runtimeConfig,
    platformSuperUsers: [],
  });

  return NextResponse.json({});
}
