// ================================================================
// EDGE FUNCTION: ig-scheduler
// Roda no Supabase (gratuito, 24/7, sem Mac)
// Chamada via cron a cada 1 minuto pelo Supabase Scheduler
// ================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_TOKEN = Deno.env.get("FACEBOOK_ACCESS_TOKEN")!;
const IG_ID = Deno.env.get("IG_ACCOUNT_ID") || "17841410457949155";
const GRAPH = "https://graph.facebook.com/v21.0";

Deno.serve(async (req) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const now = new Date().toISOString();

    // Busca posts pendentes que já passaram do horário
    const { data: posts, error } = await sb
      .from("ig_scheduled_posts")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(5);

    if (error) throw new Error(error.message);
    if (!posts || posts.length === 0) {
      return new Response(JSON.stringify({ ok: true, published: 0, message: "Nenhum post pendente" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const results = [];

    for (const post of posts) {
      // Marca como publishing
      await sb.from("ig_scheduled_posts").update({ status: "publishing" }).eq("id", post.id);

      try {
        const publishedId = await publishPost(post);
        await sb.from("ig_scheduled_posts").update({
          status: "published",
          published_id: publishedId,
          published_at: new Date().toISOString(),
        }).eq("id", post.id);
        results.push({ id: post.id, status: "published", publishedId });
      } catch (e) {
        await sb.from("ig_scheduled_posts").update({
          status: "error",
          error: (e as Error).message,
        }).eq("id", post.id);
        results.push({ id: post.id, status: "error", error: (e as Error).message });
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 3000));
    }

    return new Response(JSON.stringify({ ok: true, published: results.filter(r => r.status === "published").length, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ================================================================
// PUBLICAR POST NO INSTAGRAM
// ================================================================
async function publishPost(post: any): Promise<string> {
  if (!META_TOKEN) throw new Error("FACEBOOK_ACCESS_TOKEN não configurado");

  const { type, media_url, caption, hashtags } = post;
  const fullCaption = [caption, hashtags].filter(Boolean).join("\n\n");

  // Step 1: Criar container
  let params = "";
  if (type === "feed") {
    params = `image_url=${encodeURIComponent(media_url)}&caption=${encodeURIComponent(fullCaption)}`;
  } else if (type === "story") {
    const isVideo = media_url.match(/\.(mp4|mov|webm)/i);
    const mediaParam = isVideo ? "video_url" : "image_url";
    params = `${mediaParam}=${encodeURIComponent(media_url)}&media_type=STORIES`;
    if (fullCaption) params += `&caption=${encodeURIComponent(fullCaption)}`;
  } else if (type === "reel") {
    params = `video_url=${encodeURIComponent(media_url)}&media_type=REELS&caption=${encodeURIComponent(fullCaption)}&share_to_feed=true`;
  }

  const containerRes = await fetch(`${GRAPH}/${IG_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `${params}&access_token=${META_TOKEN}`,
  });
  const containerData = await containerRes.json();
  if (containerData.error) throw new Error(containerData.error.message);
  if (!containerData.id) throw new Error("Container sem ID");

  // Step 2: Aguardar processamento (vídeos)
  if (type === "reel" || type === "story") {
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const chk = await fetch(`${GRAPH}/${containerData.id}?fields=status_code&access_token=${META_TOKEN}`);
      const chkData = await chk.json();
      if (chkData.status_code === "FINISHED") break;
      if (chkData.status_code === "ERROR") throw new Error("Processamento falhou");
    }
  } else {
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Step 3: Publicar
  const pubRes = await fetch(`${GRAPH}/${IG_ID}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `creation_id=${containerData.id}&access_token=${META_TOKEN}`,
  });
  const pubData = await pubRes.json();
  if (pubData.error) throw new Error(pubData.error.message);

  return pubData.id;
}
