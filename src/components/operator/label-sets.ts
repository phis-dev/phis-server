export const OPERATOR_LOGIN_LABELS = {
  eyebrow: "Operator",
  title: "Login",
  description:
    "Sign in with a configured platform operator account to continue into the operator panel.",
  email: "Email",
  password: "Password",
  submit: "Login",
  pending: "Signing in...",
  errorInitSession: "Could not initialize login session.",
  errorInvalidCredentials: "Invalid credentials.",
  errorLoginFailed: "Login failed.",
  errorNetwork: "Network error while logging in.",
} as const;

export const OPERATOR_LAYOUT_LABELS = {
  language: "Language",
  logout: "Logout",
  overview: "Overview",
  sites: "Web-Sites",
  translations: "Translations",
  operators: "Operators",
  infrastructure: "Infrastructure",
} as const;

export const OPERATOR_OVERVIEW_LABELS = {
  title: "System overview",
  os: "OS",
  node: "Node.js",
  next: "Next.js",
  cpuCard: "CPU load",
  memoryCard: "Memory used",
  diskCard: "Disk free",
  uptimeCard: "Uptime",
  cpuGraph: "CPU graph",
  memoryGraph: "Memory graph",
  diskGraph: "Disk graph",
  loadDetail: "Load",
  usedDetail: "Used",
  freeDetail: "Free",
  sitesTitle: "Sites",
  translationsTitle: "Translations",
  operatorsTitle: "Operators",
  infrastructureTitle: "Infrastructure",
  comingSoon: "This operator section is sketched but not implemented yet.",
} as const;

export const OPERATOR_TRANSLATIONS_LABELS = {
  title: "Translations",
  intro:
    "Select the platform locales that should stay available for sites and the operator panel.",
  mode: "Translation mode",
  modeHelp: "Choose how phis should resolve platform and website translations.",
  source: "Locale source",
  supportedLocales: "Supported locales",
  supportedLocalesHelp:
    "This is the operator-defined subset that stays available across the platform and for site configuration.",
  publicReads: "Allow public read access",
  publicReadsHint:
    "Allow the global translation endpoints to be read with the configured public token.",
  publicToken: "Public token",
  publicTokenHelp:
    "External clients use this token to read the global translation endpoint. Change it here to rotate access.",
  publicWrites: "Allow public write access",
  publicWritesHint:
    "Allow the global translation endpoint to accept write requests with the configured public token.",
  publicWritesWarningTitle: "Enable public write access?",
  publicWritesWarningDescription:
    "This should only be enabled in trusted internal company networks or temporarily to seed languages. If you do not know exactly what you are doing, leave it disabled.",
  publicWritesEnable: "Enable public writes",
  cancel: "Cancel",
  localeSelectionPlaceholder: "Select locales",
  modeDeepl: "DeepL targets",
  modeDeeplDescription:
    "Use automatic translations with a DeepL API key and custom API endpoint. Both the phis UI and managed sites can be translated automatically, and translations can still be adjusted at any time.",
  deeplKey: "DeepL key",
  deeplKeyHelp:
    "The configured DeepL API key used for automatic translation requests from this phis instance.",
  deeplEndpoint: "DeepL endpoint",
  deeplEndpointHelp:
    "The configured DeepL API endpoint used by phis for translation requests.",
  modeCdn: "phis CDN, then DeepL",
  modeCdnDescription:
    "Ask the CDN for the platform's own messages first and DeepL for the rest. A DeepL key is optional: without one the interface is still translated, and only site content and conversation messages are not.",
  cdnEndpoint: "CDN endpoint",
  cdnEndpointHelp:
    "The phis CDN base URL comes from phis-config.json and is used for the shared locale and UI translation source.",
  modeAddon: "Translation add-on",
  modeAddonDescription:
    "Hand translation to the service provider an add-on supplies and the operator selects. What it talks to is the provider's own business.",
  addonProvider: "Translation add-on",
  addonProviderHelp:
    "Which installed add-on translates. Several may be installed; exactly one is used. An add-on that is disabled or was built against another interface is listed and cannot be chosen.",
  addonProviderEmpty: "No installed add-on offers translation.",
  addonProviderUnset: "Select an add-on",
  addonSecret: "Add-on secret",
  addonSecretHelp:
    "The secret reference the selected add-on is given, in the form addon:@scope/name:api-key. It names a stored secret and never holds one. Leave it empty for an add-on that needs no credential.",
  customSchema: "Schema",
  customSchemaTitle: "Custom translation schema",
  customSchemaIntro:
    "phis forwards JSON requests to the configured custom endpoint and returns the response payload back to the caller.",
  customSchemaForwardedHeaders: "Forwarded headers",
  customSchemaSingleRequest: "Single translation request",
  customSchemaBatchRequest: "Batch translation request",
  customSchemaSingleResponse: "Single translation response",
  customSchemaBatchResponse: "Batch translation response",
  close: "Close",
  modeNone: "Internal locale catalog",
  modeNoneDescription:
    "The admin and editor UI stay in English. Managed sites must handle translations on their own.",
  localeInUse: "Used by configured sites",
  save: "Save",
  savePending: "Saving locales...",
  success: "Translation settings saved.",
  sourceError:
    "The external locale source could not be refreshed right now. The current configured locales are shown as fallback.",
  validationError:
    "Some locales cannot be removed yet because they are still used by configured sites.",
} as const;

