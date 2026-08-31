import { createServer, type Server } from "node:http";

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Pi Browser Fixture</title></head>
  <body>
    <main>
      <h1>Local browser fixture</h1>
      <form action="/done">
        <label for="email">Email</label>
        <input id="email" name="email" type="text">
        <label><input id="updates" name="updates" type="checkbox"> Receive updates</label>
        <label for="plan">Plan</label>
        <select id="plan" name="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select>
        <label for="colors">Colors</label>
        <select id="colors" name="colors" multiple>
          <option value="red">Red</option><option value="blue">Blue</option><option value="green">Green</option>
        </select>
        <button type="submit">Submit</button>
      </form>
      <button id="action" type="button">Run action</button>
      <button id="action-result" type="button" hidden>Action completed</button>
      <button id="reveal" type="button">Reveal details</button>
      <button id="revealed" type="button" hidden>Revealed detail</button>
      <output id="status" role="status">Ready</output>
      <section id="delayed" aria-label="Delayed content"></section>
      <a href="/done">Continue</a>
      <div style="height: 1800px" aria-hidden="true"></div>
      <button id="below-fold" type="button">Below fold</button>
      <button id="scroll-result" type="button" hidden>Scrolled viewport</button>
    </main>
    <script>
      const status = document.querySelector('#status');
      const setStatus = (value) => { status.textContent = value; };
      document.querySelector('#email').addEventListener('input', (event) => setStatus('email:' + event.target.value));
      document.querySelector('#email').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          window.location.assign('/done');
        }
      });
      document.querySelector('#updates').addEventListener('change', (event) => setStatus('updates:' + event.target.checked));
      document.querySelector('#plan').addEventListener('change', (event) => setStatus('plan:' + event.target.value));
      document.querySelector('#colors').addEventListener('change', (event) => {
        setStatus('colors:' + [...event.target.selectedOptions].map((option) => option.value).join(','));
      });
      document.querySelector('#action').addEventListener('click', () => {
        document.querySelector('#action-result').hidden = false;
        setStatus('action:clicked');
      });
      document.querySelector('#reveal').addEventListener('mouseenter', () => {
        document.querySelector('#revealed').hidden = false;
        setStatus('hover:revealed');
      });
      document.querySelector('#below-fold').addEventListener('click', () => setStatus('scroll:reached'));
      const revealScroll = () => { document.querySelector('#scroll-result').hidden = false; };
      window.addEventListener('wheel', revealScroll, { once: true });
      window.addEventListener('scroll', revealScroll, { once: true });
      setTimeout(() => {
        document.querySelector('#delayed').innerHTML = '<button id="delayed-target" type="button">Delayed target</button><span>Delayed text ready</span>';
      }, 75);
    </script>
  </body>
</html>`;

const DONE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Done</title></head>
<body><main><h1>Done</h1><p>Submission complete</p><a href="/">Start over</a></main></body></html>`;

export interface FixtureServer {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

export interface ExternalFixtureServer extends FixtureServer {
  appOrigin: string;
  apiOrigin: string;
}

export interface AuthFixtureServer extends FixtureServer {
  origin: string;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function startFixture(): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "/");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url?.startsWith("/done") ? DONE_PAGE : PAGE);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind an IP port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () => closeServer(server),
  };
}

