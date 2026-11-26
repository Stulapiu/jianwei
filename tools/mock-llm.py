# -*- coding: utf-8 -*-
"""本地假模型：只为了验证"AI 真的参与了判定"这条链路，不产生任何真实判断。

跑法：python tools/mock-llm.py    （监听 8787，和 server/proxy.mjs 同一个地址）
用来在没网、没密钥的情况下，看前端拿到模型返回之后长什么样。
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

JUDGE = {
    "seen": "夜里一根灯杆，灯头是暗的，旁边没有别的东西",
    "pass": True,
    "reason": None,
    "type": "lighting",
    "desc": "路灯不亮，整段路没有照明",
    "conflict": False,
    "conflictNote": "",
    "severity": 3,
    "summary": "路灯灯头不亮，夜间通行有踩空和被撞风险",
    "advice": "水电班组带灯具和升降梯到场，先测镇流器再换灯头",
    "detail": "画面主体是路灯灯杆，灯头无光"
}

PREVIEW = {"isFacility": True, "type": "lighting", "desc": "某处路灯不亮，夜间没有照明", "confidence": 0.82}


class H(BaseHTTPRequestHandler):
    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            self._json({"ok": True, "model": "mock-deepseek", "vision": True, "hasKey": True})
        else:
            self._json({"ok": False})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n).decode('utf-8', 'ignore')
        try:
            req = json.loads(raw)
        except Exception:
            req = {}
        sys_txt = ''
        for m in req.get('messages', []):
            if m.get('role') == 'system':
                sys_txt = m.get('content') or ''
        payload = PREVIEW if ('预判' in sys_txt or 'preview' in sys_txt.lower()) else JUDGE
        self._json({"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    print('mock llm on http://127.0.0.1:8787')
    HTTPServer(('127.0.0.1', 8787), H).serve_forever()
