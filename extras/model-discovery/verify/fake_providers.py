# Stand-in servers for each response shape model-discovery.ts supports, so the
# plugin can be verified without any real provider being up.
#
#   :8*01/v1/models      openai shape, with llama.cpp's meta.n_ctx
#   :8*02/v1/model/info  litellm-info shape
#   :8*03/models         alcf shape (bare top-level array)
import json, sys, threading, http.server

OPENAI = {"object": "list", "data": [
    {"id": "ctx-from-meta", "meta": {"n_ctx": 65536}},
    {"id": "ctx-defaulted"},
]}
LITELLM = {"data": [
    {"model_name": "rich-model", "model_info": {
        "max_input_tokens": 200000, "max_output_tokens": 64000,
        "supports_function_calling": True, "supports_vision": True}},
]}
ALCF = [
    {"id": "bare-array-model", "display_name": "Bare Array Model",
     "capabilities": {"context_window_tokens": 262144,
                      "tool_calling": {"supported": True},
                      "input_modalities": ["text"]}},
]

def serve(port, payload, path_suffix):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            ok = self.path.rstrip("/").endswith(path_suffix)
            body = json.dumps(payload).encode() if ok else b'{"error":"not here"}'
            self.send_response(200 if ok else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *a): pass
    http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()

base = int(sys.argv[1])
for port, payload, suffix in (
    (base + 1, OPENAI, "models"),
    (base + 2, LITELLM, "model/info"),
    (base + 3, ALCF, "models"),
):
    threading.Thread(target=serve, args=(port, payload, suffix), daemon=True).start()
threading.Event().wait()