export async function startExternalFixture(): Promise<ExternalFixtureServer> {
  const requests: string[] = [];
  let appPort = 0;
  const apiServer = createServer((request, response) => {
    requests.push(`api:${request.url ?? "/"}`);
    response.writeHead(200, {
      "access-control-allow-origin": `http://app.pi-browser.test:${appPort}`,
      "content-type": "application/json",
    });
    response.end('{"message":"ok"}');
  });
  await new Promise<void>((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(0, "127.0.0.1", () => resolve());
  });
  const apiAddress = apiServer.address();
  if (!apiAddress || typeof apiAddress === "string") throw new Error("external API fixture did not bind an IP port");
  const apiPort = apiAddress.port;
  const appServer = createServer((request, response) => {
    requests.push(`app:${request.url ?? "/"}`);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>External fixture</title></head>
<body><main><h1>External fixture</h1><p id="secondary">secondary:pending</p></main>
<script>
fetch("http://app.pi-browser.test:${apiPort}/data")
  .then((response) => response.json())
  .then((data) => { document.querySelector("#secondary").textContent = "secondary:" + data.message; })
  .catch(() => { document.querySelector("#secondary").textContent = "secondary:blocked"; });
</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    appServer.once("error", reject);
    appServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = appServer.address();
  if (!address || typeof address === "string") throw new Error("external fixture did not bind an IP port");
  appPort = address.port;
  return {
    url: `http://app.pi-browser.test:${appPort}/`,
    appOrigin: `http://app.pi-browser.test:${appPort}`,
    apiOrigin: `http://app.pi-browser.test:${apiPort}`,
    requests,
    close: async () => {
      await Promise.all([closeServer(appServer), closeServer(apiServer)]);
    },
  };
}

export async function startAuthFixture(): Promise<AuthFixtureServer> {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    requests.push(`${request.method ?? "GET"}:${path}`);
    const authenticated = request.headers.cookie?.split(/;\s*/).includes("pi_browser_session=valid") ?? false;
    if (request.method === "POST" && path === "/login") {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const credentials = new URLSearchParams(body);
      if (!credentials.get("email") || credentials.get("password") !== "test-password") {
        response.writeHead(401);
        response.end();
        return;
      }
      response.writeHead(204, { "set-cookie": "pi_browser_session=valid; Path=/; HttpOnly; SameSite=Lax" });
      response.end();
      return;
    }
    if (path === "/logout" || path === "/expire") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "pi_browser_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      });
      response.end("<!doctype html><html><body><main><h1>Signed out</h1><a href='/dashboard'>Dashboard</a></main></body></html>");
      return;
    }
    if (path === "/dashboard" && authenticated) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Auth dashboard</title></head>
<body><main><h1>Dashboard</h1><p>cookie:authenticated</p><p id="local">local:pending</p><p id="indexed">indexed:pending</p><a href="/logout">Log out</a></main>
<script>
document.querySelector('#local').textContent = 'local:' + (localStorage.getItem('auth-marker') ?? 'missing');
const request = indexedDB.open('pi-browser-auth', 1);
request.onupgradeneeded = () => request.result.createObjectStore('markers');
request.onerror = () => { document.querySelector('#indexed').textContent = 'indexed:error'; };
request.onsuccess = () => {
  const read = request.result.transaction('markers').objectStore('markers').get('auth');
  read.onsuccess = () => { document.querySelector('#indexed').textContent = 'indexed:' + (read.result ?? 'missing'); };
};
</script></body></html>`);
      return;
    }
    if (path === "/dashboard") {
      response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><main><h1>Sign in required</h1><a href='/login'>Sign in</a></main></body></html>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Auth login</title></head>
<body><main><h1>Sign in</h1><form id="login"><label for="email">Email</label><input id="email" name="email"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Sign in</button></form><p id="status"></p></main>
<script>
document.querySelector('#login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/login', { method: 'POST', body: new URLSearchParams(new FormData(event.currentTarget)) });
  if (!response.ok) { document.querySelector('#status').textContent = 'Invalid credentials'; return; }
  localStorage.setItem('auth-marker', 'present');
  const request = indexedDB.open('pi-browser-auth', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('markers');
  request.onsuccess = () => {
    const transaction = request.result.transaction('markers', 'readwrite');
    transaction.objectStore('markers').put('present', 'auth');
    transaction.oncomplete = () => window.location.assign('/dashboard');
  };
});
</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("auth fixture did not bind an IP port");
  const origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}/login`, origin, requests, close: () => closeServer(server) };
}
