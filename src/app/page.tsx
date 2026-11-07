"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import {
  BarChart3,
  GraduationCap,
  History,
  Moon,
  Newspaper,
  Sparkles,
  Sun,
} from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { AnalyzePanel } from "@/components/news-sentiment/analyze-panel";
import { DashboardPanel } from "@/components/news-sentiment/dashboard-panel";
import { StudyPanel } from "@/components/news-sentiment/study-panel";
import { HistoryPanel } from "@/components/news-sentiment/history-panel";
import { fetchJSON } from "@/lib/sse-client";
import type { ModelInfo } from "@/lib/types";

type ApiStatus = "checking" | "online" | "offline";
type TabKey = "analyze" | "dashboard" | "study" | "history";

const TABS: { value: TabKey; label: string; icon: React.ElementType }[] = [
  { value: "analyze", label: "Analyze", icon: Sparkles },
  { value: "dashboard", label: "Dashboard", icon: BarChart3 },
  { value: "study", label: "Study", icon: GraduationCap },
  { value: "history", label: "History", icon: History },
];

export default function Home() {
  const [historyRefreshKey, setHistoryRefreshKey] = React.useState(0);
  const [activeTab, setActiveTab] = React.useState<TabKey>("analyze");
  const [apiStatus, setApiStatus] = React.useState<ApiStatus>("checking");
  const [modelCount, setModelCount] = React.useState(0);
  const [mounted, setMounted] = React.useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Header API status probe
  React.useEffect(() => {
    let cancelled = false;
    fetchJSON<{ ok: boolean; models: ModelInfo[] }>("/api/models")
      .then((res) => {
        if (cancelled) return;
        setApiStatus("online");
        setModelCount(Array.isArray(res.models) ? res.models.length : 0);
      })
      .catch(() => {
        if (cancelled) return;
        setApiStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const statusDot =
    apiStatus === "online"
      ? "bg-emerald-500"
      : apiStatus === "offline"
        ? "bg-rose-500"
        : "bg-amber-500";

  const statusText =
    apiStatus === "online" ? (
      <>
        <span>Edge0 API</span>
        <span className="hidden sm:inline">
          {" "}
          · {modelCount} model{modelCount === 1 ? "" : "s"}
        </span>
      </>
    ) : apiStatus === "offline" ? (
      "API offline"
    ) : (
      "Checking API…"
    );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-zinc-950 text-amber-400 dark:bg-amber-500 dark:text-zinc-950">
              <Newspaper className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 leading-tight">
              <p className="truncate font-bold">NewsPulse</p>
              <p className="hidden text-xs text-muted-foreground sm:block">
                News Sentiment Study Lab
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground">
              <span className={`size-2 animate-pulse rounded-full ${statusDot}`} aria-hidden />
              {statusText}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              {mounted && resolvedTheme === "dark" ? (
                <Sun aria-hidden />
              ) : (
                <Moon aria-hidden />
              )}
            </Button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as TabKey)}
          className="gap-6"
        >
          <TabsList className="mx-auto grid h-auto w-full max-w-xl grid-cols-4 rounded-xl border bg-muted/50 p-1">
            {TABS.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="h-9 gap-1.5 rounded-lg sm:gap-2"
                aria-label={tab.label}
              >
                <tab.icon className="size-4" aria-hidden />
                <span className="hidden sm:inline">{tab.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="analyze">
            <AnalyzePanel onSaved={() => setHistoryRefreshKey((k) => k + 1)} />
          </TabsContent>
          <TabsContent value="dashboard">
            <DashboardPanel />
          </TabsContent>
          <TabsContent value="study">
            <StudyPanel />
          </TabsContent>
          <TabsContent value="history">
            <HistoryPanel refreshKey={historyRefreshKey} />
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t bg-muted/40">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground sm:px-6">
          <Newspaper className="size-3.5" aria-hidden />
          <span>NewsPulse — a study lab for news sentiment analysis</span>
          <span aria-hidden>·</span>
          <span>Powered by Edge0 models · edgezero.space API</span>
        </div>
      </footer>
    </div>
  );
}
