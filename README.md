# ui

A React-style UI library for [Caju](https://github.com/aecdanjundex/cajulang): components with
JSX-like syntax, hooks and a keyed virtual DOM, compiled to WebAssembly, with a dev server that hot
reloads the page and keeps the components' state.

```caju
import "github.com/aecdanjundex/ui"

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
caju pkg init && caju pkg add github.com/aecdanjundex/ui
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
  and `vercel.json` for you.

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
import "github.com/aecdanjundex/ui"
import "github.com/aecdanjundex/ui/ssr"
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
import "github.com/aecdanjundex/ui"
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
| `ssr.serve(host, port, page)` | serves the build's files and, for other paths, `page(req)` (`""` is a 404); `PORT`, `UI_DIST`, `UI_TEMPLATE` override |
| `ssr.template()`, `ssr.isolate(res)` | the page template; the headers every response needs (for your own `std/http` or `web` server) |
| `gzip.compress(s)`, `gzip.accepted(h)` | `import "github.com/aecdanjundex/ui/gzip"`: DEFLATE/gzip in Caju for `Content-Encoding: gzip` responses (fixed Huffman codes: about 20% larger than `gzip -9`) |

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

State that survives a hot reload: `use_int`, `use_str`, `use_bool`, `use_num`, and `use_state`
holding a `str`, `int`, `num` or `bool`.

## Examples

```sh
caju build -o build/caju-ui cmd/caju-ui.caju       # the command line (needs caju 0.5.0)
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
caju test                          # runtime (fake DOM) and .cajux compiler tests
node tools/embed.mjs               # after changing assets/: embeds them in cmd/assets.caju
caju build -o build/caju-ui cmd/caju-ui.caju
```

`assets/caju-host.mjs` is `tools/wasm/caju-host.mjs` from cajulang (the system calls of a wasm
program).

## License

MIT (see `LICENSE`).
