import "server-only";

type SiteMedusaConfig = {
  medusaBaseUrl: string | null;
  medusaPublishableKey: string | null;
  customerNumberPrefix: string | null;
};

type CreateCustomerInput = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string | null;
};

export type MedusaCustomerRecord = {
  id: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
};

function requireMedusaConfig(siteConfig: SiteMedusaConfig) {
  const medusaBaseUrl = siteConfig.medusaBaseUrl?.trim().replace(/\/$/, "") ?? "";
  const medusaPublishableKey = siteConfig.medusaPublishableKey?.trim() ?? "";

  if (!medusaBaseUrl) {
    throw new Error("Missing sites.medusa_base_url.");
  }

  if (!medusaPublishableKey) {
    throw new Error("Missing sites.medusa_publishable_key.");
  }

  return { medusaBaseUrl, medusaPublishableKey };
}

async function parseMedusaError(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | { message?: string; error?: string; type?: string }
    | null;

  return payload?.message || payload?.error || response.statusText || "Medusa request failed.";
}

async function getCustomerToken(
  siteConfig: SiteMedusaConfig,
  email: string,
  password: string,
  mode: "register" | "login",
) {
  const { medusaBaseUrl } = requireMedusaConfig(siteConfig);
  const endpoint =
    mode === "register"
      ? `${medusaBaseUrl}/auth/customer/emailpass/register`
      : `${medusaBaseUrl}/auth/customer/emailpass`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await parseMedusaError(response));
  }

  const payload = (await response.json()) as { token?: string };
  const token = payload.token?.trim();
  if (!token) {
    throw new Error(`Missing Medusa ${mode} token.`);
  }

  return token;
}

async function getExistingCustomer(
  siteConfig: SiteMedusaConfig,
  authToken: string,
) {
  const { medusaBaseUrl, medusaPublishableKey } = requireMedusaConfig(siteConfig);
  const response = await fetch(`${medusaBaseUrl}/store/customers/me`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${authToken}`,
      "x-publishable-api-key": medusaPublishableKey,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await parseMedusaError(response));
  }

  const payload = (await response.json()) as {
    customer?: {
      id?: string;
      email?: string;
      first_name?: string | null;
      last_name?: string | null;
      company_name?: string | null;
    };
  };

  return {
    id: payload.customer?.id ?? null,
    email: payload.customer?.email ?? null,
    firstName: payload.customer?.first_name ?? null,
    lastName: payload.customer?.last_name ?? null,
    companyName: payload.customer?.company_name ?? null,
  };
}

export async function createMedusaCustomer(
  siteConfig: SiteMedusaConfig,
  input: CreateCustomerInput,
): Promise<MedusaCustomerRecord> {
  const { medusaBaseUrl, medusaPublishableKey } = requireMedusaConfig(siteConfig);

  let customerToken: string;
  let shouldCreateCustomer = true;

  try {
    customerToken = await getCustomerToken(siteConfig, input.email, input.password, "register");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.includes("Identity with email already exists")) {
      throw error;
    }

    customerToken = await getCustomerToken(siteConfig, input.email, input.password, "login");
    shouldCreateCustomer = false;
  }

  if (!shouldCreateCustomer) {
    const existingCustomer = await getExistingCustomer(siteConfig, customerToken);
    if (!existingCustomer.id) {
      throw new Error("Existing Medusa customer could not be resolved.");
    }

    return {
      id: existingCustomer.id,
      email: existingCustomer.email ?? input.email,
      firstName: existingCustomer.firstName,
      lastName: existingCustomer.lastName,
      companyName: existingCustomer.companyName,
    };
  }

  const response = await fetch(`${medusaBaseUrl}/store/customers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${customerToken}`,
      "x-publishable-api-key": medusaPublishableKey,
    },
    body: JSON.stringify({
      email: input.email,
      first_name: input.firstName || undefined,
      last_name: input.lastName || undefined,
      company_name: input.companyName || undefined,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await parseMedusaError(response));
  }

  const payload = (await response.json()) as {
    customer?: { id?: string; email?: string };
  };

  return {
    id: payload.customer?.id ?? null,
    email: payload.customer?.email ?? input.email,
    firstName: input.firstName || null,
    lastName: input.lastName || null,
    companyName: input.companyName || null,
  };
}
