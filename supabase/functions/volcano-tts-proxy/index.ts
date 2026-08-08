// Volcano Engine TTS Proxy — Supabase Edge Function (v3 API)
// Proxies requests from browser to volcano TTS v3 SSE API, bypassing CORS
// Supports both new console (X-Api-Key) and old console (X-Api-App-Id + X-Api-Access-Key)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { ttsKey, ttsAppId, ttsVoice, text } = await req.json();

    if (!ttsKey) {
      return new Response(JSON.stringify({ error: "缺少 API Key" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const apiUrl = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse";
    const reqId = crypto.randomUUID();

    // Build auth headers: prefer new console (X-Api-Key), fallback to old console (X-Api-App-Id + X-Api-Access-Key)
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Api-Resource-Id": "seed-tts-2.0",
      "X-Api-Request-Id": reqId,
    };

    if (ttsAppId) {
      // Old console: use App ID + Access Token
      headers["X-Api-App-Id"] = ttsAppId;
      headers["X-Api-Access-Key"] = ttsKey;
    } else {
      // New console: use API Key
      headers["X-Api-Key"] = ttsKey;
    }

    const reqBody = {
      req_params: {
        text: text || "Hello",
        speaker: ttsVoice || "zh_female_cancan_mars_bigtts",
        audio_params: {
          format: "mp3",
          sample_rate: 24000,
        },
      },
    };

    const resp = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: `火山引擎 HTTP ${resp.status}: ${errText.substring(0, 300)}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: resp.status,
      });
    }

    // Parse SSE stream response, collect audio chunks
    const respText = await resp.text();
    const audioChunks: string[] = [];

    const lines = respText.split("\n");
    for (const line of lines) {
      if (line.startsWith("data:")) {
        try {
          const data = JSON.parse(line.substring(5).trim());
          if (data.audio) {
            audioChunks.push(data.audio);
          }
          if (data.error) {
            return new Response(JSON.stringify({ error: `火山引擎返回错误: ${JSON.stringify(data.error)}` }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
              status: 500,
            });
          }
        } catch {
          // skip unparseable data lines
        }
      }
    }

    const audioBase64 = audioChunks.join("");

    if (!audioBase64) {
      return new Response(JSON.stringify({ error: "火山引擎返回空音频" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      });
    }

    return new Response(JSON.stringify({ audio: audioBase64 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});