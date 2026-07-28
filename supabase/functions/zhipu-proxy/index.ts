// Supabase Edge Function: 智谱 AI 代理
// 将前端请求转发到智谱 API，API Key 存储在 Supabase Secrets 中

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4";

Deno.serve(async (req: Request) => {
  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const body = await req.json();
    const { model, messages, stream, temperature, max_tokens } = body;

    const apiKey = Deno.env.get("ZHIPU_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "服务端 API Key 未配置" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 构建转发请求体
    const forwardBody: Record<string, unknown> = {
      model: model || "glm-4.7-flash",
      messages,
      stream: stream || false,
    };
    if (temperature !== undefined) forwardBody.temperature = temperature;
    if (max_tokens !== undefined) forwardBody.max_tokens = max_tokens;

    const response = await fetch(`${ZHIPU_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let zhipuError: { error?: { message?: string; code?: string } } = {};
      try { zhipuError = JSON.parse(errorText); } catch (_) { /* raw text */ }
      // 保留智谱原始错误结构，前端可直接通过 error.message 读取
      return new Response(
        JSON.stringify({
          error: zhipuError.error || { message: `智谱 API 错误 (${response.status}): ${errorText}` }
        }),
        {
          status: response.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    // 非流式响应：直接返回 JSON
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: msg }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }
    );
  }
});
