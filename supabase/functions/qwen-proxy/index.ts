// Supabase Edge Function: 通义千问（Qwen-Turbo）AI 代理
// 所有用户的 AI 请求统一经此代理转发到 DashScope 兼容模式接口，
// DASHSCOPE_API_KEY 存于 Supabase Secrets，不进浏览器。
//
// 与 mimo/volcano 等代理不同：本函数部署时【不要】加 --no-verify-jwt 之外的前端直连，
// 而是自行校验 Authorization Bearer 会话令牌（GoTrue /auth/v1/user），
// 未登录用户无法调用；配合 qwen_usage 表做「每用户 + 全局」每日额度计数，防止刷爆账单。
//
// 环境变量：
//   DASHSCOPE_API_KEY              必填，阿里云百炼 API Key
//   SUPABASE_URL / SUPABASE_ANON_KEY  必填，用于校验会话令牌
//   SUPABASE_SERVICE_ROLE_KEY      必填，用于额度计数 RPC（缺失时 fail-open 放行）
//   QWEN_USER_DAILY_LIMIT          每用户每日调用上限，默认 30000
//   QWEN_GLOBAL_DAILY_LIMIT        全局每日调用上限，默认 5000

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ALLOWED_MODELS = new Set(["qwen-turbo"]);
const MAX_OUTPUT_TOKENS = 7000;
const GLOBAL_USER_ID = "00000000-0000-0000-0000-000000000000";
const UPSTREAM_TIMEOUT_MS = 120000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// ── 会话令牌校验：调用 GoTrue /auth/v1/user，无效/过期返回 null ──
async function verifyUser(req: Request): Promise<{ userId: string } | null> {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!token || !url || !anonKey) return null;
  try {
    const resp = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    if (!user || typeof user.id !== "string") return null;
    return { userId: user.id };
  } catch {
    return null;
  }
}

// ── 每日额度计数：调用 Postgres RPC 原子递增；Secret 缺失/RPC 失败时放行（fail-open）──
async function incrementQuota(
  day: string,
  userId: string,
  limit: number,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.warn("QWEN: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置，跳过额度检查");
    return { allowed: true, used: 0, limit };
  }
  try {
    const resp = await fetch(`${url}/rest/v1/rpc/increment_qwen_usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ p_day: day, p_user_id: userId, p_limit: limit }),
    });
    if (!resp.ok) {
      console.warn("QWEN: 额度 RPC 失败（可能未执行 qwen_usage.sql）:", resp.status);
      return { allowed: true, used: 0, limit };
    }
    const rows = await resp.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row.used !== "number") return { allowed: true, used: 0, limit };
    return { allowed: !!row.allowed, used: row.used, limit };
  } catch (e) {
    console.warn("QWEN: 额度检查异常:", e instanceof Error ? e.message : e);
    return { allowed: true, used: 0, limit };
  }
}

Deno.serve(async (req: Request) => {
  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // 1. 会话校验：未登录直接拒绝
  const user = await verifyUser(req);
  if (!user) {
    return json(
      { error: "未登录或登录已过期，请重新登录后重试", code: "auth_required" },
      401,
    );
  }

  try {
    const body = await req.json();
    const { messages, temperature } = body;

    // 2. 模型白名单：只允许 qwen-turbo，防止调用方传贵模型
    const model = typeof body.model === "string" ? body.model : "qwen-turbo";
    if (!ALLOWED_MODELS.has(model)) {
      return json({ error: `模型 ${model} 不在白名单内，仅支持 qwen-turbo` }, 400);
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "缺少 messages 参数" }, 400);
    }

    // 3. 每日额度：先全局、后按用户；任一超限返回 429
    const day = new Date().toISOString().slice(0, 10);
    const globalLimit = parseInt(Deno.env.get("QWEN_GLOBAL_DAILY_LIMIT") || "5000", 10);
    const userLimit = parseInt(Deno.env.get("QWEN_USER_DAILY_LIMIT") || "30000", 10);
    const globalQuota = await incrementQuota(day, GLOBAL_USER_ID, globalLimit);
    if (!globalQuota.allowed) {
      return json(
        {
          error: "今日免费额度已用完，可在个人信息中配置自己的 API Key 继续使用",
          code: "quota_exceeded",
          quota: { used: globalQuota.used, limit: globalQuota.limit },
        },
        429,
      );
    }
    const userQuota = await incrementQuota(day, user.userId, userLimit);
    if (!userQuota.allowed) {
      return json(
        {
          error: "您今日的免费调用次数已用完，可在个人信息中配置自己的 API Key 继续使用",
          code: "quota_exceeded",
          quota: { used: userQuota.used, limit: userQuota.limit },
        },
        429,
      );
    }

    // 4. 构建转发请求体：max_tokens 强制钳制到 7000 以内，不支持流式
    const forwardBody: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (typeof temperature === "number") forwardBody.temperature = temperature;
    forwardBody.max_tokens = Math.min(
      typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : MAX_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS,
    );

    const apiKey = Deno.env.get("DASHSCOPE_API_KEY");
    if (!apiKey) {
      return json({ error: "服务端 API Key 未配置" }, 500);
    }

    const response = await fetch(`${DASHSCOPE_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    // 保留 DashScope 原始错误结构，前端可通过 error.message 读取
    if (!response.ok) {
      const errorText = await response.text();
      let upstreamError: { error?: unknown } = {};
      try {
        upstreamError = JSON.parse(errorText);
      } catch (_) {
        upstreamError = { error: { message: `通义 API 错误 (${response.status}): ${errorText}` } };
      }
      return json(
        upstreamError.error
          ? upstreamError
          : { error: { message: `通义 API 错误 (${response.status}): ${errorText}` } },
        response.status,
      );
    }

    const data = await response.json();
    return json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Internal server error";
    return json({ error: { message: msg } }, 500);
  }
});
