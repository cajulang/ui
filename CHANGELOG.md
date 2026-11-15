# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).


## [Unreleased]

## [0.5.0] - 2026-11-15

### Added

- The browser's storage: `ui.storage_get(key, fn(value: str, found: bool))`, `ui.storage_set(key,
  value)` and `ui.storage_remove(key)`, over `localStorage` (raw keys: prefix them with the app's
  name), with the built-in page functions `ui.storage.get`, `ui.storage.set` and
  `ui.storage.remove`. Storage that is unavailable or throws (private mode, blocked site data)
  reads as not found and writes nothing; on the server, `storage_get` calls back with
  `("", false)` and the others do nothing.
- The browser's environment: `ui.env(fn(e: *ui.Env))` with `Env{languages, color_scheme, url,
  user_agent}` (page function `ui.env`), the page events `ui.env.color_scheme` (when
  `prefers-color-scheme` changes) and `ui.env.languages` (on `languagechange`), and
  `ui.on_color_scheme(f)`, which listens to the first.
- The document: `ui.set_document(lang, title)` (`<html lang>` and `document.title`) and
  `ui.set_meta(name, content)`, with the page functions `ui.document` and `ui.meta`.
- `caju-ui build --no-headers`: writes no `_headers` and `vercel.json`. `caju-ui build --no-hash`:
  the runtime's files keep their plain names.
- `ssr.cache_control(path)`; `ssr.serve` caches the build's hashed files for a year
  (`immutable`) and revalidates everything else.
- `tools/page-check.mjs` (node check of the new page functions, including storage that throws)
  and `build_test.caju` (runs `caju-ui build` on `testdata/examples/hello`).

### Changed

- `caju-ui build` writes no inline script, so the page works under a Content-Security-Policy with
  `script-src 'self'`: the runtime's settings are `data-*` attributes of its tag
  (`<script id="__ui_runtime" src=... data-wasm=... data-worker=... defer>`), which `ui.js` reads
  (a page's own `window.__UI__` still works and wins). `caju-ui dev` does the same, and `ui.page`
  puts the server's state and data before that tag (or before the old inline script).
- `caju-ui build` names the runtime's files by their content: `__ui/app.<hash>.wasm`,
  `worker.<hash>.js`, `caju-host.<hash>.mjs` and `ui.<hash>.js` (`<hash>`: 10 hex digits of the
  SHA-256), so they can be cached for good; the `_headers` and `vercel.json` it writes say so
  (`Cache-Control: public, max-age=31536000, immutable` for `/__ui/*`) and add
  `Cross-Origin-Resource-Policy: same-origin`. The runtime files of earlier builds are removed.
- `caju-ui build` no longer overwrites an `_headers` or `vercel.json` it did not write (from
  `public/`, or put in the output by hand).

## [0.4.1] - 2026-11-15

### Changed
- Requires caju 0.9.0: the `caju-ui` command waits with `os.sleep`, now that `sleep` is no longer
  part of the language.

## [0.4.0] - 2026-11-15

### Added

- Page events: `ui.on_page_event(name, fn(data: str))` runs a handler each time the page sends
  the event `name` (new protocol message `v name data`), and returns a function that stops
  listening. The page's built-in bridges send them, and so can the app's own page code with
  `window.__UI_EMIT__(name, data)`.
- An EIP-1193 wallet bridge in the page runtime, for
  [github.com/cajulang/web3](https://github.com/cajulang/web3)'s wallet client:
  `ui.eth.providers` lists the wallets found with EIP-6963 (and `window.ethereum` as `injected`
  when no announced wallet is it), `ui.eth.request` calls a wallet's `request({method, params})`
  and answers `{result}` or `{error: {code, message, data}}`, and `ui.eth.subscribe` forwards its
  `accountsChanged`, `chainChanged`, `connect` and `disconnect` events as the page events
  `ui.eth.<event>` with `{id, data}`.
- `testdata/fakedom`: `Dom.call_at(i)`, `reply_msg(id, text)` and `event_msg(name, data)`, for
  testing libraries that talk to the page.
- `tools/eth-check.mjs`: checks the wallet bridge in node with fake wallets.

### Fixed

- A reply to `ui.call` that arrives after a hot reload is dropped instead of reaching the new
  program under a call id it may be using for something else.

## [0.3.0] - 2026-11-15

### Added

- Built-in page functions for `ui.call`: `ui.fetch` runs the browser's `fetch` for the program
  (with an `AbortController` for cancel and timeout) and `ui.fetch.abort` cancels it; they are what
  [github.com/cajulang/fetch](https://github.com/cajulang/fetch) uses in the browser, so apps no
  longer write JavaScript to call their API. A hot reload cancels the requests in flight.
- `ui.navigate(url)` (and the `ui.navigate` page function): goes to another page.
- `ui.ssr_put(key, value)` and `ui.ssr_get(key)`: values a server render keeps (`Rendered.values`),
  which `ui.page` puts in the page (`<script id="__ui_ssr">`) and the browser gets back while it
  hydrates, so data loaded on the server is not loaded again.
- `ui.in_page()` and `ui.on_server()`: whether the program runs in the page or a component is
  rendering on the server.

### Changed

- The page's init message carries a third field, the server's values (`i state data values`).

## [0.2.0] - 2026-11-14

### Changed

- Needs Caju 0.6.0 (`caju = "0.6.0"` in caju.toml).
- `caju-ui dev --ssr` asks the app's server for pages with `std/http`'s client instead of its own
  HTTP code: responses in chunks or without Content-Length are read whole, and a server that does
  not answer gives an error after 30 seconds instead of hanging.

## [0.1.0] - 2026-11-13

### Added

- `ui.caju`: components, typed state hooks, effects, memo, refs, context, timers, a keyed virtual
  DOM diff and the `/dev/ui` protocol between the WebAssembly program and the page.
- `jsx.caju`: the `.cajux` compiler (JSX-like elements to Caju, keeping line numbers).
- `caju-ui` command: `new`, `dev` (rebuild and hot reload keeping the state, error overlay),
  `build`, `preview`, `gen`.
- Examples: counter, to-do list, Mandelbrot on a canvas.
- `bench/`: the js-framework-benchmark operations against React 18.
- Server-side rendering: `ui.render_to_string`, `ui.page`, `ui.hydrate`, `ui.data`, the `ssr` module
  (`ssr.serve`, `ssr.template`, `ssr.isolate`), `caju-ui dev --ssr` and `caju-ui build --ssr`, and
  the `examples/ssr` app.
- `ui.copy(text)`: copies text to the clipboard.
- `ui.call(name, arg, cb)`: calls a function of the page and gets its replies.
- Server rendering writes a `<textarea>`'s value as its content.
- `gzip` module: gzip compression in Caju for HTTP responses.
- `caju-ui build --base`: the runtime's paths are absolute (`/__ui/...` by default), so pages at
  any depth find it; the runtime script is loaded with `defer`.
- `gzip.compress_fast(s)`: a fast level (short hash chains, no lazy matching) for responses made on
  every request; `gzip.compress` stays the smallest, for what is compressed once.

### Changed

- `value` and `checked` are controlled only when the element listens to `input` or `change` (as in
  React): an uncontrolled field keeps what the user typed when its component renders again, instead
  of going back to the rendered value. `selected` is set only when it changes.
- `gzip`: length and distance codes from tables, canonical codes kept bit-reversed and Huffman
  codes built from two queues (no allocation per merge): about 20% faster.

### Fixed

- Hydration keeps what the user typed, checked or picked in a field before the program started
  (the page used to put the server's value back, and a fast typist lost the input); the program
  gets an `input`/`change` event with the field's value.

- `caju-ui build` copies `public/` into the build (it copied nothing when the output existed).
- `caju-ui build --ssr` and `dev --ssr` replace a running server binary ("text file busy").

[Unreleased]: https://github.com/cajulang/ui/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/cajulang/ui/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/cajulang/ui/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/cajulang/ui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cajulang/ui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/cajulang/ui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cajulang/ui/releases/tag/v0.1.0
