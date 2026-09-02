// iFlytek ISE Proxy — Supabase Edge Function
// 讯飞「语音评测（流式版）」代理：浏览器上传整段 PCM 音频，本函数连接讯飞 WebSocket
// 转发评测，解析 base64 XML 结果后返回干净 JSON。Key 全部存于服务端 Secret，不进浏览器。
//
// 所需 Secret（Supabase 控制台 → Edge Functions → Secrets）：
//   IFLYTEK_ISE_APP_ID      讯飞应用 AppID
//   IFLYTEK_ISE_API_KEY     讯飞 APIKey
//   IFLYTEK_ISE_API_SECRET  讯飞 APISecret
//   IFLYTEK_ISE_DAILY_LIMIT 全局每日调用上限（默认 500，对齐免费额度）
//   SUPABASE_SERVICE_ROLE_KEY 额度计数所需（可选，缺失时跳过计数、不做限流）

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ISE_HOST = "ise-api.xfyun.cn";
const ISE_PATH = "/v2/open-ise";
const SESSION_TIMEOUT_MS = 20000;
const MAX_AUDIO_B64_LEN = 3_000_000; // ~2.2MB PCM ≈ 70 秒，远大于单词/句子跟读
const MAX_TEXT_LEN = 1000; // 英文 read_sentence 单句上限

export interface IseEvalOptions {
  appId: string;
  apiKey: string;
  apiSecret: string;
  category: "read_word" | "read_sentence";
  text: string;
  audioB64: string;
}

export interface IseWordResult {
  content: string;
  score: number | null;
  perr_msg: number;
  dp_message: number;
}

export interface IseEvalResult {
  total_score: number;
  accuracy_score: number | null;
  fluency_score: number | null;
  integrity_score: number | null;
  is_rejected: boolean;
  except_info: number | null;
  words: IseWordResult[];
}

function b64Encode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64DecodeToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ── 鉴权：HMAC-SHA256 签名（host / date / request-line），生成带签名参数的 wss URL ──
export async function buildAuthUrl(apiKey: string, apiSecret: string, host: string = ISE_HOST): Promise<string> {
  const date = new Date().toUTCString();
  const requestLine = `GET ${ISE_PATH} HTTP/1.1`;
  const signingString = `host: ${host}\ndate: ${date}\n${requestLine}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingString));
  const signature = b64Encode(new Uint8Array(sig));

  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = b64Encode(enc.encode(authorizationOrigin));

  const url = `wss://${host}${ISE_PATH}`;
  return `${url}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(host)}`;
}

// ── 参数帧（ssb）──
export function buildSsbFrame(appId: string, category: string, text: string): string {
  return JSON.stringify({
    common: { app_id: appId },
    business: {
      cmd: "ssb",
      sub: "ise",
      ent: "en_vip",
      category,
      aue: "raw",
      auf: "audio/L16;rate=16000",
      text: "\uFEFF" + text,
      ttp_skip: true,
      rst: "entirety",
    },
    data: { status: 0 },
  });
}

