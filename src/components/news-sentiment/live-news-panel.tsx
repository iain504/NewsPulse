"use client";

import * as React from "react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { format } from "date-fns";
import {
  Calendar,
  CircleAlert,
  ExternalLink,
  Globe,
  Inbox,
  Loader2,
  Newspaper,
  Plus,
  RefreshCw,
  Rss,
  Sparkles,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ArticleContent, FollowedTopic, NewsItem } from "@/lib/types";
import { fetchJSON } from "@/lib/sse-client";

interface LiveNewsPanelProps {
  /** Called when the user wants to analyze a feed article. Page switches to Analyze tab. */
  onAnalyzeArticle: (req: { title: string; source: string; text: string }) => void;
}

const TOPIC_SUGGESTIONS = ["Markets", "Technology", "Energy", "Football", "Crypto", "Climate"];

/** Best-effort date label: pretty-print parseable dates, pass anything else through. */
function formatFeedDate(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : format(d, "MMM d, yyyy");
}

export function LiveNewsPanel({ onAnalyzeArticle }: LiveNewsPanelProps) {
  const [topics, setTopics] = React.useState<FollowedTopic[]>([]);
  const [topicsLoading, setTopicsLoading] = React.useState(true);
  const [selectedTopicId, setSelectedTopicId] = React.useState<string | null>(null);

  const [newTopic, setNewTopic] = React.useState("");
  const [followBusy, setFollowBusy] = React.useState(false);
  const [addingName, setAddingName] = React.useState<string | null>(null);
  const [removingId, setRemovingId] = React.useState<string | null>(null);

  const [feed, setFeed] = React.useState<NewsItem[]>([]);
  const [feedLoading, setFeedLoading] = React.useState(false);
  const [feedError, setFeedError] = React.useState<string | null>(null);
  const [fetchingId, setFetchingId] = React.useState<string | null>(null);

  /** Bumped on every feed request so out-of-order responses can't overwrite a newer feed. */
  const feedReqRef = React.useRef(0);

  const selectedTopic = topics.find((t) => t.id === selectedTopicId) ?? null;

  const loadFeed = React.useCallback(async (topicName: string) => {
    const reqId = ++feedReqRef.current;
    setFeedLoading(true);
    setFeedError(null);
    setFeed([]);
    try {
      const res = await fetchJSON<{ ok: boolean; topic: string; results: NewsItem[] }>(
        "/api/news/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: topicName, count: 10 }),
        }
      );
      if (reqId !== feedReqRef.current) return;
      setFeed(Array.isArray(res.results) ? res.results : []);
    } catch (err) {
      if (reqId !== feedReqRef.current) return;
      const message = err instanceof Error ? err.message : "Unknown error";
      setFeedError(message);
      toast.error("News search failed", { description: message });
    } finally {
      if (reqId === feedReqRef.current) setFeedLoading(false);
    }
  }, []);

  // On mount: load followed topics, then auto-select the first one and load its feed.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchJSON<{ ok: boolean; topics: FollowedTopic[] }>("/api/topics");
        if (cancelled) return;
        const list = Array.isArray(res.topics) ? res.topics : [];
        setTopics(list);
        if (list.length > 0) {
          setSelectedTopicId(list[0].id);
          void loadFeed(list[0].name);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error("Failed to load topics", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        }
      } finally {
        if (!cancelled) setTopicsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFeed]);

  async function followTopic(name: string): Promise<FollowedTopic | null> {
    const res = await fetchJSON<{ ok: boolean; topic: FollowedTopic }>("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return res.topic ?? null;
  }

  /** Refresh the topic list from the server (POST is an upsert, so this also dedupes). */
  async function refetchTopics(): Promise<FollowedTopic[]> {
    const res = await fetchJSON<{ ok: boolean; topics: FollowedTopic[] }>("/api/topics");
    const list = Array.isArray(res.topics) ? res.topics : [];
    setTopics(list);
    return list;
  }

  function handleSelect(topic: FollowedTopic) {
    if (topic.id === selectedTopicId) return;
    setSelectedTopicId(topic.id);
    void loadFeed(topic.name);
  }

  async function handleFollowSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = newTopic.trim();
    if (!name) {
      toast.error("Type a topic first", { description: "For example: electric vehicles" });
      return;
    }
    if (followBusy) return;
    setFollowBusy(true);
    try {
      const topic = await followTopic(name);
      const list = await refetchTopics();
      setNewTopic("");
      const target = (topic && list.find((t) => t.id === topic.id)) || topic;
      if (target) {
        setSelectedTopicId(target.id);
        void loadFeed(target.name);
      }
      toast.success(`Following "${name}"`);
    } catch (err) {
      toast.error("Could not follow topic", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setFollowBusy(false);
    }
  }

  async function handleSuggestion(name: string) {
    if (addingName) return;
    const existing = topics.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      handleSelect(existing);
      return;
    }
    setAddingName(name);
    try {
      const topic = await followTopic(name);
      await refetchTopics();
      if (topic) {
        setSelectedTopicId(topic.id);
        void loadFeed(topic.name);
      }
    } catch (err) {
      toast.error("Could not follow topic", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setAddingName(null);
    }
  }

  async function handleUnfollow(topic: FollowedTopic) {
    const prev = topics;
    const next = prev.filter((t) => t.id !== topic.id);
    setTopics(next); // optimistic removal
    setRemovingId(topic.id);
    try {
      await fetchJSON<{ ok: boolean }>(`/api/topics?id=${encodeURIComponent(topic.id)}`, {
        method: "DELETE",
      });
      if (selectedTopicId === topic.id) {
        if (next.length > 0) {
          setSelectedTopicId(next[0].id);
          void loadFeed(next[0].name);
        } else {
          feedReqRef.current += 1; // cancel any in-flight feed load
          setSelectedTopicId(null);
          setFeed([]);
          setFeedError(null);
          setFeedLoading(false);
        }
      }
    } catch (err) {
      setTopics(prev); // restore on failure
      toast.error("Could not unfollow topic", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRemovingId(null);
    }
  }

  /** Fetch the full article text and hand it to the Analyze tab. */
  async function handleAnalyze(item: NewsItem) {
    if (fetchingId) return;
    setFetchingId(item.url);
    try {
      const res = await fetchJSON<{ ok: boolean; article: ArticleContent }>("/api/news/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: item.url }),
      });
      let text = (res.article?.text ?? "").trim();
      if (text.length < 100) {
        // Hub pages with little readable text — fall back to the headline + snippet.
        const snippetText = `${item.title}. ${item.snippet}`.replace(/\s+/g, " ").trim();
        if (snippetText.length >= 20 && snippetText.length > text.length) {
          text = snippetText;
          toast.info("Used the headline snippet — the page had little readable text.");
        }
      }
      if (text.length < 20) {
        toast.error("Couldn't extract readable text from this page.");
        return;
      }
      onAnalyzeArticle({
        title: res.article?.title || item.title,
        source: item.host,
        text,
      });
    } catch (err) {
      toast.error("Could not fetch the article", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setFetchingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Topics you follow */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Rss className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
            Topics you follow
          </CardTitle>
          <CardDescription>
            Tell the lab what you care about — it finds fresh news and grades its sentiment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {topicsLoading ? (
            <div className="flex flex-wrap gap-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-24 rounded-full" />
              ))}
            </div>
          ) : topics.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No topics yet — add one below or pick a suggestion to start your feed.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {topics.map((topic) => {
                const selected = topic.id === selectedTopicId;
                return (
                  <Button
                    key={topic.id}
                    variant={selected ? "default" : "outline"}
                    size="sm"
                    className="group h-8 rounded-full gap-1.5"
                    aria-pressed={selected}
                    disabled={removingId === topic.id}
                    onClick={() => handleSelect(topic)}
                  >
                    <span className="max-w-44 truncate">{topic.name}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`Unfollow ${topic.name}`}
                      className={`-mr-1 flex size-4 items-center justify-center rounded-full transition-opacity hover:bg-foreground/10 ${
                        selected ? "opacity-80" : "opacity-0 group-hover:opacity-60"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleUnfollow(topic);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleUnfollow(topic);
                        }
                      }}
                    >
                      {removingId === topic.id ? (
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                      ) : (
                        <X className="size-3" aria-hidden />
                      )}
                    </span>
                  </Button>
                );
              })}
            </div>
          )}

          {/* Suggestions */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Suggestions:</span>
            {TOPIC_SUGGESTIONS.map((name) => {
              const followed = topics.some((t) => t.name.toLowerCase() === name.toLowerCase());
              return (
                <Button
                  key={name}
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-full gap-1.5 border-dashed text-xs"
                  disabled={addingName !== null}
                  onClick={() => void handleSuggestion(name)}
                >
                  {addingName === name ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  ) : followed ? (
                    <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
                  ) : (
                    <Plus className="size-3" aria-hidden />
                  )}
                  {name}
                </Button>
              );
            })}
          </div>

          {/* Add topic form */}
          <form onSubmit={handleFollowSubmit} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              placeholder="Add a topic, e.g. electric vehicles"
              aria-label="New topic"
              maxLength={60}
              className="sm:max-w-sm"
            />
            <Button type="submit" disabled={followBusy || !newTopic.trim()}>
              {followBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              Follow
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Feed for the selected topic */}
      {selectedTopic && (
        <Card>
          <CardHeader>
            <CardTitle className="flex min-w-0 items-center gap-2 text-base">
              <Newspaper
                className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden
              />
              <span className="truncate">Latest: {selectedTopic.name}</span>
            </CardTitle>
            <CardDescription>Recent headlines from around the web for this topic.</CardDescription>
            <CardAction>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="tabular-nums">
                  {feed.length}
                </Badge>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Refresh feed"
                  disabled={feedLoading}
                  onClick={() => void loadFeed(selectedTopic.name)}
                >
                  <RefreshCw className={feedLoading ? "animate-spin" : undefined} aria-hidden />
                </Button>
              </div>
            </CardAction>
          </CardHeader>
          <CardContent>
            {feedLoading ? (
              <div className="space-y-3" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
            ) : feedError ? (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-300 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/40">
                <CircleAlert
                  className="size-4 shrink-0 text-rose-600 dark:text-rose-400"
                  aria-hidden
                />
                <p className="min-w-0 flex-1 text-sm text-rose-700 dark:text-rose-300">
                  {feedError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadFeed(selectedTopic.name)}
                >
                  <RefreshCw aria-hidden />
                  Retry
                </Button>
              </div>
            ) : feed.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center">
                <div className="flex size-14 items-center justify-center rounded-full bg-muted">
                  <Inbox className="size-6 text-muted-foreground" aria-hidden />
                </div>
                <p className="font-medium">No fresh news found for {selectedTopic.name}</p>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Try another topic — or hit refresh in a moment.
                </p>
              </div>
            ) : (
              <motion.ul
                key={selectedTopic.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className="max-h-[36rem] space-y-3 overflow-y-auto pr-1 custom-scrollbar"
              >
                {feed.map((item) => {
                  const fetching = fetchingId === item.url;
                  const dateLabel = formatFeedDate(item.date);
                  return (
                    <li
                      key={item.url}
                      className="rounded-xl border p-4 transition-colors hover:border-zinc-300 dark:hover:border-zinc-700"
                    >
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group/title block"
                      >
                        <h4 className="line-clamp-2 font-medium leading-snug group-hover/title:underline group-hover/title:decoration-muted-foreground/50">
                          {item.title || item.url}
                          <ExternalLink
                            className="ml-1 inline size-3 align-[-1px] text-muted-foreground"
                            aria-hidden
                          />
                        </h4>
                      </a>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Globe className="size-3" aria-hidden />
                          <span className="font-medium text-foreground/80">{item.host}</span>
                        </span>
                        {dateLabel && (
                          <span className="flex items-center gap-1">
                            <Calendar className="size-3" aria-hidden />
                            {dateLabel}
                          </span>
                        )}
                      </div>
                      {item.snippet && (
                        <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
                          {item.snippet}
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          disabled={fetchingId !== null}
                          onClick={() => void handleAnalyze(item)}
                        >
                          {fetching ? (
                            <Loader2 className="animate-spin" aria-hidden />
                          ) : (
                            <Sparkles aria-hidden />
                          )}
                          {fetching ? "Fetching article…" : "Analyze sentiment"}
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <a href={item.url} target="_blank" rel="noopener noreferrer">
                            <ExternalLink aria-hidden />
                            Open source
                          </a>
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </motion.ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
