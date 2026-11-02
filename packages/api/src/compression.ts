import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { FastifyInstance } from "fastify";

/**
 * Accepts gzip request bodies (Roblox's HttpService can compress them). JSON
 * events are repetitive, so a batch shrinks to roughly a fifth of its size: less
 * of the game server's bandwidth, and faster uploads on slow links.
 *
 * The decompressed stream is what Fastify parses, so the app's bodyLimit applies
 * to the *decompressed* size. That's the defence against a "zip bomb": a few KB
 * of gzip that expands to gigabytes is cut off at 1 MiB with a 413.
 */
export function registerGzipBodies(app: FastifyInstance): void {
  app.addHook("preParsing", async (req, _reply, payload) => {
    const encoding = req.headers["content-encoding"]?.toLowerCase();
    if (!encoding || encoding === "identity") return payload;
    if (encoding !== "gzip") {
      throw Object.assign(new Error(`Unsupported Content-Encoding "${encoding}"; use gzip`), {
        statusCode: 415,
        code: "unsupported_encoding",
      });
    }

    // Fastify checks the bytes it reads against Content-Length. After
    // decompression those differ, so tell it how many compressed bytes came in.
    const gunzip = Object.assign(createGunzip(), { receivedEncodedLength: 0 });
    payload.on("data", (chunk: Buffer) => {
      gunzip.receivedEncodedLength += chunk.length;
    });
    payload.on("error", (err) => gunzip.destroy(err));
    // Corrupt gzip is the client's fault: 400, not 500.
    gunzip.on("error", (err) => {
      Object.assign(err, { statusCode: 400, code: "invalid_gzip" });
    });
    return payload.pipe(gunzip) as Readable;
  });
}
