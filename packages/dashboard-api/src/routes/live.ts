import type { FastifyPluginAsync } from "fastify";
import type { LiveFeed } from "../liveFeed.ts";
import type { OverviewCache } from "../overviewCache.ts";

interface LiveDeps {
  feed: LiveFeed;
  overviews: OverviewCache;
  overviewEveryMs: number;
}

/** A browser that stops reading this far behind is dropped rather than buffered forever. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * GET /api/games/:gameId/live: a Server-Sent Events stream.
 *
 * SSE is a long-lived HTTP response that the server keeps writing to, in a
 * plain-text format the browser's EventSource parses:
 *
 *   event: game_event
 *   data: {"event_id":"...","type":"purchase",...}
 *   <blank line>
 *
 * Sent: the game's recent events, then each new one as it arrives
 * ("game_event"), and the headline numbers now and every few seconds
 * ("overview"). The overview doubles as a keep-alive, so proxies don't close the
 * connection as idle.
 */
export const liveRoutes: FastifyPluginAsync<LiveDeps> = async (app, { feed, overviews, overviewEveryMs }) => {
  // A stream never ends by itself, so server shutdown would wait on it forever.
  // End them all first; EventSource reconnects on its own once we're back.
  const open = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of open) end();
  });

  app.get<{ Params: { gameId: string } }>("/api/games/:gameId/live", (req, reply) => {
    const { gameId } = req.params;
    // From here on we write the raw response ourselves; Fastify won't touch it.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stops nginx-style proxies from buffering the stream into big chunks.
      "x-accel-buffering": "no",
    });
    // How long EventSource waits before reconnecting after a drop.
    res.write("retry: 3000\n\n");

    let ended = false;
    const timer = setInterval(() => void pushOverview(), overviewEveryMs);
    let unsubscribe = (): void => {};
    function end(): void {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      unsubscribe();
      open.delete(end);
      res.end();
    }

    function send(event: string, data: unknown): void {
      if (ended) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        req.log.warn({ gameId }, "live client too slow, dropping it");
        end();
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    async function pushOverview(): Promise<void> {
      try {
        send("overview", await overviews.get(gameId));
      } catch (err) {
        req.log.warn({ err, gameId }, "overview query failed");
      }
    }

    open.add(end);
    // The browser went away (tab closed, network dropped).
    res.on("close", end);
    for (const event of feed.recentEvents(gameId)) send("game_event", event);
    if (ended) return;
    unsubscribe = feed.subscribe(gameId, (event) => send("game_event", event));
    void pushOverview();
  });
};
