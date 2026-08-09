#!/usr/bin/env python3
"""Static file server + Volcano Engine TTS proxy (v3 API).
Avoids CORS issues by proxying TTS requests through the same origin.
Supports both new console (X-Api-Key) and old console (X-Api-App-Id + X-Api-Access-Key).
Auto-detects voice model version.
"""
import http.server
import json
import os
import uuid
import urllib.request
import urllib.error

PORT = 8080
WORKSPACE = os.path.dirname(os.path.abspath(__file__))

def resolve_resource_id(voice):
    """Detect voice model version: _mars_bigtts / _moon_bigtts / _wvae_bigtts → seed-tts-1.0, everything else → seed-tts-2.0"""
    if isinstance(voice, str) and voice and (voice.endswith("_mars_bigtts") or voice.endswith("_moon_bigtts") or voice.endswith("_wvae_bigtts")):
        return "seed-tts-1.0"
    return "seed-tts-2.0"

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WORKSPACE, **kwargs)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/proxy-volcano-tts":
            self._proxy_volcano_tts()
        else:
            self.send_error(404, "Not Found")

    def _proxy_volcano_tts(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            req_data = json.loads(body)

            tts_key = req_data.get("ttsKey", "")
            tts_app_id = req_data.get("ttsAppId", "")
            tts_voice = req_data.get("ttsVoice", "zh_female_cancan_mars_bigtts")
            speak_text = req_data.get("text", "")

            if not tts_key:
                self._send_json(400, {"error": "缺少 API Key"})
                return

            api_url = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"
            req_id = str(uuid.uuid4())
            resource_id = resolve_resource_id(tts_voice)

            headers = {
                "Content-Type": "application/json",
                "X-Api-Resource-Id": resource_id,
                "X-Api-Request-Id": req_id,
            }

            if tts_app_id:
                headers["X-Api-App-Id"] = tts_app_id
                headers["X-Api-Access-Key"] = tts_key
            else:
                headers["X-Api-Key"] = tts_key

            req_body = {
                "req_params": {
                    "text": speak_text,
                    "speaker": tts_voice,
                    "audio_params": {
                        "format": "mp3",
                        "sample_rate": 24000,
                    },
                },
            }

            print(f"[TTS] Request: resource_id={resource_id}, voice={tts_voice}, text_len={len(speak_text)}")

            http_req = urllib.request.Request(
                api_url,
                data=json.dumps(req_body).encode("utf-8"),
                headers=headers,
                method="POST"
            )

            with urllib.request.urlopen(http_req, timeout=30) as resp:
                resp_text = resp.read().decode("utf-8")

            print(f"[TTS] Response len={len(resp_text)}, first 300: {resp_text[:300]}")

            # Parse SSE / Chunked stream response
            audio_chunks = []
            has_sse_audio = False

            for line in resp_text.split("\n"):
                line = line.strip()
                if line.startswith("data:"):
                    data_str = line[5:].strip()
                    if data_str == "[DONE]":
                        continue
                    try:
                        data = json.loads(data_str)
                        # v3 API returns audio in the "data" field (not "audio")
                        if isinstance(data.get("data"), str) and len(data["data"]) > 100:
                            audio_chunks.append(data["data"])
                            has_sse_audio = True
                        # Error: non-zero code that is not 20000000 (OK)
                        code = data.get("code")
                        if code and code != 0 and code != 20000000:
                            err_msg = data.get("message") or f"code={code}"
                            self._send_json(500, {"error": f"火山引擎错误(code={code}): {err_msg}"})
                            return
                    except json.JSONDecodeError:
                        pass

            # Fallback: try Chunked format (newline-delimited JSON)
            if not has_sse_audio and not audio_chunks:
                for line in resp_text.split("\n"):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        if isinstance(data.get("data"), str) and len(data["data"]) > 100:
                            audio_chunks.append(data["data"])
                        code = data.get("code")
                        if code and code != 0 and code != 20000000:
                            err_msg = data.get("message") or f"code={code}"
                            self._send_json(500, {"error": f"火山引擎错误(code={code}): {err_msg}"})
                            return
                    except json.JSONDecodeError:
                        pass

            audio_base64 = "".join(audio_chunks)
            print(f"[TTS] Audio chunks: {len(audio_chunks)}, base64 len: {len(audio_base64)}")

            if not audio_base64:
                self._send_json(500, {
                    "error": "火山引擎返回空音频",
                    "debug": {
                        "resourceId": resource_id,
                        "voice": tts_voice,
                        "textLen": len(speak_text),
                        "responseLen": len(resp_text),
                        "responsePreview": resp_text[:300],
                    }
                })
                return

            self._send_json(200, {"audio": audio_base64})

        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            print(f"[TTS] HTTP error {e.code}: {err_body[:300]}")
            self._send_json(e.code, {"error": f"火山引擎 HTTP {e.code}: {err_body[:300]}"})
        except Exception as e:
            print(f"[TTS] Exception: {e}")
            self._send_json(500, {"error": str(e)})

    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        if "/api/" in str(args[0]):
            super().log_message(format, *args)


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print(f"Server running at http://localhost:{PORT}/")
    print(f"  - Static files: /english-vocab-learning.html")
    print(f"  - TTS Proxy:    POST /api/proxy-volcano-tts")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()