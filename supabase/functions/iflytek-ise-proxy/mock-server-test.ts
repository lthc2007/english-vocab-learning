// 本地联调测试：模拟讯飞 ISE WebSocket 服务，完整跑一遍 runIseEval 核心链路。
// 用法（需要 Deno）：在 supabase/functions/iflytek-ise-proxy 目录下执行
//   deno run --allow-net --allow-env mock-server-test.ts
// 不需要真实的讯飞 Key，全程本地完成。

import { runIseEval, parseIseXml, chunkAudio, buildSsbFrame, mapCategory } from "./index.ts";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xml_result><ret value="0"/>
<paper><read_sentence lan="en" total_score="86.5" accuracy_score="90.2" fluency_score="82.1" integrity_score="95.0" content="hello world" beg_pos="20" end_pos="60" is_rejected="false" except_info="0" phone_score="91.0" tone_score="88.0">
<word index="0" content="hello" total_score="92.3" beg_pos="20" end_pos="32" dp_message="0" perr_msg="0"/>
<word index="1" content="world" total_score="71.0" beg_pos="33" end_pos="60" dp_message="0" perr_msg="128"/>
</read_sentence></paper></xml_result>`;

function b64OfUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 生成 0.5 秒静音 PCM（16000 样本）
function fakePcmB64(): string {
  const pcm = new Uint8Array(16000); // 8000 个 int16 样本，全 0
  return b64OfUtf8(String.fromCharCode(...pcm));
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log("  PASS", name);
  } else {
    failed++;
    console.log("  FAIL", name, detail ?? "");
  }
}

// ── 单元测试：XML 解析 ──
console.log("[1] parseIseXml");
const parsed = parseIseXml(SAMPLE_XML);
check("total_score = 86.5", parsed.total_score === 86.5, String(parsed.total_score));
check("accuracy = 90.2 / fluency = 82.1 / integrity = 95.0",
  parsed.accuracy_score === 90.2 && parsed.fluency_score === 82.1 && parsed.integrity_score === 95.0);
check("两个单词", parsed.words.length === 2, String(parsed.words.length));
check("hello 92.3 分", parsed.words[0].content === "hello" && parsed.words[0].score === 92.3);
check("world perr_msg=128（替换）", parsed.words[1].perr_msg === 128);
check("is_rejected = false", parsed.is_rejected === false);

// 5 分制归一化：生产环境实测返回 5 分制（如 4.795254），应 ×20 归一化为百分制
const FIVE_POINT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<xml_result>
  <read_sentence lan="en" type="study" version="7.0.0.1020">
    <rec_paper>
      <read_chapter accuracy_score="4.852056" content="hello world" fluency_score="4.778588" integrity_score="5.000000" is_rejected="false" total_score="4.795254" word_count="2">
        <word beg_pos="3" content="hello" dp_message="0" total_score="4.210800"></word>
        <word beg_pos="29" content="world" dp_message="0" total_score="4.933270"></word>
      </read_chapter>
    </rec_paper>
  </read_sentence>
</xml_result>`;
const five = parseIseXml(FIVE_POINT_XML);
check("5分制总分 ×20 → 95.91", five.total_score === 95.91, String(five.total_score));
check("5分制准确度 ×20 → 97.04", five.accuracy_score === 97.04, String(five.accuracy_score));
check("5分制完整度 ×20 → 100", five.integrity_score === 100, String(five.integrity_score));
check("5分制逐词 hello ×20 → 84.22", five.words[0].score === 84.22, String(five.words[0].score));

// ── 单元测试：分帧 ──
console.log("[2] chunkAudio");
const frames = chunkAudio(fakePcmB64());
check("0.5s 音频 = 13 帧（每帧 1280 字节）", frames.length === 13, String(frames.length));
check("首帧 aus=1 status=1", frames[0].aus === 1 && frames[0].status === 1);
check("末帧 aus=4 status=2", frames[12].aus === 4 && frames[12].status === 2);

const single = chunkAudio(b64OfUtf8(String.fromCharCode(...new Uint8Array(100))));
check("单帧时 aus=4 status=2", single.length === 1 && single[0].aus === 4 && single[0].status === 2);

// ── 集成测试：模拟讯飞 WS 服务 ──
console.log("[3] runIseEval（mock 讯飞 WS）");
const port = 8765;
let receivedFrames = 0;
let receivedSsb: { category?: string; text?: string } | null = null;

const mockServer = Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.business?.cmd === "ssb") {
      receivedSsb = msg.business;
      console.log("  [mock] 收到 ssb 参数帧:", JSON.stringify(msg.business));
    }
    if (msg.business?.cmd === "auw") {
      receivedFrames++;
      if (msg.data?.status === 2) {
        console.log("  [mock] 收到末帧，回传最终结果");
        socket.send(JSON.stringify({
          code: 0, message: "success", sid: "ise_mock_001",
          data: { status: 2, data: b64OfUtf8(SAMPLE_XML) },
        }));
      }
    }
  };
  return response;
});

try {
  const result = await runIseEval(
    {
      appId: "mock_app",
      apiKey: "mock_key",
      apiSecret: "mock_secret",
      category: "read_sentence",
      text: "hello world",
      audioB64: fakePcmB64(),
    },
    `ws://127.0.0.1:${port}/v2/open-ise`,
  );
  check("mock 联调拿到总分 86.5", result.total_score === 86.5, String(result.total_score));
  check("ssb 帧文本带 BOM 且类别正确",
    receivedSsb?.category === "read_sentence" && receivedSsb?.text === "\uFEFFhello world",
    JSON.stringify(receivedSsb));
  check("mock 收到全部 13 个音频帧", receivedFrames === 13, String(receivedFrames));
} catch (e) {
  check("mock 联调无异常", false, e.message);
}

// ── 单元测试：ssb 帧结构 ──
console.log("[4] buildSsbFrame");
const ssb = JSON.parse(buildSsbFrame("app1", "read_word", "apple"));
check("ent=en_vip / aue=raw / auf=16k",
  ssb.business.ent === "en_vip" && ssb.business.aue === "raw" && ssb.business.auf === "audio/L16;rate=16000");
check("text 带 BOM", ssb.business.text === "\uFEFFapple");
check("common.app_id", ssb.common.app_id === "app1");

// ── 单元测试：read_word 映射（讯飞该类别服务端异常，统一走 read_sentence）──
console.log("[5] mapCategory");
check("read_word → read_sentence", mapCategory("read_word") === "read_sentence");
check("read_sentence → read_sentence", mapCategory("read_sentence") === "read_sentence");

mockServer.shutdown();

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) Deno.exit(1);
