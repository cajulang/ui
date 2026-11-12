# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Fixed

- `caju-ui build` copies `public/` into the build (it copied nothing when the output existed).
- `caju-ui build --ssr` and `dev --ssr` replace a running server binary ("text file busy").
