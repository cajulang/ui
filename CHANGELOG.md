# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/cajulang/ui/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/cajulang/ui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cajulang/ui/releases/tag/v0.1.0
