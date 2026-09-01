// Supabase Edge Function: Mineru 文档解析代理（拍照 OCR）— 异步版
// POST /mineru-proxy        提交任务 + 上传图片，快速返回任务标识 {id, kind}
// GET  /mineru-proxy?id=&kind=   查询一次状态；done 时顺带取回 Markdown
// 异步化的原因：
//   - 边缘函数墙钟时限（免费档 150s）内做"上传+长轮询"不可靠，识别排队时常超时
//   - Supabase 出口 IP 池偶发被国内存储限流；每次查询都是新实例=新 IP，天然重试
// 双模式：
//   - 已配置 MINERU_API_TOKEN → 标准 API v4（每日 1000~2000 页免费额度，结果为 zip 需解出 full.md）
//   - 未配置 → Agent 轻量 API（免 Token，IP 限频，直接返回 markdown_url）
// 注意：OSS 预签名 URL 的签名不含 Content-Type，PUT 带该头会被 403 拒绝，必须不带。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import JSZip from "npm:jszip@3.10.1";

const MINERU_BASE = "https://mineru.net";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const API_TOKEN = Deno.env.get("MINERU_API_TOKEN") || "";
const MODE = API_TOKEN ? "standard" : "agent";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// 把异常转成友好中文（TimeoutError 尤其常见：跨境网络慢）
function errText(e: unknown): string {
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return "连接识别服务超时";
  }
  return e instanceof Error ? e.message : String(e);
}

// 带重试的 fetch：每次尝试使用全新信号；仅对瞬态错误（超时、网络失败、429、5xx）重试
async function fetchRetry(
  input: string,
  init: RequestInit,
  attempts: number,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown = new Error("request failed");
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(input, Object.assign({}, init, { signal: ctrl.signal }));
      clearTimeout(timer);
      if (resp.ok || (resp.status !== 429 && resp.status < 500)) {
        return resp; // 成功或确定的业务错误（如 403/404），不重试
      }
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
    }
    if (i < attempts - 1) await sleep(1000 * (i + 1));
  }
  throw lastError;
}

// 提交任务，返回 { batchId?, taskId?, fileUrl }
async function submitTask(): Promise<
  { batchId?: string; taskId?: string; fileUrl: string }
> {
  if (MODE === "standard") {
    const resp = await fetchRetry(`${MINERU_BASE}/api/v4/file-urls/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        files: [{ name: "photo.jpg", is_ocr: true }],
        model_version: "pipeline",
        language: "ch",
        enable_formula: false,
        enable_table: false,
      }),
    }, 2, 25000);
    const data = await resp.json().catch(() => ({})) as {
      code?: number; msg?: string;
      data?: { batch_id?: string; file_urls?: string[] };
    };
    const fileUrl = data.data?.file_urls?.[0] || "";
    const batchId = data.data?.batch_id || "";
    if (!resp.ok || !fileUrl || !batchId) {
      throw new Error(
        resp.status === 429
          ? "识别服务繁忙，请稍后重试"
          : (data.msg || `提交失败 (HTTP ${resp.status})`),
      );
    }
    return { batchId, fileUrl };
  }

  const resp = await fetchRetry(`${MINERU_BASE}/api/v1/agent/parse/file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: "photo.jpg" }),
  }, 2, 25000);
  const data = await resp.json().catch(() => ({})) as {
    code?: number; msg?: string;
    data?: { task_id?: string; file_url?: string };
  };
  const taskId = data.data?.task_id || "";
  const fileUrl = data.data?.file_url || "";
  if (!resp.ok || !taskId || !fileUrl) {
    throw new Error(
      resp.status === 429
        ? "识别服务繁忙，请稍后重试"
        : (data.msg || `提交失败 (HTTP ${resp.status})`),
    );
  }
  return { taskId, fileUrl };
}

// 上传图片到签名 URL（不能带 Content-Type）
async function uploadFile(fileUrl: string, bytes: Uint8Array) {
  const resp = await fetchRetry(fileUrl, {
    method: "PUT",
    body: bytes,
  }, 2, 45000);
  if (!resp.ok) {
    throw new Error(`上传失败 (HTTP ${resp.status})`);
  }
}