// ── 音频分帧：16k/16bit 单声道 PCM，每帧 1280 字节（40ms）；首帧 aus=1，末帧 aus=4+status=2 ──
export function chunkAudio(base64Pcm: string): Array<{ aus: number; status: number; data: string }> {
  const bin = atob(base64Pcm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const FRAME_BYTES = 1280;
  const frames: Array<{ aus: number; status: number; data: string }> = [];
  for (let off = 0; off < bytes.length; off += FRAME_BYTES) {
    const chunk = bytes.subarray(off, Math.min(off + FRAME_BYTES, bytes.length));
    const isLast = off + FRAME_BYTES >= bytes.length;
    const aus = frames.length === 0 ? (isLast ? 4 : 1) : (isLast ? 4 : 2);
    const status = isLast ? 2 : 1;
    frames.push({ aus, status, data: b64Encode(chunk) });
  }
  return frames;
}

const XML_UNESCAPE: Array<[RegExp, string]> = [
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
];

function xmlUnescape(s: string): string {
  for (const [re, rep] of XML_UNESCAPE) s = s.replace(re, rep);
  return s;
}

// 当前生产环境返回 5 分制分数（如 4.795），而官方文档的评分公式与示例均为百分制。
// 实测 5 分制 × 20 与百分制公式完全吻合（总分 = (0.6*准确+0.3*流利+0.1*标准)*完整度）。
// 总分 ≤ 5 时统一 ×20 归一化为百分制，保证前端 0-100 阈值语义一致。
function normalizeScore(v: number | null): number | null {
  if (v === null) return null;
  if (v <= 5) return Math.round(v * 20 * 100) / 100;
  return v;
}

// ── 解析讯飞返回的 base64 XML（默认维度：总分 + 三维度 + 逐词分数）──
export function parseIseXml(xml: string): IseEvalResult {
  const num = (name: string): number | null => {
    const m = xml.match(new RegExp(name + '\\s*=\\s*"([\\d.]+)"', "i"));
    return m ? parseFloat(m[1]) : null;
  };
  const tagAttr = (tag: string, name: string): string => {
    const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', "i"));
    return m ? m[1] : "";
  };

  const total = num("total_score");
  const exceptInfo = num("except_info");
  if (total === null) {
    if (exceptInfo === 28673 || exceptInfo === 28689) {
      throw new Error("未检测到有效语音，请检查麦克风并靠近一点再试");
    }
    throw new Error("讯飞未返回评分结果（可能是音频格式或录音质量问题）");
  }

  const words: IseWordResult[] = [];
  const wordTags = xml.match(/<word\b[^>]*>/g);
  if (wordTags) {
    for (const tag of wordTags) {
      const scoreRaw = tagAttr(tag, "total_score");
      words.push({
        content: xmlUnescape(tagAttr(tag, "content")),
        score: scoreRaw ? parseFloat(scoreRaw) : null,
        perr_msg: parseInt(tagAttr(tag, "perr_msg") || "0", 10) || 0,
        dp_message: parseInt(tagAttr(tag, "dp_message") || "0", 10) || 0,
      });
    }
  }

  return {
    total_score: normalizeScore(total)!,
    accuracy_score: normalizeScore(num("accuracy_score")),
    fluency_score: normalizeScore(num("fluency_score")),
    integrity_score: normalizeScore(num("integrity_score")),
    is_rejected: /is_rejected="true"/i.test(xml),
    except_info: exceptInfo,
    words: words.map((w) => ({ ...w, score: normalizeScore(w.score) })),
  };
}

// 讯飞 read_word 类别在当前生产服务不可用（2026-09 实测）：
// 文本随 ssb 发送时稳定返回 48195（试题格式错误），走 ttp 阶段则服务端直接 panic（30012）。
// 而 read_sentence 对单个单词同样返回完整的逐词/音节/音素评分（实测 "wonderful" 单词成功），
// 因此单词跟读统一映射为 read_sentence。讯飞修复后可在此处恢复。
export function mapCategory(requested: string): "read_word" | "read_sentence" {
  return "read_sentence";
}

// ── 讯飞错误码 → 用户可读提示 ──
function makeIseError(code: number, message?: string): Error {
  const known: Record<number, string> = {
    11201: "今日评测额度已用完，请明天再试",
    11200: "评测服务未授权，请在讯飞控制台开通「语音评测（流式版）」",
    10313: "讯飞 AppID 与 APIKey 不匹配，请检查 Secret 配置",
    10114: "评测会话超时（音频过长）",
    60114: "音频过长，请缩短录音时间",
    68676: "未识别到有效语音（乱说）",
    68675: "音频格式异常（需要 16kHz / 16bit / 单声道）",
    48195: "讯飞评测请求格式异常（试题格式错误）",
    10163: "请求参数校验失败",
    10160: "非法 JSON 帧",
    10161: "音频 base64 解码失败",
    10200: "评测服务等待超时",
    10043: "音频解码失败",
    40007: "音频解码失败",
    40037: "缺少评测文本",
    40038: "缺少评测音频",
  };
  const suffix = `（讯飞错误码 ${code}${message ? ": " + message : ""}）`;
  return new Error((known[code] || "讯飞评测失败") + suffix);
}

// ── 每日额度计数：调用 Postgres RPC 原子递增；Secret 缺失时跳过（fail-open）──
async function checkDailyQuota(): Promise<{ allowed: boolean; used: number; limit: number }> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const limit = parseInt(Deno.env.get("IFLYTEK_ISE_DAILY_LIMIT") || "500", 10);
  if (!url || !key) {
    console.warn("IFLYTEK_ISE: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置，跳过额度检查");
    return { allowed: true, used: 0, limit };
  }
  try {
    const resp = await fetch(`${url}/rest/v1/rpc/increment_ise_usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_day: new Date().toISOString().slice(0, 10), p_limit: limit }),
    });
    if (!resp.ok) {
      console.warn("IFLYTEK_ISE: 额度 RPC 失败（可能未执行 ise_usage.sql）:", resp.status);
      return { allowed: true, used: 0, limit };
    }
    const rows = await resp.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row.used !== "number") return { allowed: true, used: 0, limit };
    return { allowed: !!row.allowed, used: row.used, limit };
  } catch (e) {
    console.warn("IFLYTEK_ISE: 额度检查异常:", e.message);
    return { allowed: true, used: 0, limit };
  }
}

// ── 核心：连接讯飞 WS，转发参数帧与音频帧，等待最终结果 ──
export async function runIseEval(opts: IseEvalOptions, customWsUrl?: string): Promise<IseEvalResult> {
  const wsUrl = customWsUrl || await buildAuthUrl(opts.apiKey, opts.apiSecret);
  const frames = chunkAudio(opts.audioB64);
  if (frames.length === 0) throw new Error("音频为空");

  return new Promise<IseEvalResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      fn();
    };

    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(
      () => finish(() => reject(new Error("评测超时（" + SESSION_TIMEOUT_MS / 1000 + " 秒无结果），请重试"))),
      SESSION_TIMEOUT_MS,
    );

    ws.onopen = () => {
      try {
        ws.send(buildSsbFrame(opts.appId, opts.category, opts.text));
        for (const f of frames) {
          ws.send(JSON.stringify({
            business: { cmd: "auw", aus: f.aus },
            data: { status: f.status, data: f.data },
          }));
        }
        console.log("IFLYTEK_ISE: 已发送", frames.length, "个音频帧, text:", opts.text.substring(0, 60));
      } catch (e) {
        finish(() => reject(new Error("发送评测数据失败: " + e.message)));
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: { code?: number; message?: string; sid?: string; data?: { status?: number; data?: string } };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return; // 忽略无法解析的帧
      }
      if (typeof msg.code === "number" && msg.code !== 0) {
        finish(() => reject(makeIseError(msg.code!, msg.message)));
        return;
      }
      const d = msg.data;
      if (d && d.status === 2) {
        if (!d.data) {
          finish(() => reject(new Error("讯飞未返回评测结果，请重试")));
          return;
        }
        try {
          const xml = b64DecodeToUtf8(d.data);
          console.log("IFLYTEK_ISE: 收到最终结果 XML（前 300 字符）:", xml.substring(0, 300));
          const parsed = parseIseXml(xml);
          finish(() => resolve(parsed));
        } catch (e) {
          finish(() => reject(new Error("解析评测结果失败: " + e.message)));
        }
      }
    };

    ws.onerror = () => finish(() => reject(new Error("连接讯飞评测服务失败，请检查网络或稍后重试")));
    ws.onclose = () => finish(() => reject(new Error("讯飞连接已关闭，请重试")));
  });
}

// ── HTTP 入口 ──
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let body: { text?: unknown; category?: unknown; audio?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "请求体不是合法 JSON" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
      });
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const category = mapCategory(typeof body.category === "string" ? body.category : "");
    const audio = typeof body.audio === "string" ? body.audio : "";

    if (!text) {
      return new Response(JSON.stringify({ error: "缺少评测文本" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
      });
    }
    if (text.length > MAX_TEXT_LEN) {
      return new Response(JSON.stringify({ error: "评测文本过长" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
      });
    }
    if (!audio || audio.length < 100) {
      return new Response(JSON.stringify({ error: "缺少录音音频" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
      });
    }
    if (audio.length > MAX_AUDIO_B64_LEN) {
      return new Response(JSON.stringify({ error: "录音过长（超过 60 秒）" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
      });
    }

    const appId = Deno.env.get("IFLYTEK_ISE_APP_ID");
    const apiKey = Deno.env.get("IFLYTEK_ISE_API_KEY");
    const apiSecret = Deno.env.get("IFLYTEK_ISE_API_SECRET");
    if (!appId || !apiKey || !apiSecret) {
      console.error("IFLYTEK_ISE: Secret 未配置");
      return new Response(JSON.stringify({ error: "口语评测尚未开通（服务端未配置讯飞 Secret），请稍后再试" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 503,
      });
    }

    const quota = await checkDailyQuota();
    if (!quota.allowed) {
      return new Response(JSON.stringify({
        error: `今日评测次数已达上限（${quota.limit} 次/天），请明天再来`,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 429,
      });
    }

    const result = await runIseEval({
      appId, apiKey, apiSecret, category, text, audioB64: audio,
    });

    return new Response(JSON.stringify({ ...result, quota: { used: quota.used, limit: quota.limit } }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("IFLYTEK_ISE: 评测失败:", e.message);
    return new Response(JSON.stringify({ error: e.message || "评测失败" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
    });
  }
}

if (import.meta.main) {
  serve(handler);
}
