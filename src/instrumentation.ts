const SERVER_ACTIONS_KEY_ENV = "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY";
const SERVER_ACTIONS_KEY_BYTES = 32;

function describeServerActionsKeyProblem(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) {
    return `${SERVER_ACTIONS_KEY_ENV} is not set.`;
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.toString("base64") !== raw) {
    return `${SERVER_ACTIONS_KEY_ENV} is not valid base64.`;
  }

  if (decoded.byteLength !== SERVER_ACTIONS_KEY_BYTES) {
    return `${SERVER_ACTIONS_KEY_ENV} must decode to ${SERVER_ACTIONS_KEY_BYTES} bytes, not ${decoded.byteLength}.`;
  }

  return null;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  /*
   * Imported here rather than at module scope: this file is evaluated in every runtime, and the
   * heartbeat reaches the database pool, the config and the install root -- none of which the edge
   * runtime has. A dev instance reports itself like any other, because it is one.
   */
  const { startPhisInstanceHeartbeat } = await import("@/lib/instance-heartbeat");
  startPhisInstanceHeartbeat();

  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const problem = describeServerActionsKeyProblem(process.env[SERVER_ACTIONS_KEY_ENV]);
  if (!problem) {
    return;
  }

  throw new Error(
    `${problem} Server Actions encrypt their bound arguments with this key, and a build carries one ` +
      "baked in, so every installation of the same artifact would share it. Set it per installation, " +
      "identically across the instances of one installation. Generate one with " +
      "`head -c 32 /dev/urandom | base64` and put it in the stage environment file " +
      "(/srv/phis/stages/<stage>/.env for the Debian package).",
  );
}
