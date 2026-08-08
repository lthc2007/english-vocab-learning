#!/usr/bin/env python3
"""Static file server + Volcano Engine TTS proxy (v3 API).
Avoids CORS issues by proxying TTS requests through the same origin.
Supports both new console (X-Api-Key) and old console (X-Api-App-Id + X-Api-Access-Key).
"""
import http.server
import json
import os
import uuid
import urllib.request
import urllib.error

PORT = 8080
WORKSPACE = os.path.dirname(os.path.abspath(__file__))

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WORKSPACE, **kwargs)

    def do_OPTIONS(self):
        """Handle CORS preflight for the proxy endpoint."""
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

            # Build auth headers: prefer new console (X-Api-Key), fallback to old console
            headers = {
                "Content-Type": "application/json",
                "X-Api-Resource-Id": "seed-tts-2.0",
                "X-Api-Request-Id": req_id,
            }

            if tts_app_id:
                # Old console: use App ID + Access Token
                headers["X-Api-App-Id"] = tts_app_id
                headers["X-Api-Access-Key"] = tts_key
            else:
                # New console: use API Key
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

            http_req = urllib.request.Request(
                api_url,
                data=json.dumps(req_body).encode("utf-8"),
                headers=headers,
                method="POST"
            )

            with urllib.request.urlopen(http_req, timeout=30) as resp:
                resp_text = resp.read().decode("utf-8")

            # Parse SSE stream response, collect audio chunks
            audio_chunks = []
            for line in resp_text.split("\n"):
                line = line.strip()
                if line.startswith("data:"):
                    try:
                        data = json.loads(line[5:].strip())
                        if data.get("audio"):
                            audio_chunks.append(data["audio"])
                        if data.get("error"):
                            self._send_json(500, {"error": f"火山引擎返回错误: {json.dumps(data['error'])}"})
                            return
                    except json.JSONDecodeError:
                        pass  # skip unparseable data lines

            audio_base64 = "".join(audio_chunks)

            if not audio_base64:
                self._send_json(500, {"error": "火山引擎返回空音频"})
                return

            self._send_json(200, {"audio": audio_base64})

        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            self._send_json(e.code, {"error": f"火山引擎 HTTP {e.code}: {err_body[:300]}"})
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        # Suppress log noise for static files
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