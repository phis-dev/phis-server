import { trGlobalLabelSet } from "@/lib/landing-tr";

/**
 * What a browser sees at the server's own address: that the installation runs, not a reply that reads
 * like an error. It names no version, no instance and no link to `/operator` -- the page is public, and
 * INSTALL.md exposes the operator UI to operators only. The text is English and reaches another language
 * only through the installation's translator (`translation.mode`), like the operator login.
 */
const ROOT_PAGE_LABELS = {
  title: "phis server is running",
  installed: "The server was installed successfully and answers its APIs under /api.",
  noSite:
    "No Site is served at this address yet: Sites run as instances of their own, set up with the phis CLI.",
} as const;

const WEB_UI_MESSAGE_CONTEXT = "Web UI message";

export default async function RootPage() {
  const labels = await trGlobalLabelSet(ROOT_PAGE_LABELS, WEB_UI_MESSAGE_CONTEXT);

  return (
    <main
      style={{
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        padding: "2rem",
        maxWidth: "40rem",
      }}
    >
      <h1 style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
        <span
          aria-hidden="true"
          style={{
            width: "0.7rem",
            height: "0.7rem",
            borderRadius: "50%",
            background: "#2e9e5b",
            flex: "none",
          }}
        />
        {labels.title}
      </h1>
      <p>{labels.installed}</p>
      <p>{labels.noSite}</p>
    </main>
  );
}
