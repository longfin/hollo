import {
  Article,
  Note,
  // biome-ignore lint/suspicious/noShadowRestrictedNames: Activity Vocabulary
  type Object,
  isActor,
  lookupObject,
} from "@fedify/fedify";
import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import { desc, eq, inArray, or } from "drizzle-orm";
import { Hono } from "hono";
import { type Hits, MeiliSearchCommunicationError } from "meilisearch";
import { z } from "zod";
import { db } from "../../db";
import { serializeAccount } from "../../entities/account";
import { getPostRelations, serializePost } from "../../entities/status";
import { federation } from "../../federation";
import { persistAccount } from "../../federation/account";
import { persistPost } from "../../federation/post";
import { type Variables, scopeRequired, tokenRequired } from "../../oauth";
import { type Account, accounts, posts } from "../../schema";
import search from "../../search";
import { postMedia } from "../v1/media";
import instance from "./instance";

const app = new Hono<{ Variables: Variables }>();

app.route("/instance", instance);

app.post("/media", tokenRequired, scopeRequired(["write:media"]), postMedia);

app.get(
  "/search",
  tokenRequired,
  scopeRequired(["read:search"]),
  zValidator(
    "query",
    z.object({
      q: z.string(),
      type: z.enum(["accounts", "hashtags", "statuses"]).optional(),
      resolve: z.enum(["true", "false"]).default("false"),
      following: z.enum(["true", "false"]).default("false"),
      account_id: z.string().optional(),
      limit: z
        .string()
        .regex(/\d+/)
        .default("20")
        .transform((v) => Number.parseInt(v)),
      offset: z
        .string()
        .regex(/\d+/)
        .default("0")
        .transform((v) => Number.parseInt(v)),
    }),
  ),
  async (c) => {
    const logger = getLogger(["hollo", "api", "v2", "search"]);
    const owner = c.get("token").accountOwner;
    if (owner == null) return c.json({ error: "invalid_token" }, 401);
    const query = c.req.valid("query");
    const q = query.q.trim();
    const users =
      query.offset < 1
        ? await db.query.accounts.findMany({
            where: or(
              eq(accounts.iri, q),
              eq(accounts.url, q),
              eq(accounts.handle, q),
              eq(accounts.handle, `@${q}`),
            ),
          })
        : [];
    const statuses =
      query.offset < 1
        ? await db.query.posts.findMany({
            where: or(eq(posts.iri, q), eq(posts.url, q)),
            with: getPostRelations(owner.id),
          })
        : [];
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const options = {
      documentLoader: await fedCtx.getDocumentLoader(owner),
      contextLoader: fedCtx.contextLoader,
    };
    let resolved: Object | null = null;
    if (
      query.resolve === "true" &&
      query.offset < 1 &&
      users.length < 1 &&
      statuses.length < 1
    ) {
      try {
        resolved = await lookupObject(q, options);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        logger.warn("Failed to resolve object: {error}", { error });
      }
    }
    if (query.type == null || query.type === "accounts") {
      const { hits } = await search.index("accounts").search(q, {
        limit: query.limit,
        offset: query.offset,
      });
      if (isActor(resolved)) {
        const resolvedAccount = await persistAccount(
          db,
          search,
          resolved,
          options,
        );
        if (resolvedAccount != null) hits.unshift(resolvedAccount);
      }
      for (const hit of hits) {
        const a = hit as unknown as Account;
        if (users.some((u) => u.id === a.id)) continue;
        users.push(a);
      }
    }
    if (query.type == null || query.type === "statuses") {
      // biome-ignore lint/suspicious/noExplicitAny: MeiliSearch uses any
      let hits: Hits<Record<string, any>> | undefined;
      try {
        const result = await search.index("posts").search(q, {
          limit: query.limit,
          offset: query.offset,
          filter:
            query.account_id == null
              ? []
              : [`accountId = "${query.account_id}"`],
        });
        hits = result.hits;
      } catch (error) {
        if (!(error instanceof MeiliSearchCommunicationError)) throw error;
        logger.warn("Failed to search posts: {error}", { error });
        hits = [];
      }
      if (
        hits != null &&
        (resolved instanceof Note || resolved instanceof Article)
      ) {
        const resolvedPost = await persistPost(db, search, resolved, options);
        if (resolvedPost != null) hits.push(resolvedPost);
      }
      const result =
        hits == null || hits.length < 1
          ? []
          : await db.query.posts.findMany({
              where: inArray(
                posts.id,
                // biome-ignore lint/complexity/useLiteralKeys: tsc rants about this (TS4111)
                hits.map((hit) => hit["id"]),
              ),
              with: getPostRelations(owner.id),
              orderBy: [
                desc(eq(posts.iri, q)),
                desc(eq(posts.url, q)),
                desc(posts.published),
                desc(posts.updated),
              ],
            });
      for (const post of result) {
        if (statuses.some((s) => s.id === post.id)) continue;
        statuses.push(post);
      }
    }
    return c.json({
      accounts: users.map((u) => serializeAccount(u, c.req.url)),
      statuses: statuses.map((s) => serializePost(s, owner, c.req.url)),
      hashtags: [],
    });
  },
);

export default app;
