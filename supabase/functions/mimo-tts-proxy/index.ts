// Supabase Edge Function: 小米 MIMO TTS 代理
// 将前端请求转发到小米 MIMO API，API Key 存储在 Supabase Secrets 中
// 内置重试机制，应对 MIMO API 间歇性 401/5xx 问题

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MIMO_API_BASE = "https://api.xiaomimimo.com/v1";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500; // 初始延迟，后续指数增长

// 带重试的 MIMO API 调用
async function callMimoAPI(apiKey: string, body: Record<string, unknown>): Promise<Response> {
  let lastError: string | null = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const isRetry = attempt > 0;

    if (isRetry) {
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // 500ms, 1000ms, 2000ms
      console.log(`MIMO API 重试第 ${attempt} 次，等待 ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await fetch(`${MIMO_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      lastStatus = response.status;

      // 2xx 成功直接返回
      if (response.ok) {
        if (isRetry) {
          console.log(`MIMO API 重试成功（第 ${attempt} 次重试）`);
        }
        return response;
      }

      // 对于 401/403/429/5xx，可以重试
      // 对于 4xx（非 401/403/429），不重试
      if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
        const errorText = await response.text();
        lastError = errorText.substring(0, 500);
        console.warn(`MIMO API 返回 ${response.status}（第 ${attempt + 1} 次尝试）: ${lastError}`);
        if (attempt < MAX_RETRIES) continue; // 重试
      } else {
        // 不可重试的错误（如 400, 404 等），直接返回
        const errorText = await response.text();
        console.error(`MIMO API 不可重试错误 ${response.status}: ${errorText.substring(0, 500)}`);
        return response;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      lastError = msg;
      console.warn(`MIMO API 网络错误（第 ${attempt + 1} 次尝试）: ${msg}`);
      if (attempt < MAX_RETRIES) continue;
    }
  }

  // 所有重试耗尽
  console.error(`MIMO API 调用失败，已重试 ${MAX_RETRIES} 次，最后状态: ${lastStatus}, 错误: ${lastError}`);
  return new Response(
    JSON.stringify({
      error: `MIMO API 调用失败（已重试 ${MAX_RETRIES} 次）: ${lastError || `HTTP ${lastStatus}`}`,
    }),
    {
      status: lastStatus || 502,
      headers: { "Content-Type": "application/json" },
    }
  );
}

Deno.serve(async (req: Request) => {
  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const body = await req.json();
    const { model, messages, audio, stream } = body;

    // 校验 API Key（在函数启动时读取，避免冷启动竞态）
    const apiKey = Deno.env.get("MIMO_API_KEY");
    if (!apiKey || apiKey.trim().length === 0) {
      console.error("MIMO_API_KEY 未配置或为空");
      return new Response(
        JSON.stringify({
          error: "服务端 MIMO API Key 未配置，请联系管理员设置 Supabase Secret: MIMO_API_KEY",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    // 构建转发请求体
    const forwardBody: Record<string, unknown> = {
      model: model || "mimo-v2.5-tts",
      messages,
      stream: stream || false,
    };
    if (audio) forwardBody.audio = audio;

    console.log("MIMO TTS proxy request:", JSON.stringify({
      model: forwardBody.model,
      msgCount: (messages as unknown[]).length,
      hasAudio: !!audio,
      apiKeyLen: apiKey.length,
    }));

    // 调用 MIMO API（带重试）
    const response = await callMimoAPI(apiKey, forwardBody);

    if (!response.ok) {
      // 重试已耗尽，返回错误给前端
      let errorBody: string;
      try {
        errorBody = await response.text();
      } catch {
        errorBody = JSON.stringify({ error: "无法读取 MIMO API 错误响应" });
      }
      console.error("MIMO TTS 最终失败:", response.status, errorBody.substring(0, 500));
      return new Response(errorBody, {
        status: response.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 成功：返回 JSON（包含 choices[0].message.audio.data）
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    console.error("MIMO TTS proxy 异常:", msg);
    return new Response(
      JSON.stringify({ error: `代理服务异常: ${msg}` }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }
    );
  }
});