// 查询一次状态；done 时取回 Markdown。返回
//   { ok:true, done:true, markdown } | { ok:true, done:false, state } | { ok:false, error }
async function pollOnce(kind: string, id: string) {
  let state = "";
  let url = "";
  let errMsg = "";

  if (kind === "standard") {
    const resp = await fetchRetry(
      `${MINERU_BASE}/api/v4/extract-results/batch/${id}`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } },
      2,
      20000,
    );
    const data = await resp.json().catch(() => ({})) as {
      code?: number;
      data?: { extract_result?: Array<{
        state?: string; full_zip_url?: string; err_msg?: string;
      }> };
    };
    const item = data.data?.extract_result?.[0];
    state = item?.state || "";
    url = item?.full_zip_url || "";
    errMsg = item?.err_msg || "";
  } else {
    const resp = await fetchRetry(
      `${MINERU_BASE}/api/v1/agent/parse/${id}`,
      {},
      2,
      20000,
    );
    const data = await resp.json().catch(() => ({})) as {
      code?: number;
      data?: {
        state?: string; markdown_url?: string; err_msg?: string; err_code?: string;
      };
    };
    state = data.data?.state || "";
    url = data.data?.markdown_url || "";
    errMsg = data.data?.err_msg || data.data?.err_code || "";
  }

  if (state === "done") {
    if (!url) return { ok: false, error: "解析完成但缺少结果链接" };
    try {
      const markdown = await fetchMarkdown(kind, url);
      return { ok: true, done: true, markdown };
    } catch (e) {
      return { ok: false, error: `取回识别结果失败：${errText(e)}，请重试` };
    }
  }
  if (state === "failed") {
    return { ok: false, error: `识别失败：${errMsg || "未知错误"}` };
  }
  return { ok: true, done: false, state };
}

// 从结果地址取回 Markdown（标准 API 需解 zip 取 full.md）
async function fetchMarkdown(kind: string, resultUrl: string): Promise<string> {
  const resp = await fetchRetry(resultUrl, {}, 2, 45000);
  let markdown = "";
  if (kind === "agent") {
    markdown = await resp.text();
  } else {
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const zip = await JSZip.loadAsync(bytes);
    let mdFile = zip.file("full.md");
    if (!mdFile) {
      mdFile = Object.values(zip.files).find((f) => f.name.endsWith(".md"));
    }
    if (!mdFile) throw new Error("结果包中未找到 Markdown 文件");
    markdown = await mdFile.async("string");
  }
  if (!markdown || !markdown.trim()) {
    throw new Error("未识别出文字，请检查图片是否清晰后重试");
  }
  return markdown;
}

Deno.serve(async (req: Request) => {
  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  // ── 提交 + 上传 ──
  if (req.method === "POST") {
    try {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length === 0) return json({ ok: false, error: "空文件" }, 400);
      if (bytes.length > MAX_FILE_BYTES) {
        return json({ ok: false, error: "图片超过 10MB，请压缩后重试" }, 400);
      }
      const ids = await submitTask();
      await uploadFile(ids.fileUrl, bytes);
      return json({
        ok: true,
        id: ids.batchId || ids.taskId,
        kind: MODE,
        state: "submitted",
      });
    } catch (e) {
      return json({ ok: false, error: errText(e) }, 502);
    }
  }

  // ── 查询状态 ──
  if (req.method === "GET") {
    const url = new URL(req.url);
    const id = url.searchParams.get("id") || "";
    const kind = url.searchParams.get("kind") || MODE;
    if (!id) return json({ ok: false, error: "缺少任务 id" }, 400);
    try {
      const result = await pollOnce(kind, id);
      return json(result, result.ok === false ? 502 : 200);
    } catch (e) {
      return json({ ok: false, error: errText(e) }, 502);
    }
  }

  return json({ ok: false, error: "只支持 POST / GET" }, 405);
});
