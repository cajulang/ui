# ui

A React-style UI library for [Caju](https://github.com/cajulang/cajulang): components with
JSX-like syntax, hooks and a keyed virtual DOM, compiled to WebAssembly, with a dev server that hot
reloads the page and keeps the components' state.

```caju
import "github.com/cajulang/ui"

fn Counter() -> *ui.Node {
  count := ui.use_int(0)
  return (
    <button onClick={fn() { count.set(count.v + 1) }}>
      clicked {count.v} times
    </button>
  )
}

ui.mount("#app", <Counter />)
```

```sh
caju-ui new hello && cd hello
caju pkg init && caju pkg add github.com/cajulang/ui
caju-ui dev            # http://localhost:5173: save a file and the page updates in place
caju-ui build          # a static site in dist/
```

## How it works

```
 page (main thread)                          worker (WebAssembly)
 ┌──────────────────────────┐   events      ┌──────────────────────────────┐
 │ assets/ui.js             │ ────────────▶ │ your app + ui.caju           │
 │  applies DOM patches     │  SharedArray- │  components, hooks, state    │
 │  forwards events/timers  │  Buffer       │  render + keyed diff         │
 │  hot reload + overlay    │ ◀──────────── │  patches as one text batch   │
 └──────────────────────────┘  postMessage  └──────────────────────────────┘
```

- **Everything but the DOM runs in a Web Worker**: rendering, diffing and the components' state
  live in the Caju program, compiled with `caju build --target wasm`. The page only applies the
  batch of patches each update produces, so CPU-heavy work in components never freezes the page.
- **No compiler support needed.** Caju's wasm target talks to its host through Linux system
  calls, so the program uses the virtual device `/dev/ui`: `os.write_file` sends a batch of
  patches, `os.read_file` blocks (`Atomics.wait` in the worker) until the page has events. The
  protocol is described at the top of `ui.caju`.
- **`.cajux` files** are Caju with JSX-like elements. `caju-ui` turns each into a `.caju` next to it,
  keeping every line where it was: a compile error on line N points at line N of the `.cajux`.
- **Hot reload**: when a file changes, `caju-ui dev` rebuilds (≈0.3 s), the page asks the running
  program for a snapshot of every component's state (by its place in the tree), starts the new
  program and gives the state back. Build errors show in an overlay on the page.
- The page must be **cross-origin isolated** (for `SharedArrayBuffer`): `caju-ui dev` and
  `caju-ui preview` send the headers; `caju-ui build` writes `_headers` (Netlify, Cloudflare Pages)
  and `vercel.json` for you (see [Deploying](#deploying)).

## Server-side rendering

The same components render on the server, natively (a Caju program, no browser), and the client
**hydrates** that HTML: it keeps the server's elements, adds the event listeners and starts from
the state the server rendered.

```
app.cajux      the components (shared)
main.cajux     the browser:  ui.hydrate("#app", <app.App ... />)
server.cajux   the server:   ssr.serve(...) + ui.page(...)
```

```caju
# server.cajux
import "github.com/cajulang/ui"
import "github.com/cajulang/ui/ssr"
import "std/http"
import "std/json"
import "./app"

ssr.serve("0.0.0.0", 8080, fn(req: *http.Request) -> str {
  props := app.AppProps{products: load_products(), query: ""}
  data, _ := json.marshal(props)
  return ui.page(ssr.template(), "#app", <app.App products={props.products} query={props.query} />, data)
})
```

```caju
# main.cajux
import "github.com/cajulang/ui"
import "std/json"
import "./app"

let props: app.AppProps
json.unmarshal(ui.data(), &props)          # the data the server passed to ui.page
ui.hydrate("#app", <app.App products={props.products} query={props.query} />)
```

```sh
caju-ui dev --ssr server.cajux     # runs the server too (port + 1); both rebuild and hot reload
caju-ui build --ssr server.cajux   # dist/ and ./server
UI_DIST=dist ./server              # serves dist/ and renders every page
```

| | |
|---|---|
| `ui.render_to_string(node)` | `{html, state}`: the HTML and the components' state (effects and timers do not run on the server) |
| `ui.page(template, "#app", node, data)` | a whole page: `template` (`ssr.template()`, the build's `index.html`) with the HTML inside `#app`, the state, and `data` for the client |
| `ui.hydrate(selector, node)` | like `ui.mount`, over the server's HTML |
| `ui.data()` | in the browser: the `data` the server passed to `ui.page` |
| `ui.ssr_put(key, value)`, `ui.ssr_get(key)` | values kept while rendering on the server (by a data-loading hook, say), which the page carries to the browser for hydration |
| `ssr.serve(host, port, page)` | serves the build's files and, for other paths, `page(req)` (`""` is a 404); `PORT`, `UI_DIST`, `UI_TEMPLATE` override |
| `ssr.template()`, `ssr.isolate(res)` | the page template; the headers every response needs (for your own `std/http` or `web` server) |
| `gzip.compress(s)`, `gzip.compress_fast(s)`, `gzip.accepted(h)` | `import "github.com/cajulang/ui/gzip"`: DEFLATE/gzip in Caju for `Content-Encoding: gzip` responses (dynamic Huffman codes; `compress` is the smallest, for files compressed once, `compress_fast` about 25% faster for a response made on each request) |

How hydration works: the server separates adjacent texts with `<!-- -->` (so the browser keeps them
apart), and the client, instead of creating nodes, claims the next child of each parent (ops `h`
and `j`); where the HTML differs it creates the node (with a warning in development) and removes
what was left over. The state travels as JSON in the page, so `use_int` and friends start where the
server was. In the example, the server renders a page in under 1 ms, the content shows at the first
paint (~40 ms) and hydration adds no DOM nodes.

## The syntax (.cajux)

| JSX | becomes |
|---|---|
| `<div class="a" id={x}>hi {n}</div>` | `ui.h("div", []ui.Attr{ui.a("class", "a"), ui.a("id", x)}, []*ui.Node{ui.text("hi "), ui.child(n)})` |
| `onClick={f}`, `onKeyDown={f}` | listens to the DOM event `click`, `keydown`; `f` is `fn()` or `fn(e: *ui.Event)` |
| `onSubmit:prevent={f}`, `onClick:stop={f}` | with `preventDefault` / `stopPropagation` (`submit` is always prevented) |
| `<Card title="x" n={2}>...</Card>` | `Card(CardProps{title: "x", n: 2, children: [...]})`: one props struct per component |
| `<App />` where `fn App() -> *ui.Node` | a component without props |
| `<views.Card />` | a component from another module |
| `key={id}` | identifies a node among its siblings (lists) |
| `ref={el}` | gives the element to `el := ui.use_element()` (canvas, focus) |
| `<>...</>` | a fragment |
| `<ui.Provider ctx={c} value={v}>` | gives a context value to the components inside |
| `{/* comment */}` | nothing |

Children can be any of `*ui.Node`, `[]*ui.Node`, `str`, `int`, `num`, `bool` (renders nothing) or
`nil`. Caju has no `?:` or `&&` on nodes: use `ui.when(cond, node)`, `ui.either(cond, a, b)`,
`ui.each(n, fn(i: int) -> *ui.Node {...})`, or build a `[]*ui.Node` in a loop.

Form fields work as in React: with `onInput` or `onChange`, `value={x}` (or `checked`) is
controlled, set again on every render; without them the field is uncontrolled, and `value` is only
its starting value, so what the user types stays (a plain `<form method="post">` works that way).

## API

| | |
|---|---|
| `ui.mount(selector, node)` | renders and runs the program's event loop |
| `ui.use_int / use_str / use_bool / use_num(init)` | typed state: `s.v` reads, `s.set(v)` renders again (`IntState.update(f)`, `BoolState.toggle()`) |
| `ui.use_state(init)` | state of any type (`s.v.([]Todo)`) |
| `ui.use_effect(fn() -> fn() {...}, deps)` | after the DOM updates; again when `deps` change (`nil`: every render, `[]any{}`: once); returns a cleanup or `nil` |
| `ui.use_memo(f, deps)`, `ui.use_ref(init)` | as in React |
| `ui.use_element()` | a reference to a rendered element (`ref={r}`) |
| `ui.create_context(def)`, `ui.use_context(ctx)` | context |
| `ui.memo("Name")` | `React.memo`: the component renders again only when its props change (`==`) |
| `ui.use_interval(ms, f)`, `ui.set_interval`, `ui.set_timeout`, `ui.clear_timer` | timers (run by the page, delivered as events) |
| `ui.draw_rgba(el, w, h, pixels)` | puts pixels computed in Caju into a `<canvas>` |
| `ui.focus(el)`, `ui.cx(map[str]bool{...})` | focus an element; class names from conditions |
| `ui.copy(text)` | copies text to the clipboard (from an event handler) |
| `ui.call(name, arg, fn(reply: str) {...})` | calls `window.__UI_FNS__[name](arg, reply)` on the page, for browser APIs the worker lacks (storage, history, cookies, other workers); every `reply(text)` runs the callback |
| `ui.navigate(url)` | goes to another page (`location.assign`) |
| `ui.on_page_event(name, fn(data: str) {...})` | runs the handler each time the page sends the event `name` (see [Page events](#page-events)); returns a function that stops listening |
| `ui.in_page()`, `ui.on_server()` | the program runs in the page (after `mount`/`hydrate`); a component is rendering on the server (`render_to_string`) |
| `ui.ssr_put(key, value)`, `ui.ssr_get(key)` | values that server rendering hands to hydration: kept while rendering on the server, put in the page by `ui.page`, and given back in the browser while it hydrates (for libraries such as [fetch](https://github.com/cajulang/fetch), so what the server loaded is not loaded again) |
| `ui.storage_get(key, fn(value: str, found: bool))`, `ui.storage_set(key, value)`, `ui.storage_remove(key)` | the browser's storage (`localStorage`); see [The browser](#the-browser-storage-environment-document) |
| `ui.env(fn(e: *ui.Env))`, `ui.on_color_scheme(fn(scheme: str))` | the browser's languages, color scheme, URL and user agent; color scheme changes |
| `ui.set_document(lang, title)`, `ui.set_meta(name, content)` | `<html lang>` and the title; a `<meta name>` |

The page has built-in functions for `ui.call`, so apps need no JavaScript of their own for them:
`ui.fetch` (the browser's `fetch` with an `AbortController` for cancel and timeout; HTTP requests
from components go through it with [github.com/cajulang/fetch](https://github.com/cajulang/fetch)),
`ui.fetch.abort`, `ui.navigate`, `ui.storage.*`, `ui.env`, `ui.document`, `ui.meta` and the wallet
bridge `ui.eth.*` (below).

State that survives a hot reload: `use_int`, `use_str`, `use_bool`, `use_num`, and `use_state`
holding a `str`, `int`, `num` or `bool`.

### Page events

`ui.call` is the program asking the page; a **page event** is the page telling the program
something on its own: a wallet switched accounts, a message from another tab. The page sends the
message `v name data` (data is text, usually JSON), and every handler registered for that name
runs, like an event handler (state they change renders again afterwards; a panic is reported and
the other handlers still run):

```caju
off := ui.on_page_event("ui.eth.chainChanged", fn(data: str) { ... })
off()   # stop listening
```

The app's own page code sends them with `window.__UI_EMIT__(name, data)`, for example from a
`window.__UI_FNS__` function that subscribes to some browser API.

### The browser: storage, environment, document

What a worker cannot reach on its own, the page does for the program, with no JavaScript in the
app:

```caju
fn App() -> *ui.Node {
  theme := ui.use_str("light")
  ui.use_effect(fn() -> fn() {
    ui.storage_get("myapp:theme", fn(v: str, found: bool) {
      if found { theme.set(v) }
    })
    ui.env(fn(e: *ui.Env) {
      if len(e.languages) > 0 { ui.set_document(e.languages[0], "My app") }
    })
    return ui.on_color_scheme(fn(s: str) { theme.set(s) })   # stops listening on unmount
  }, []any{})
  return <button onClick={fn() { ui.storage_set("myapp:theme", "dark") }}>{theme.v}</button>
}
```

- **Storage** is the page's `localStorage`, with the keys as given: they are shared with any other
  code on the same origin, so prefix them with the app's name (`myapp:theme`). Values are text
  (JSON for structures). Where storage is unavailable or throws (private mode, blocked site data,
  a full quota), `storage_get` answers not found and `storage_set` / `storage_remove` do nothing.
  On the server (`render_to_string`) the same: `storage_get` calls back right away with
  `("", false)`.
- **`ui.env`** answers `Env{languages, color_scheme, url, user_agent}`: `navigator.languages`
  (preferred first), `"light"` or `"dark"` (`prefers-color-scheme`), `location.href` and
  `navigator.userAgent`. On the server its callback is not called.
- **Page events** of the environment: `ui.env.color_scheme` (`"light"` or `"dark"`, when the user's
  preference changes; `ui.on_color_scheme` listens to it) and `ui.env.languages` (a JSON list, on
  the browser's `languagechange`).
- **`ui.set_document(lang, title)`** sets `document.documentElement.lang` and `document.title` (`""`
  leaves one as it is); **`ui.set_meta(name, content)`** sets the first `<meta name="...">`, adding
  it to `<head>` when there is none. Both do nothing on the server: put those in the page template.

They are `ui.call`s to built-in page functions, so call them from effects and event handlers. The
protocol, for page code of your own:

| `ui.call` | argument | reply |
|---|---|---|
| `ui.storage.get` | the key | `{found, value}` |
| `ui.storage.set` | `{key, value}` | none |
| `ui.storage.remove` | the key | none |
| `ui.env` | `""` | `{languages, color_scheme, url, user_agent}` |
| `ui.document` | `{lang, title}` | none |
| `ui.meta` | `{name, content}` | none |

An app's own `window.__UI_FNS__` function with the same name replaces a built-in one.

### Wallets (EIP-1193)

The page runtime finds the browser's Ethereum wallets with EIP-6963 (it listens for
`eip6963:announceProvider` and asks with `eip6963:requestProvider` when it loads) and gives the
program three built-in page functions. [github.com/cajulang/web3](https://github.com/cajulang/web3)'s
`wallet` module is the Caju API over them; the protocol is:

| `ui.call` | argument | reply |
|---|---|---|
| `ui.eth.providers` | `""` or `{"wait_ms": 50}` (how long to wait for wallets to announce) | `[{id, name, icon, rdns, is_metamask}]`: each announced wallet (`id` is its EIP-6963 uuid, `icon` a data URI), plus `{id: "injected", name: "Injected (window.ethereum)", ...}` when `window.ethereum` exists and is none of them |
| `ui.eth.request` | `{id, method, params}` | `{result}`, or `{error: {code, message, data}}` with the wallet's EIP-1193 error (4001 user rejected, 4902 unknown chain, 4900 no such provider...) |
| `ui.eth.subscribe` | `{id}` | `{ok: true}`; from then on the wallet's events arrive as the page events `ui.eth.accountsChanged` (`{id, data: [addresses]}`), `ui.eth.chainChanged` (`{id, data: "0x1"}`), `ui.eth.connect` (`{id, data: {chain_id}}`) and `ui.eth.disconnect` (`{id, data: {code, message, data}}`) |

## Deploying

`caju-ui build` writes a static site to `dist/` (`-o` for another directory):

```
dist/index.html                     the app's index.html (or a default one) + the runtime's tag
dist/__ui/ui.<hash>.js              the page runtime
dist/__ui/worker.<hash>.js          the worker, which imports caju-host.<hash>.mjs
dist/__ui/app.<hash>.wasm           the program
dist/_headers, dist/vercel.json     the headers, for Netlify / Cloudflare Pages / Vercel
...                                 the files of public/
```

- **No inline script**: the runtime's settings are `data-*` attributes of its tag,
  `<script id="__ui_runtime" src="/__ui/ui.<hash>.js" data-wasm="..." data-worker="..." defer>`,
  so a Content-Security-Policy without `'unsafe-inline'` allows the page. The least it needs:
  `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'` (plus `connect-src` for the APIs the
  app calls). The server's state and data from `ui.page` are `<script type="application/json">`,
  which a CSP does not block. A page may still set `window.__UI__ = {wasm, worker, dev}` itself
  (in a script of its own); it wins over the attributes.
- **Content-hashed names**: `<hash>` is the first 10 hex digits of the file's SHA-256, so each file
  can be cached for good, and `index.html` (which names the current ones) revalidated. The headers
  caju-ui writes do that; for another host, use:

  | path | `Cache-Control` |
  |---|---|
  | `/__ui/*` (hashed names) | `public, max-age=31536000, immutable` |
  | `/index.html` and the pages | `no-cache` (or `public, max-age=0, must-revalidate`) |

  Every path also needs `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (`SharedArrayBuffer`). `ssr.serve` sends the
  long cache for the hashed files and `no-cache` for the rest. `--no-hash` gives the old names
  (`app.wasm`, `worker.js`, `ui.js`, `caju-host.mjs`), for tools that fetch them by name.
- **Your own headers stay**: an `_headers` or `vercel.json` in the output that caju-ui did not
  write (one from `public/`, or put there by hand) is kept; the ones caju-ui writes start with a
  marker line (`_headers`) or match its own text exactly (`vercel.json`) and are replaced on the
  next build. `--no-headers` writes neither (when the headers live in the host's own settings).
- Each build removes the runtime files of earlier builds from `__ui/`.

## Examples

```sh
caju build -o build/caju-ui cmd/caju-ui.caju       # the command line (needs caju 0.6.0)
cd examples/counter && ../../build/caju-ui dev      # state, events, an effect
cd examples/todo && ../../build/caju-ui dev         # props, a keyed list, a form, a context
cd examples/mandelbrot && ../../build/caju-ui dev   # CPU work in the worker, drawn on a canvas
cd examples/ssr && ../../build/caju-ui dev --ssr server.cajux   # rendered on the server, hydrated
```

## Performance against React

`bench/` has the [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)
table in caju-ui and in React 18 (keyed, `React.memo` rows), timed the same way in the same
headless Chromium (`cd bench && npm install && node run.mjs`; results in `bench/RESULTS.md`).
In short:

- **DOM updates: React is faster, 1.1–1.8×** (swap and clear are even). The DOM work itself is the
  same for both; the difference is the time the Caju code takes in the worker.
- **CPU work in components: the page never freezes with caju-ui** (no long task on the main thread,
  against 144 ms for React), **but the work itself takes 2.9× longer**: Caju's wasm target does not
  yet have the optimizations of its native target. The same Mandelbrot code runs in 151 ms as a
  native Caju binary, as fast as JavaScript (143 ms), and in 415–660 ms as wasm. Faster wasm code
  from the compiler is the biggest lever left.
- **Size: 105 KB gzipped** (the program with its runtime, 781 KB raw) against 46 KB for React.

## Development

```sh
caju test                          # runtime (fake DOM), .cajux compiler and caju-ui build tests
node tools/embed.mjs               # after changing assets/: embeds them in cmd/assets.caju
node tools/eth-check.mjs           # the page runtime's wallet bridge, with fake wallets
node tools/page-check.mjs          # its storage, environment, document and settings, with a fake page
caju build -o build/caju-ui cmd/caju-ui.caju
```

`assets/caju-host.mjs` is `tools/wasm/caju-host.mjs` from cajulang (the system calls of a wasm
program).

## License

MIT (see `LICENSE`).
