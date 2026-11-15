// Checks the page runtime's browser functions (assets/ui.js: ui.storage.*, ui.env, ui.document,
// ui.meta, the page events ui.env.*) and where it reads its settings, in node, without a
// browser: a fake window (localStorage, matchMedia, navigator, document) and a fake worker that
// sends J ops and reads the messages the page puts in the mailbox.
//
//   node tools/page-check.mjs
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const code = readFileSync(join(root, "assets", "ui.js"), "utf8")
let failed = 0
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = (s) => Buffer.byteLength(s) + ":" + s

class Event { constructor(type) { this.type = type } }

// a localStorage; broken: every access throws (private mode, blocked storage)
function fakeStorage(broken) {
  const m = new Map()
  const no = () => { throw new Error("SecurityError: storage is disabled") }
  return {
    m,
    getItem: (k) => broken ? no() : (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => broken ? no() : void m.set(k, String(v)),
    removeItem: (k) => broken ? no() : void m.delete(k),
  }
}

// a page: opts.storage is "ok", "throwing" (methods throw) or "getter" (window.localStorage throws)
function page(opts) {
  const listeners = new Map()
  const mqListeners = []
  const mq = { matches: !!opts.dark, addEventListener: (t, f) => { if (t === "change") mqListeners.push(f) } }
  const metas = []
  const mkMeta = () => {
    const a = {}
    return { tag: "meta", getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v) }, attrs: a }
  }
  const head = { appendChild: (el) => { metas.push(el); return el } }
  const store = fakeStorage(opts.storage === "throwing")
  const win = {
    __UI__: opts.global,
    crossOriginIsolated: true,
    addEventListener(type, f) { (listeners.get(type) || listeners.set(type, []).get(type)).push(f) },
    dispatchEvent(ev) { for (const f of listeners.get(ev.type) || []) f(ev); return true },
    matchMedia: (q) => (q === "(prefers-color-scheme: dark)" ? mq : { matches: false }),
    navigator: { languages: opts.languages, language: opts.language, userAgent: "FakeBrowser/1.0" },
  }
  if (opts.storage === "getter") Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError") } })
  else win.localStorage = store
  let w = null
  class Worker {
    constructor(url) { w = this; this.url = url }
    postMessage(m) { if (m.t === "start") { this.start = m; this.ctl = new Int32Array(m.sab, 0, 2); this.box = new Uint8Array(m.sab, 8) } }
    terminate() {}
    read() {
      if (Atomics.load(this.ctl, 0) !== 1) return ""
      const s = new TextDecoder().decode(this.box.slice(0, Atomics.load(this.ctl, 1)))
      Atomics.store(this.ctl, 0, 0)
      this.onmessage({ data: { t: "ack" } })
      return s
    }
    patch(s) { this.onmessage({ data: { t: "patch", data: new TextEncoder().encode(s) } }) }
  }
  const documentElement = { lang: "en" }
  const document = {
    documentElement, title: "before", head,
    currentScript: opts.script || null,
    getElementById: (id) => (id === "__ui_runtime" && opts.byId ? opts.byId : null),
    querySelector: () => null,
    getElementsByTagName: (t) => (t === "meta" ? metas.slice() : []),
    createElement: (t) => (t === "meta" ? mkMeta() : {}),
  }
  const ctx = {
    window: win, self: win, Event, Worker, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder,
    URL, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, console,
    location: { href: "https://app.example/a?b=1" },
    performance: { now: () => 0 },
    document, navigator: win.navigator,
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  const p = {
    win, store, document, metas, mq,
    get worker() { return w },
    got: "",
    async drain(ms) {
      await sleep(ms || 5)
      for (let i = 0; i < 10; i++) { p.got += w.read(); await sleep(1) }
      const s = p.got
      p.got = ""
      return s
    },
    call: (id, name, arg) => w.patch("Q0,J" + id + "," + S(name) + S(arg)),
    scheme(dark) { mq.matches = dark; for (const f of mqListeners) f({ matches: dark }) },
  }
  return p
}
function replies(s) {
  const out = {}
  const re = /c(\d+),(\d+):/g
  let m
  while ((m = re.exec(s))) {
    const n = Number(m[2])
    out[m[1]] = Buffer.from(s.slice(m.index + m[0].length)).subarray(0, n).toString()
    re.lastIndex = m.index + m[0].length + Buffer.from(out[m[1]]).toString().length
  }
  return out
}

// ---- settings --------------------------------------------------------------------------------
{
  const script = { dataset: { wasm: "/__ui/app.0123456789.wasm", worker: "/__ui/worker.abcdef0123.js" } }
  const p = page({ script, languages: ["pt-BR", "en"] })
  check(p.worker && p.worker.url === "/__ui/worker.abcdef0123.js", "the worker's URL from the script's data-worker: " + (p.worker && p.worker.url))
  check(p.worker.start.url === "https://app.example/__ui/app.0123456789.wasm", "the program's URL from data-wasm: " + p.worker.start.url)
}
{
  const byId = { dataset: { wasm: "/x.wasm", worker: "/w.js" } }
  const p = page({ byId })
  check(p.worker.url === "/w.js", "the settings from #__ui_runtime when document.currentScript is not set")
}
{
  const script = { dataset: { wasm: "/d.wasm", worker: "/d.js" } }
  const p = page({ script, global: { worker: "/g.js", wasm: "/g.wasm" } })
  check(p.worker.url === "/g.js", "window.__UI__ (a page's own settings) wins over data-*")
}

