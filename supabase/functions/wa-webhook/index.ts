import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Extrai dados do webhook do WaSender
    const { event, data } = body;
    if (!event || !data) {
      return new Response(JSON.stringify({ ok: true, skip: "no event/data" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Só salva eventos de mensagem recebida
    if (!event.includes("received")) {
      return new Response(JSON.stringify({ ok: true, skip: "not received event: " + event }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const msg = data.messages || data.message || data;
    if (!msg) {
      return new Response(JSON.stringify({ ok: true, skip: "no msg" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fromMe = msg.key?.fromMe || false;
    if (fromMe) {
      return new Response(JSON.stringify({ ok: true, skip: "fromMe" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const phone = msg.key?.cleanedSenderPn ||
      msg.key?.remoteJid?.replace("@s.whatsapp.net", "").replace("@g.us", "") ||
      msg.from || msg.sender || "";

    const jid = msg.key?.remoteJid || (phone ? phone + "@s.whatsapp.net" : "");

    // Ignora newsletters e mensagens sem remetente
    if (!phone || jid.includes("@newsletter")) {
      return new Response(JSON.stringify({ ok: true, skip: "newsletter or no phone" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const text = msg.messageBody || msg.body || msg.text ||
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const pushName = msg.pushName || msg.key?.senderPn || "";
    const isGroup = jid.endsWith("@g.us") || event.includes("group");

    // Detecta tipo de mídia
    let msgType = "text";
    let mediaUrl = msg.mediaUrl || msg.media?.url || null;
    let mimetype = msg.mimetype || msg.media?.mimetype || null;

    if (msg.message?.audioMessage || msg.message?.pttMessage || msg.type === "audio" || msg.type === "ptt") {
      msgType = "audio";
    } else if (msg.message?.imageMessage || msg.type === "image") {
      msgType = "image";
    } else if (msg.message?.videoMessage || msg.type === "video") {
      msgType = "video";
    } else if (msg.message?.documentMessage || msg.type === "document") {
      msgType = "document";
    }

    // Salva na tabela
    const { error } = await supabase.from("wa_inbox").insert({
      event,
      jid,
      phone,
      push_name: pushName,
      message_body: text,
      message_type: msgType,
      media_url: mediaUrl,
      mimetype,
      from_me: fromMe,
      is_group: isGroup,
      raw_payload: body,
      status: "pending",
    });

    if (error) {
      console.error("Insert error:", error);
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Webhook error:", e);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
