export const bootstrapEn = {
  languageLabel: "Language",
  title: "phis setup",
  subtitle:
    "Bootstrap mode is active. Use this flow to prepare the runtime before the main admin becomes available.",
  introEyebrow: "Bootstrap",
  stepLabel: "Step",
  statusComplete: "Complete",
  statusCurrent: "Current",
  statusUpcoming: "Upcoming",
  continueLabel: "GOOD TO KNOW",
  runtimeCheckRunLabel: "Run checks",
  runtimeCheckRerunLabel: "Run checks again",
  runtimeCheckRunningLabel: "Running checks...",
  runtimeCheckContinueLabel: "Continue >",
  runtimeCheckVerifiedLabel: "Verified",
  runtimeCheckWarningLabel: "Warning",
  runtimeCheckFailedLabel: "Failed",
  operatorDisplayNameLabel: "Name",
  operatorEmailLabel: "Email",
  operatorPasswordLabel: "Password",
  operatorPasswordHint: "At least 8 characters and at least 1 special character.",
  operatorCreateLabel: "Create account >",
  operatorCreatingLabel: "Creating account...",
  operatorContinueLabel: "Continue >",
  operatorSavedLabel: "The operator account is now configured.",
  operatorExistingDescription: "Review the configured operator accounts.",
  operatorUnnamedLabel: "Unnamed operator",
  operatorEnabledLabel: "Enabled",
  operatorDisabledLabel: "Disabled",
  operatorClearLabel: "Clear accounts",
  operatorClearingLabel: "Clearing...",
  operatorClearWarning:
    "This removes all configured operator accounts from phis-runtime.json.",
  operatorClearConfirm:
    "Do you want to remove all configured operator accounts?",
  cancelLabel: "Cancel",
  translationChooseLabel: "Choose the translation mode for phis and the managed sites.",
  translationAiLabel: "AI-assisted with DeepL",
  translationAiDescription:
    "Use automatic translations with a DeepL API key and custom API endpoint. Both the phis UI and managed sites can be translated automatically, and translations can still be adjusted at any time.",
  translationAiKeyLabel: "DeepL key",
  translationAiEndpointLabel: "API endpoint",
  translationAiLinkBefore: "Get a free token at ",
  translationAiLinkLabel: "DeepL",
  translationAiLinkAfter: ".",
  translationAiLinkHref: "https://www.deepl.com/pro/change-plan#api",
  translationCdnLabel: "CDN, then DeepL",
  translationCdnDescription:
    "Ask cdn.phis.dev for the platform's own messages first and DeepL for the rest. A DeepL key is optional: without one the interface is still translated, and only site content and conversation messages are not.",
  translationAddonLabel: "Translation add-on",
  translationAddonDescription:
    "Hand translation to the service provider an add-on supplies and the operator selects. What it talks to is the provider's own business.",
  translationEnglishLabel: "English UI only",
  translationEnglishDescription:
    "The admin and editor UI stay in English. Managed sites must handle translations on their own.",
  translationContinueLabel: "Continue >",
  databaseHostLabel: "Host",
  databasePortLabel: "Port",
  databaseNameLabel: "Database",
  databaseUserLabel: "User",
  databasePasswordLabel: "Password",
  databasePasswordKeptHint: "Leave empty to keep the stored password.",
  databaseSslLabel: "SSL mode",
  databaseSslDisableLabel: "Disable",
  databaseSslRequireLabel: "Require",
  databaseCurrentLabel: "Current connection",
  databaseConnectionLabel: "Connection details",
  databaseConnectionDescription:
    "If a database connection is already configured, phis shows it here and pre-fills the fields below.",
  databaseTestingLabel: "Testing connection...",
  databaseContinueLabel: "Continue >",
  databaseErrorPrefix: "Database error:",
  schemaStatusLabel: "Current schema status",
  schemaAppliedLabel: "Schema ready",
  schemaTablesLabel: "tables detected",
  schemaMissingLabel: "No phis schema detected yet.",
  schemaCreateLabel: "Create tables >",
  schemaCreatingLabel: "Creating tables...",
  schemaContinueLabel: "Continue >",
  schemaErrorPrefix: "Schema error:",
  siteCurrentLabel: "Current sites",
  siteExistingDescription:
    "phis already has one or more configured sites. Review their base URLs or continue to the final review.",
  siteDemoToggleLabel: "Create demo site record",
  siteDemoToggleHint:
    "Add a ready-made demo site entry to the phis database. This does not create a Next.js project or deploy a runtime yet.",
  siteCreateToggleLabel: "Create new site",
  siteCreateToggleHint:
    "Define the first real managed site now and persist its core runtime values in the phis database.",
  siteKeyLabel: "Site key",
  siteNameLabel: "Site name",
  siteHostnameLabel: "Hostname",
  siteBaseUrlLabel: "Public base URL",
  siteDefaultLocaleLabel: "Default locale",
  siteSupportEmailLabel: "Support email",
  siteContinueLabel: "Continue >",
  siteCreatingLabel: "Saving site setup...",
  siteErrorPrefix: "Site error:",
  finishReviewLabel: "Review",
  finishOperatorsLabel: "Operator accounts",
  finishSitesLabel: "Configured sites",
  finishTranslationLabel: "Translation mode",
  finishDatabaseLabel: "Database",
  finishInfrastructureHint:
    "Infrastructure provisioning is not finished yet. Continue with runtime, web server, and deployment tasks in the operator panel after setup.",
  finishTermsLabel: "Terms & Conditions",
  finishTermsAcceptLabel: "I understand and accept these terms.",
  finishTermsBody:
    "phis is distributed under the GNU General Public License v3 or later and is provided without warranty, to the extent permitted by that license. The operator remains responsible for deployment, configuration, security, backups, and legal compliance.",
  finishCompleteLabel: "Complete setup >",
  finishCompletingLabel: "Completing setup...",
  finishErrorPrefix: "Finish error:",
  languages: {
    en: "English",
    de: "Deutsch",
  },
  runtimeChecks: {
    hostname: {
      title: "Hostname",
      description: "Confirm which host or container name the setup currently runs on.",
    },
    platform: {
      title: "Platform",
      description: "Show the operating system and CPU architecture of the running runtime.",
    },
    node: {
      title: "Node.js version",
      description: "Verify the runtime has a usable Node.js version for phis.",
    },
    memory: {
      title: "Available memory",
      description: "Report total and free memory visible to the current process.",
    },
    disk: {
      title: "Free disk space",
      description: "Check available disk space in the current application filesystem.",
    },
    configStatic: {
      title: "Static config readable",
      description: "Verify tracked config can be read by the running phis process.",
    },
    configRuntime: {
      title: "Runtime config writable",
      description: "Verify runtime config can be created and updated by setup flows.",
    },
    cli: {
      title: "phis CLI",
      description: "Verify the local phis command can run config validation successfully.",
    },
    containerized: {
      title: "Container mode",
      description: "Show whether phis is configured to run in a containerized environment.",
    },
  },
  steps: {
    locale: {
      title: "Setup language",
      summary:
        "Keep the bootstrap flow readable before database-backed translations exist.",
      description:
        "The setup should always work without DeepL, DB content, or the normal translation pipeline. Keep a compact built-in locale switch in the setup shell.",
      actions: [
        "Render bootstrap copy from local translation files only.",
        "Expose a compact language selector in the setup card header.",
        "Default to English and keep German available from the first screen.",
      ],
    },
    runtime: {
      title: "Runtime checks",
      summary:
        "Verify the host can actually run phis before writing persistent configuration.",
      description:
        "Run the host-level checks first so missing runtime requirements, writable config paths, platform mode, and basic setup state are visible before database details are entered.",
      actions: [
        "Start the checks explicitly with the action button below.",
        "Review the result stream before continuing to database configuration.",
        "Fix hard runtime failures before moving on to the next setup step.",
      ],
      goodToKnowTitle: "Open source",
      goodToKnowBodyBeforeLink:
        "phis is fully open-source under GPLv3. Contributions are welcome via pull requests on ",
      goodToKnowLinkLabel: "GitHub",
      goodToKnowBodyAfterLink: ".",
      goodToKnowLinkHref: "https://github.com/phisys-ltd/phis",
    },
    operator: {
      title: "Platform operator",
      summary:
        "Create the operational account that can always access phis setup and recovery flows.",
      description:
        "Review the configured operator accounts or create the first one now.",
      actions: [
        "Collect email, display name, and password.",
        "Store only a password hash in phis-runtime.json.",
        "Allow later management through the planned phis CLI.",
      ],
      goodToKnowTitle: "Built with AI",
      goodToKnowBodyBeforeLink:
        "phis was built fully with the help of AI and deliberately relies on modern technologies across its stack.",
    },
    translations: {
      title: "Translation mode",
      summary:
        "Choose how phis should handle UI translations and multilingual site support.",
      description:
        "Pick one translation strategy before the first site is configured. DeepL needs credentials, CDN mode depends on cdn.phis.dev, custom mode forwards to your own endpoint, and English-only keeps the UI in English while multilingual sites must be translated manually.",
      actions: [
        "DeepL with API key and endpoint.",
        "CDN-based translation for UI only.",
        "Custom endpoint with the phis translation payload format.",
        "English-only UI with site-managed translations.",
      ],
      goodToKnowTitle: "Multilingual site translations",
      goodToKnowBodyBeforeLink:
        "phis caches DeepL translations in its own database so only new translation requests need to be sent to DeepL.",
    },
    database: {
      title: "Database connection",
      summary:
        "Configure the PostgreSQL connection for the phis control-plane database.",
      description:
        "Use the existing connection if one is already configured, or enter a new one now. phis only continues when it can connect and verify write access on the target database.",
      actions: [
        "Host, port, database name, user, password, SSL mode.",
        "Connection test against the server-level bootstrap connection.",
        "Show clear validation before continuing.",
      ],
      goodToKnowTitle: "Built-in Medusa support",
      goodToKnowBodyBeforeLink:
        "phis has built-in support for Medusa stores and can connect them as managed commerce backends later in the setup flow.",
    },
    schema: {
      title: "Schema creation",
      summary:
        "Create the initial phis tables and verify that the schema is ready.",
      description:
        "This step applies the bootstrap SQL script for new installations. If the phis schema already exists, the script runs idempotently and simply verifies the current structure.",
      actions: [
        "Create database if missing.",
        "Apply the phis SQL bootstrap script.",
        "Verify the core tables are readable afterwards.",
      ],
      goodToKnowTitle: "Plugin marketplace",
      goodToKnowBodyBeforeLink:
        "phis includes a plugin system for themes, layouts, and widgets. Third parties can publish their extensions in the marketplace and even monetize them.",
    },
    site: {
      title: "Initial site",
      summary:
        "Optionally create a first site so the platform is immediately usable.",
      description:
        "This should stay optional. Some installations may want to finish only the control plane first and add sites afterwards.",
      actions: [
        "Offer yes/no instead of forcing site creation.",
        "If enabled: collect key, hostname, locales, mail identity, and public base URL.",
        "Optionally connect an initial Medusa backend later in the flow.",
      ],
      goodToKnowTitle: "Multi-site ready",
      goodToKnowBodyBeforeLink:
        "phis keeps site runtime data in its own database so more sites can be added later without rebuilding the platform itself.",
    },
    finish: {
      title: "Review and apply",
      summary:
        "Confirm the collected setup state and lock down bootstrap mode.",
      description:
        "Finish with a review screen that shows the chosen configuration, writes the final runtime values, and explains which follow-up tasks remain after setup.",
      actions: [
        "Show a final summary.",
        "Write config files atomically.",
        "Disable bootstrap mode unless explicitly kept on for recovery.",
      ],
      goodToKnowTitle: "Bootstrap hand-off",
      goodToKnowBodyBeforeLink:
        "After setup is completed, phis hands over to the normal admin workflow. Infrastructure provisioning and site runtime deployment continue outside bootstrap mode.",
    },
  },
} as const;
