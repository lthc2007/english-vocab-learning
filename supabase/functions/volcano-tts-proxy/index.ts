// Volcano Engine TTS Proxy — Supabase Edge Function (v3 API)
// Proxies requests from browser to volcano TTS v3 SSE API, bypassing CORS
// Supports both new console (X-Api-Key) and old console (X-Api-App-Id + X-Api-Access-Key)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Detect voice model version: _uranus_bigtts → seed-tts-2.0, _mars_bigtts → seed-tts-1.0
function resolveResourceId(voice: string): string {
  if (voice && (voice.endsWith("_uranus_bigtts") || voice.includes("_uranus_"))) {
    return "seed-tts-2.0";
  }
  return "seed-tts-1.0";
}

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
    const resourceId = resolveResourceId(ttsVoice || "");

    // Build auth headers: prefer new console (X-Api-Key), fallback to old console
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Api-Resource-Id": resourceId,
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

    console.log("Volcano TTS v3 request:", JSON.stringify({
      url: apiUrl,
      resourceId,
      voice: ttsVoice,
      textLen: (text || "").length,
      hasAppId: !!ttsAppId,
    }));

    const resp = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Volcano TTS HTTP error:", resp.status, errText.substring(0, 500));
      return new Response(JSON.stringify({ error: `火山引擎 HTTP ${resp.status}: ${errText.substring(0, 300)}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: resp.status,
      });
    }

    // Parse SSE stream response
    const respText = await resp.text();
    console.log("Volcano TTS raw response (first 500 chars):", respText.substring(0, 500));
    console.log("Volcano TTS raw response (last 500 chars):", respText.substring(Math.max(0, respText.length - 500)));

    const audioChunks: string[] = [];
    let currentEvent = "";

    const lines = respText.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("event:")) {
        currentEvent = trimmed.substring(6).trim();
        continue;
      }

      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.substring(5).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const data = JSON.parse(dataStr);
          if (data.audio) {
            audioChunks.push(data.audio);
          }
          // Check for error: v3 API returns code + message in the data
          if (data.error || data.code) {
            const errMsg = data.message || JSON.stringify(data.error || data);
            console.error("Volcano TTS API error:", errMsg);
            return new Response(JSON.stringify({ error: `火山引擎错误(code=${data.code || '?'}): ${errMsg}` }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
              status: 500,
            });
          }
        } catch {
          // skip unparseable data lines
        }
      }
      // blank line resets event
      if (trimmed === "") {
        currentEvent = "";
      }
    }

    const audioBase64 = audioChunks.join("");

    console.log("Volcano TTS parsed audio chunks:", audioChunks.length, "total base64 length:", audioBase64.length);

    if (!audioBase64) {
      return new Response(JSON.stringify({
        error: "火山引擎返回空音频",
        debug: {
          resourceId,
          voice: ttsVoice,
          textLen: (text || "").length,
          responseLen: respText.length,
          responsePreview: respText.substring(0, 300),
        }
      }), {
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