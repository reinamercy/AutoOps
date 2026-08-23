import type { Metadata } from "next";
import { Toaster } from "sonner";
import { ThemeProvider } from "../lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoOps AI — Enterprise Dashboard",
  description: "Real-time multi-agent incident remediation dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <ThemeProvider>
          {children}
          <Toaster
            position="bottom-right"
            theme="dark"
            richColors
            toastOptions={{
              style: {
                background: "rgb(var(--surface))",
                border: "1px solid rgb(var(--border))",
                color: "rgb(var(--text))",
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
