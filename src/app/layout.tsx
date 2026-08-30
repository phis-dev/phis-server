import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "phis",
  description:
    "API backend for Phi ecosystem frontends and admin tools.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
