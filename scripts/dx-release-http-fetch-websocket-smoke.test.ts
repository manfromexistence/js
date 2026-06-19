import { afterEach, expect, test } from "bun:test";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

test("release Bun handles localhost fetch bodies, headers, NO_PROXY, and WebSocket echo", async () => {
  const previousHttpProxy = process.env.HTTP_PROXY;
  const previousNoProxy = process.env.NO_PROXY;

  server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(request, { data: undefined })) {
          return undefined;
        }
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/echo") {
        return new Response(request.body, {
          headers: {
            "content-type": request.headers.get("content-type") ?? "text/plain",
            "x-method": request.method,
            "x-smoke": request.headers.get("x-smoke") ?? "missing",
          },
        });
      }
      return Response.json({
        method: request.method,
        smoke: request.headers.get("x-smoke"),
      });
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${message}`);
      },
    },
  });

  try {
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    process.env.NO_PROXY = "127.0.0.1,localhost";

    const base = `http://127.0.0.1:${server.port}`;
    const getResponse = await fetch(`${base}/headers`, { headers: { "x-smoke": "fetch" } });
    expect(await getResponse.json()).toEqual({ method: "GET", smoke: "fetch" });

    const postResponse = await fetch(`${base}/echo`, {
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain", "x-smoke": "post" },
    });
    expect(postResponse.headers.get("x-method")).toBe("POST");
    expect(postResponse.headers.get("x-smoke")).toBe("post");
    expect(await postResponse.text()).toBe("payload");

    const websocketMessage = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("websocket smoke timed out"));
      }, 5_000);
      ws.addEventListener("open", () => ws.send("hello"));
      ws.addEventListener("message", (event) => {
        clearTimeout(timeout);
        ws.close();
        resolve(String(event.data));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("websocket smoke failed"));
      });
    });
    expect(websocketMessage).toBe("echo:hello");
  } finally {
    if (previousHttpProxy === undefined) {
      delete process.env.HTTP_PROXY;
    } else {
      process.env.HTTP_PROXY = previousHttpProxy;
    }
    if (previousNoProxy === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = previousNoProxy;
    }
  }
});