export const OPERATOR_SITES_LABELS = {
  title: "Web-Sites",
  intro:
    "Manage platform site records and review the runtime snippets needed to provision them outside the operator panel.",
  createTitle: "Create site",
  createDescription:
    "Add a new site record with hostname, public base URL, and default locale.",
  settingsTitle: "Site settings",
  settingsDescription:
    "Adjust hostname, public base URL, support email, and enabled locales for this site.",
  key: "Site key",
  keyHelp:
    "The site key is the central stable key for this website and is used by runtime and integration paths.",
  immutableKeyHint:
    "The site key cannot be changed because it serves as the central key for internal and external integrations.",
  name: "Site name",
  nameHelp: "The site name is the human-readable title shown in operator and site-facing contexts.",
  hostname: "Hostname",
  hostnameHelp:
    "The hostname is the public domain or subdomain that should resolve to this website.",
  publicBaseUrl: "Public base URL",
  publicBaseUrlHelp:
    "The public base URL is the canonical external URL used for links, redirects, and generated references.",
  supportEmail: "Support email",
  supportEmailHelp:
    "The support email is shown in site communications and is also used as the current contact recipient for contact forms.",
  defaultLocale: "Default locale",
  defaultLocaleHelp:
    "Use the default locale as the primary language and source locale for this website. Once the site exists, it should no longer be changed.",
  availableLocales: "Available locales",
  availableLocalesHelp:
    "These locales are enabled for this website and must stay within the platform-supported locale selection.",
  localeSelectionPlaceholder: "Select locales",
  tableSite: "Web-Site",
  createSubmit: "Create site",
  createPending: "Creating site...",
  updateSubmit: "Save settings",
  updatePending: "Saving settings...",
  existingTitle: "Configured sites",
  emptyTitle: "No sites configured yet",
  emptyBody: "Create the first site record to start generating deployment snippets.",
  locales: "Locales",
  deploymentTitle: "Deployment snippets",
  dockerCompose: "Docker compose",
  systemdUnit: "systemd unit",
  nginxConfig: "nginx config",
  apacheConfig: "Apache config",
  customRuntime: "Custom runtime",
  actions: "Actions",
  addSite: "New site",
  deploymentAction: "Deployment",
  settingsAction: "Settings",
  deleteTranslationsAction: "Delete translations",
  deleteTranslationsDescription:
    "Choose which translated locale variants should be removed for this site. Source messages and site content stay intact.",
  deleteTranslationsLocale: "Locale",
  deleteTranslationsConfirmTitle: "Delete locale translations",
  deleteTranslationsNoLocales:
    "No removable translated target locales are currently configured for this site.",
  deleteTranslationsPending: "Deleting translations...",
  deleteTranslationsSuccess: "Site translations deleted.",
  deleteTranslationsTitle: "Delete site translations",
  deleteTranslationsConfirm:
    "Delete the translated variants for this locale now? Source messages and site content stay intact; only site-specific translated rows for the selected locale are removed.",
  cancel: "Cancel",
  deleteAction: "Delete",
  deletePending: "Deleting site...",
  deleteTitle: "Delete site",
  deleteConfirm:
    "Delete this site record now? This also removes all site-bound data from the database.",
  close: "Close",
} as const;

export const OPERATOR_INFRASTRUCTURE_LABELS = {
  title: "Infrastructure",
  intro:
    "Inspect the local runtime environment and the current operator-managed runtime configuration for this phis instance.",
  runtimeTitle: "Runtime",
  pathsTitle: "Paths",
  configFilesTitle: "Config files",
  staticConfigTitle: "phis-config.json",
  runtimeConfigTitle: "phis-runtime.json",
  appRoot: "App root",
  workingDirectory: "Working directory",
  nodeEnv: "Node env",
  processId: "Process ID",
  user: "User",
  staticConfigPath: "phis-config.json",
  runtimeConfigPath: "phis-runtime.json",
  readable: "Readable",
  writable: "Writable",
  yes: "Yes",
  no: "No",
  viewConfig: "Show config",
  close: "Close",
  staticConfigNote:
    "phis-config.json should be treated as read-only here. It may be replaced or overwritten by deployment and system-managed flows.",
  runtimeConfigNote:
    "If operator-managed settings need to be adjusted, change phis-runtime.json rather than phis-config.json.",
} as const;
