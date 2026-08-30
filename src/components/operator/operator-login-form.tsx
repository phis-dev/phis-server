"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

type OperatorLoginFormProps = {
  labels: {
    email: string;
    password: string;
    submit: string;
    pending: string;
  };
  errors: {
    initSession: string;
    invalidCredentials: string;
    loginFailed: string;
    network: string;
  };
};

function normalizeErrorMessage(
  message: string,
  errors: OperatorLoginFormProps["errors"],
) {
  const normalized = message.trim();
  if (!normalized) {
    return errors.loginFailed;
  }

  if (normalized === "Invalid credentials.") {
    return errors.invalidCredentials;
  }

  if (normalized === "Operator login failed." || normalized === "Login failed.") {
    return errors.loginFailed;
  }

  return normalized;
}

export function OperatorLoginForm({ labels, errors }: OperatorLoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsPending(true);

    try {
      const csrfResponse = await fetch("/api/auth/csrf", {
        method: "GET",
        credentials: "same-origin",
      });
      const csrfPayload = (await csrfResponse.json()) as { token?: string };
      const csrfToken = csrfPayload.token?.trim() ?? "";

      if (!csrfResponse.ok || !csrfToken) {
        setError(errors.initSession);
        return;
      }

      const response = await fetch("/api/operator/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(normalizeErrorMessage(payload.error ?? "", errors));
        return;
      }

      router.replace("/operator");
      router.refresh();
    } catch {
      setError(errors.network);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form className="ui_form" onSubmit={handleSubmit}>
      <label className="ui_field">
        <span className="ui_field_label">{labels.email}</span>
        <input
          className="ui_input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>

      <label className="ui_field">
        <span className="ui_field_label">{labels.password}</span>
        <input
          className="ui_input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>

      {error ? <p className="ui_notice_inline_error">{error}</p> : null}

      <div className="ui_form_footer">
        <Button type="submit" disabled={isPending}>
          {isPending ? labels.pending : labels.submit}
        </Button>
      </div>
    </form>
  );
}
