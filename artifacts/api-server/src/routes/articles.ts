import { Router, type IRouter } from "express";
import { desc, eq, ilike } from "drizzle-orm";
import { db, articlesTable } from "@workspace/db";
import {
  ListArticlesQueryParams,
  GetArticleParams,
  ListArticlesResponse,
  GetArticleResponse,
  GetFeaturedArticleResponse,
  ListTrendingArticlesResponse,
  GetBreakingNewsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/articles", async (req, res): Promise<void> => {
  const query = ListArticlesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { category, limit = 20 } = query.data;

  const articles = await db
    .select()
    .from(articlesTable)
    .where(category ? ilike(articlesTable.category, category) : undefined)
    .orderBy(desc(articlesTable.publishedAt))
    .limit(limit);

  res.json(ListArticlesResponse.parse(articles.map(a => ({
    ...a,
    publishedAt: a.publishedAt.toISOString(),
  }))));
});

router.get("/articles/featured", async (_req, res): Promise<void> => {
  const [article] = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.isFeatured, true))
    .orderBy(desc(articlesTable.publishedAt))
    .limit(1);

  if (!article) {
    res.status(404).json({ error: "No featured article found" });
    return;
  }

  res.json(GetFeaturedArticleResponse.parse({ ...article, publishedAt: article.publishedAt.toISOString() }));
});

router.get("/articles/trending", async (_req, res): Promise<void> => {
  const articles = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.isTrending, true))
    .orderBy(desc(articlesTable.viewCount))
    .limit(5);

  res.json(ListTrendingArticlesResponse.parse(articles.map(a => ({
    ...a,
    publishedAt: a.publishedAt.toISOString(),
  }))));
});

router.get("/articles/breaking", async (_req, res): Promise<void> => {
  const [article] = await db
    .select()
    .from(articlesTable)
    .orderBy(desc(articlesTable.publishedAt))
    .limit(1);

  const text = article?.title ?? "تازہ ترین خبروں کے لیے HamariNews کے ساتھ رہیں";
  res.json(GetBreakingNewsResponse.parse({ text }));
});

router.get("/articles/:id", async (req, res): Promise<void> => {
  const params = GetArticleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [article] = await db
    .select()
    .from(articlesTable)
    .where(eq(articlesTable.id, params.data.id));

  if (!article) {
    res.status(404).json({ error: "Article not found" });
    return;
  }

  res.json(GetArticleResponse.parse({ ...article, publishedAt: article.publishedAt.toISOString() }));
});

export default router;
