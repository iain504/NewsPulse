"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";

/**
 * Client-side providers: dark/light theme (class strategy) + sonner toasts.
 * Wrapped around the whole app in the root layout.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </ThemeProvider>
  );
}