// ---- storage ---------------------------------------------------------------------------------
{
  const p = page({ script: { dataset: { wasm: "a.wasm", worker: "w.js" } }, languages: ["pt-BR", "en"] })
  await p.drain()                                           // the init message
  p.store.m.set("app:theme", "dark")
  p.call(1, "ui.storage.get", "app:theme")
  p.call(2, "ui.storage.get", "app:none")
  let r = replies(await p.drain())
  check(r[1] === "{\"found\":true,\"value\":\"dark\"}", "storage get, found: " + r[1])
  check(r[2] === "{\"found\":false,\"value\":\"\"}", "storage get, not found: " + r[2])

  p.call(3, "ui.storage.set", JSON.stringify({ key: "app:name", value: "Açaí \"1\"" }))
  p.call(4, "ui.storage.remove", "app:theme")
  p.call(5, "ui.storage.get", "app:name")
  r = replies(await p.drain())
  check(p.store.m.get("app:name") === "Açaí \"1\"" && !p.store.m.has("app:theme"), "storage set and remove")
  check(Object.keys(r).join() === "5", "set and remove send no reply")
  check(JSON.parse(r[5]).value === "Açaí \"1\"", "a value with non-ASCII text and quotes comes back whole: " + r[5])

  p.call(6, "ui.storage.set", "not json")
  await p.drain()
  check(p.store.m.size === 1, "a bad set argument is ignored")

  // ---- env -----------------------------------------------------------------------------------
  p.call(7, "ui.env", "")
  r = replies(await p.drain())
  check(r[7] === "{\"languages\":[\"pt-BR\",\"en\"],\"color_scheme\":\"light\",\"url\":\"https://app.example/a?b=1\",\"user_agent\":\"FakeBrowser/1.0\"}", "env: " + r[7])
  p.scheme(true)
  p.call(8, "ui.env", "")
  const s = await p.drain()
  check(s.startsWith("v" + S("ui.env.color_scheme") + S("dark")), "a color scheme change is the page event ui.env.color_scheme: " + s.slice(0, 40))
  check(JSON.parse(replies(s)[8]).color_scheme === "dark", "env follows the color scheme")
  p.scheme(false)
  check(await p.drain() === "v" + S("ui.env.color_scheme") + S("light"), "and back to light")
  p.win.navigator.languages = ["de"]
  p.win.dispatchEvent(new Event("languagechange"))
  check(await p.drain() === "v" + S("ui.env.languages") + S("[\"de\"]"), "a language change is the page event ui.env.languages")

  // ---- document --------------------------------------------------------------------------------
  p.call(9, "ui.document", JSON.stringify({ lang: "pt-BR", title: "Carteira" }))
  await p.drain()
  check(p.document.documentElement.lang === "pt-BR" && p.document.title === "Carteira", "set_document sets <html lang> and the title")
  p.call(10, "ui.document", JSON.stringify({ lang: "", title: "Só o título" }))
  await p.drain()
  check(p.document.documentElement.lang === "pt-BR" && p.document.title === "Só o título", "an empty lang leaves it as it is")
  p.call(11, "ui.meta", JSON.stringify({ name: "description", content: "uma carteira" }))
  p.call(12, "ui.meta", JSON.stringify({ name: "description", content: "a wallet" }))
  p.call(13, "ui.meta", JSON.stringify({ name: "", content: "x" }))
  await p.drain()
  check(p.metas.length === 1 && p.metas[0].attrs.name === "description" && p.metas[0].attrs.content === "a wallet", "set_meta adds the <meta> once and then updates it")
}

// ---- storage that is unavailable ---------------------------------------------------------------
for (const kind of ["throwing", "getter"]) {
  const p = page({ script: { dataset: { wasm: "a.wasm", worker: "w.js" } }, storage: kind, language: "fr" })
  await p.drain()
  p.call(1, "ui.storage.set", JSON.stringify({ key: "k", value: "v" }))
  p.call(2, "ui.storage.remove", "k")
  p.call(3, "ui.storage.get", "k")
  p.call(4, "ui.env", "")
  const r = replies(await p.drain())
  check(r[3] === "{\"found\":false,\"value\":\"\"}", "storage that throws (" + kind + "): get is not found, set and remove do nothing")
  check(JSON.parse(r[4]).languages.join() === "fr", "navigator.language when there is no navigator.languages")
}

console.log(failed ? failed + " failed" : "all passed")
process.exit(failed ? 1 : 0)
