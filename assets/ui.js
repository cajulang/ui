// caju-ui page runtime: starts the program in a worker (worker.js), applies the DOM patches it
// sends, forwards DOM events and timers back to it and, in development, hot reloads it when the
// code changes (keeping the components' state). See ui.caju for the protocol.
(() => {
  "use strict"
  // the settings: the data-* attributes of this script's tag (caju-ui build and dev write them,
  // so the page needs no inline script and works under a strict Content-Security-Policy), and
  // window.__UI__ for pages that set it themselves (it wins)
  const cfg = Object.assign(settings(), window.__UI__ || {})
  function settings() {
    const out = {}
    let el = null
    try { el = document.currentScript || document.getElementById("__ui_runtime") } catch (e) {}
    const d = el && el.dataset
    if (!d) return out
    if (d.wasm) out.wasm = d.wasm
    if (d.worker) out.worker = d.worker
    if (d.dev) out.dev = d.dev === "1" || d.dev === "true"
    if (d.v) out.v = Number(d.v)
    if (d.sid) out.sid = d.sid
    return out
  }
  const SVG = "http://www.w3.org/2000/svg"
  const BOX = 4 << 20
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  const nodes = new Map()
  const cursor = new Map()  // hydration: parent node id -> its next child to claim
  const timers = new Map()
  let worker = null
  let ctl = null, box = null
  let queue = []            // messages waiting for the mailbox
  let seq = 0               // the last event sent
  let answered = 0          // the last event the program has answered
  let snapshotWait = null
  let hotStart = false       // a hot reload hydrates over the previous program's DOM: no warnings
  let gen = 0               // which program is running (each start is a new one)

  if (typeof SharedArrayBuffer === "undefined" || !self.crossOriginIsolated) {
    fatal("caju-ui needs a cross-origin isolated page (SharedArrayBuffer). Serve it with the headers\n" +
      "  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n" +
      "(caju-ui dev does; for a build, see dist/_headers).")
    return
  }

  // ---- messages to the program -------------------------------------------------------------
  const S = (s) => enc.encode(s).length + ":" + s
  function send(msg) {
    if (window.__UI_STATS__) window.__UI_STATS__.push({ sent: performance.now() })
    queue.push(msg)
    pump()
  }
  function pump() {
    if (!ctl || queue.length === 0 || Atomics.load(ctl, 0) !== 0) return
    const bytes = enc.encode(queue.join(""))
    if (bytes.length > BOX) { fatal("caju-ui: event batch too large"); return }
    queue = []
    box.set(bytes)
    Atomics.store(ctl, 1, bytes.length)
    Atomics.store(ctl, 0, 1)
    Atomics.notify(ctl, 0)
  }

  // has the user changed this form field (typed, checked, picked) since the page loaded?
  function edited(el) {
    const tag = el.tagName
    if (tag === "INPUT") {
      if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked
      return el.value !== el.defaultValue
    }
    if (tag === "TEXTAREA") return el.value !== el.defaultValue
    if (tag === "SELECT") for (const o of el.options) if (o.selected !== o.defaultSelected) return true
    return false
  }

  // hydration leaves a field the user changed as it is (its options' selected too)
  function kept(el, name) {
    if (name !== "value" && name !== "checked" && name !== "selected") return false
    if (el.__kept) return true
    const sel = el.tagName === "OPTION" && el.closest && el.closest("select")
    return !!(sel && sel.__kept)
  }

  // ---- events --------------------------------------------------------------------------------
  function onEvent(ev) {
    const el = ev.currentTarget
    const mods = (el.__mods && el.__mods[ev.type]) || ""
    if (ev.type === "submit" || mods.indexOf("prevent") >= 0) ev.preventDefault()
    if (mods.indexOf("stop") >= 0) ev.stopPropagation()
    const t = ev.target || {}
    const value = t.value != null ? String(t.value) : ""
    seq++
    if (ev.type === "input" || ev.type === "change" || ev.type === "keydown") el.__typed = seq
    send("e" + seq + "," + el.__uid + "," + S(ev.type) + S(value) + (t.checked ? 1 : 0) + "," +
      S(ev.key || "") + S(String(ev.clientX || 0)) + S(String(ev.clientY || 0)))
  }

  function copyText(s) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(s).catch(() => {})
    const t = document.createElement("textarea")
    t.value = s
    t.style.cssText = "position:fixed;opacity:0"
    document.body.appendChild(t)
    t.select()
    try { document.execCommand("copy") } catch (e) {}
    t.remove()
  }

  // ---- page events (ui.on_page_event) ---------------------------------------------------------
  // something the page tells the program on its own; the app's page code can send them too
  function emit(name, data) { send("v" + S(String(name)) + S(data == null ? "" : String(data))) }
  window.__UI_EMIT__ = emit

  // ---- built-in page functions (ui.call) -----------------------------------------------------
  // ui.fetch: the browser's fetch for the program (github.com/cajulang/fetch). The argument is
  // JSON {id, method, url, headers, body, timeout_ms}; the reply is JSON {status, status_text,
  // headers, body, url} or, when there is no response, {error: "network"|"timeout"|"canceled",
  // message}. ui.fetch.abort cancels the request with that id.
  const fetches = new Map()
  const builtins = {
    "ui.fetch": (arg, reply) => {
      let q
      try { q = JSON.parse(arg) } catch (e) { reply(JSON.stringify({ error: "network", message: "bad request: " + e.message })); return }
      const ac = new AbortController()
      let why = "", timer = 0
      const abort = (w) => { if (!why) { why = w; ac.abort() } }
      fetches.set(q.id, abort)
      if (q.timeout_ms > 0) timer = setTimeout(() => abort("timeout"), q.timeout_ms)
      const method = (q.method || "GET").toUpperCase()
      const init = { method, headers: q.headers || {}, signal: ac.signal, credentials: "same-origin" }
      if (q.body && method !== "GET" && method !== "HEAD") init.body = q.body
      fetch(q.url, init)
        .then((r) => r.text().then((body) => {
          const headers = {}
          r.headers.forEach((v, k) => { headers[k] = v })
          return { status: r.status, status_text: r.statusText, headers, body, url: r.url }
        }))
        .catch((e) => ({ error: why || "network", message: why ? "" : String((e && e.message) || e) }))
        .then((res) => {
          clearTimeout(timer)
          fetches.delete(q.id)
          reply(JSON.stringify(res))
        })
    },
    "ui.fetch.abort": (arg) => { const f = fetches.get(Number(arg)); if (f) f("canceled") },
    "ui.navigate": (url) => { location.assign(url) },
    // storage (localStorage, raw keys): a page where it is unavailable or throws (private mode,
    // blocked cookies, quota) reads as "not found" and writes nothing
    "ui.storage.get": (key, reply) => {
      let v = null
      try { v = storage().getItem(String(key)) } catch (e) { v = null }
      reply(v == null ? "{\"found\":false,\"value\":\"\"}" : JSON.stringify({ found: true, value: String(v) }))
    },
    "ui.storage.set": (arg) => {
      try {
        const q = JSON.parse(arg)
        storage().setItem(String(q.key), String(q.value == null ? "" : q.value))
      } catch (e) {}
    },
    "ui.storage.remove": (key) => { try { storage().removeItem(String(key)) } catch (e) {} },
    // the browser's environment: {languages, color_scheme, url, user_agent}
    "ui.env": (_arg, reply) => { reply(JSON.stringify(env())) },
    // <html lang> and document.title ("" leaves each as it is)
    "ui.document": (arg) => {
      let q = {}
      try { q = JSON.parse(arg) } catch (e) { return }
      try {
        if (q.lang) document.documentElement.lang = String(q.lang)
        if (q.title) document.title = String(q.title)
      } catch (e) {}
    },
    // <meta name content>: sets the first <meta name=...>, or adds one to <head>
    "ui.meta": (arg) => {
      let q = {}
      try { q = JSON.parse(arg) } catch (e) { return }
      if (!q.name) return
      try {
        let m = null
        for (const x of document.getElementsByTagName("meta")) if (x.getAttribute("name") === q.name) { m = x; break }
        if (!m) {
          m = document.createElement("meta")
          m.setAttribute("name", String(q.name))
          ;(document.head || document.documentElement).appendChild(m)
        }
        m.setAttribute("content", String(q.content == null ? "" : q.content))
      } catch (e) {}
    },
    "ui.eth.providers": (arg, reply) => {
      let q = {}
      try { q = arg ? JSON.parse(arg) : {} } catch (e) {}
      ethAsk()
      setTimeout(() => reply(JSON.stringify(ethList())), q.wait_ms >= 0 ? q.wait_ms : 50)
    },
    "ui.eth.request": (arg, reply) => {
      let q
      try { q = JSON.parse(arg) } catch (e) { reply(JSON.stringify({ error: { code: -32600, message: "bad request: " + e.message, data: null } })); return }
      const p = ethProvider(q.id)
      if (!p) { reply(JSON.stringify({ error: { code: 4900, message: "no wallet provider " + JSON.stringify(q.id), data: null } })); return }
      const req = { method: q.method }
      if (q.params != null) req.params = q.params
      Promise.resolve()
        .then(() => p.request(req))
        .then((result) => ({ result: result === undefined ? null : result }), (e) => ({ error: ethError(e) }))
        .then((res) => {
          let s
          try { s = JSON.stringify(res) } catch (e) { s = JSON.stringify({ error: { code: -32603, message: "the wallet's answer is not JSON: " + e.message, data: null } }) }
          reply(s)
        })
    },
    "ui.eth.subscribe": (arg, reply) => {
      let q
      try { q = JSON.parse(arg) } catch (e) { q = { id: arg } }
      const p = ethProvider(q.id)
      if (!p || typeof p.on !== "function") { reply(JSON.stringify({ error: { code: 4900, message: "no wallet provider " + JSON.stringify(q.id), data: null } })); return }
      if (!eth.subscribed.has(p)) {
        eth.subscribed.add(p)
        const fwd = (name, conv) => p.on(name, (data) => {
          let d = null
          try { d = conv(data) } catch (e) {}
          emit("ui.eth." + name, JSON.stringify({ id: q.id, data: d === undefined ? null : d }))
        })
        fwd("accountsChanged", (a) => Array.isArray(a) ? a : [])
        fwd("chainChanged", (c) => String(c))
        fwd("connect", (info) => ({ chain_id: String((info && info.chainId) || "") }))
        fwd("disconnect", (e) => ethError(e || {}))
      }
      reply(JSON.stringify({ ok: true }))
    },
  }

  // ---- storage and the environment -----------------------------------------------------------
  // window.localStorage itself throws in some browsers when storage is blocked
  function storage() { return window.localStorage }
  function colorScheme() {
    try { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" } catch (e) { return "light" }
  }
  function languages() {
    const nav = window.navigator || (typeof navigator !== "undefined" ? navigator : {}) || {}
    let l = []
    try { l = Array.from(nav.languages || []).map(String) } catch (e) {}
    if (l.length === 0 && nav.language) l = [String(nav.language)]
    return l
  }
  function env() {
    const nav = window.navigator || (typeof navigator !== "undefined" ? navigator : {}) || {}
    let url = ""
    try { url = String(location.href) } catch (e) {}
    return { languages: languages(), color_scheme: colorScheme(), url, user_agent: String(nav.userAgent || "") }
  }
  // the page events ui.env.color_scheme ("light" or "dark") and ui.env.languages (JSON list)
  try {
    const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)")
    const onScheme = (e) => emit("ui.env.color_scheme", e && typeof e.matches === "boolean" ? (e.matches ? "dark" : "light") : colorScheme())
    if (mq && mq.addEventListener) mq.addEventListener("change", onScheme)
    else if (mq && mq.addListener) mq.addListener(onScheme)
  } catch (e) {}
  window.addEventListener("languagechange", () => emit("ui.env.languages", JSON.stringify(languages())))

  // ---- wallets (EIP-1193 providers, found with EIP-6963) -------------------------------------
  // Wallets announce themselves with "eip6963:announceProvider" (each with a uuid, name, icon and
  // rdns) in answer to "eip6963:requestProvider"; older ones only set window.ethereum, listed as
  // the provider "injected" when no announced one is the same object.
  const eth = { list: [], byId: new Map(), subscribed: new Set() }
  window.addEventListener("eip6963:announceProvider", (ev) => {
    const d = ev && ev.detail
    if (!d || !d.info || !d.provider || typeof d.provider.request !== "function") return
    const id = String(d.info.uuid || "")
    if (!id || id === "injected") return
    const i = eth.list.findIndex((x) => x.id === id || x.provider === d.provider)
    const w = { id, info: d.info, provider: d.provider }
    if (i >= 0) { eth.byId.delete(eth.list[i].id); eth.list[i] = w } else eth.list.push(w)
    eth.byId.set(id, d.provider)
  })
  function ethAsk() { try { window.dispatchEvent(new Event("eip6963:requestProvider")) } catch (e) {} }
  ethAsk()
  function ethProvider(id) {
    if (id === "injected") return window.ethereum || null
    return eth.byId.get(id) || null
  }
  function ethList() {
    const out = eth.list.map((w) => ({ id: w.id, name: String(w.info.name || ""), icon: String(w.info.icon || ""), rdns: String(w.info.rdns || ""), is_metamask: !!w.provider.isMetaMask }))
    const inj = window.ethereum
    if (inj && typeof inj.request === "function" && !eth.list.some((w) => w.provider === inj)) {
      out.push({ id: "injected", name: "Injected (window.ethereum)", icon: "", rdns: "", is_metamask: !!inj.isMetaMask })
    }
    return out
  }
  // an EIP-1193 error as {code, message, data} (MetaMask Mobile wraps 4902 in a -32603)
  function ethError(e) {
    let code = e && typeof e.code === "number" ? e.code : -32603
    const orig = e && e.data && e.data.originalError
    if (code === -32603 && orig && orig.code === 4902) code = 4902
    let data = e && e.data !== undefined ? e.data : null
    try { JSON.stringify(data) } catch (x) { data = null }
    return { code, message: String((e && e.message) || e || "wallet error"), data }
  }

  function forget(n) {
    if (n.__uid) nodes.delete(n.__uid)
    for (let c = n.firstChild; c; c = c.nextSibling) forget(c)
  }

  // ---- patches -------------------------------------------------------------------------------
  function apply(u8) {
    let p = 0
    const num = () => {
      let v = 0, neg = false
      if (u8[p] === 45) { neg = true; p++ }
      while (u8[p] !== 44) {
        if (p >= u8.length) throw new Error("caju-ui: truncated patch")
        v = v * 10 + (u8[p++] - 48)
      }
      p++
      return neg ? -v : v
    }
    const bytes = () => {
      let n = 0
      while (u8[p] !== 58) {
        if (p >= u8.length) throw new Error("caju-ui: truncated patch")
        n = n * 10 + (u8[p++] - 48)
      }
      p++
      const b = u8.subarray(p, p + n)
      p += n
      return b
    }
    const str = () => dec.decode(bytes())
    while (p < u8.length) {
      const op = u8[p++]
      switch (op) {
        case 81: answered = num(); break                                   // Q
        case 66: {                                                         // B
          const id = num(), sel = str()
          const el = document.querySelector(sel)
          if (!el) throw new Error("caju-ui: no element matches " + sel)
          el.__uid = id
          nodes.set(id, el)
          cursor.clear()
          break
        }
        case 104: case 106: {                                              // h, j
          const id = num(), pid = num(), v = str()
          const parent = nodes.get(pid)
          let n = cursor.has(pid) ? cursor.get(pid) : parent.firstChild
          while (n && n.nodeType === 8) n = n.nextSibling                  // <!-- --> separators
          const fits = op === 104
            ? n && n.nodeType === 1 && n.tagName.toLowerCase() === v.toLowerCase()
            : n && n.nodeType === 3
          let node = n
          if (fits) {
            cursor.set(pid, n.nextSibling)
            if (op === 106 && n.data !== v) n.data = v
            // a field the user changed before the program started: hydration keeps what they
            // typed or picked (the program learns it from an input/change event, see L)
            if (op === 104 && edited(n)) {
              n.__kept = true
              setTimeout(() => { n.__kept = false }, 0)
            }
          } else {
            // the server's HTML differs here: create the node (and warn, in development)
            if (cfg.dev && !hotStart) console.warn("caju-ui: hydration mismatch in", parent, "expected", op === 104 ? "<" + v + ">" : JSON.stringify(v), "found", n)
            if (op === 106) node = document.createTextNode(v)
            else if (v === "svg" || (parent.namespaceURI === SVG && parent.tagName !== "foreignObject")) node = document.createElementNS(SVG, v)
            else node = document.createElement(v)
            parent.insertBefore(node, n || null)
            cursor.set(pid, n || null)
          }
          node.__uid = id
          nodes.set(id, node)
          break
        }
        case 122: {                                                        // z
          const pid = num()
          const parent = nodes.get(pid)
          let n = cursor.has(pid) ? cursor.get(pid) : parent.firstChild
          while (n) { const next = n.nextSibling; n.remove(); n = next }
          cursor.delete(pid)
          break
        }
        case 65: {                                                         // A
          const id = num(), sel = str()
          const el = document.querySelector(sel)
          if (!el) throw new Error("caju-ui: no element matches " + sel)
          el.textContent = ""
          el.__uid = id
          nodes.set(id, el)
          break
        }
        case 69: case 78: {                                                // E, N
          const id = num(), tag = str()
          const el = op === 78 ? document.createElementNS(SVG, tag) : document.createElement(tag)
          el.__uid = id
          nodes.set(id, el)
          break
        }
        case 101: case 110: {                                              // e, n
          const id = num(), parent = nodes.get(num()), tag = str()
          const el = op === 110 ? document.createElementNS(SVG, tag) : document.createElement(tag)
          el.__uid = id
          nodes.set(id, el)
          parent.appendChild(el)
          break
        }
        case 120: {                                                        // x
          const id = num(), parent = nodes.get(num())
          const t = document.createTextNode(str())
          t.__uid = id
          nodes.set(id, t)
          parent.appendChild(t)
          break
        }
        case 75: {                                                         // K
          const el = nodes.get(num())
          for (let c = el.firstChild; c; c = c.nextSibling) forget(c)
          el.textContent = ""
          break
        }
        case 88: {                                                         // X
          const id = num()
          const t = document.createTextNode(str())
          t.__uid = id
          nodes.set(id, t)
          break
        }
        case 83: {                                                         // S
          const el = nodes.get(num()), name = str(), v = str()
          if (kept(el, name)) break
          if (name === "value") {
            // the user is typing in it faster than the program answers: keep what they typed
            if (el.__typed > answered && document.activeElement === el) break
            if (el.value !== v) el.value = v
          } else if (name === "checked" || name === "selected") {
            el[name] = true
          }
          // (when hydrating, the server usually wrote it already)
          if (el.getAttribute(name) !== v) el.setAttribute(name, v)
          break
        }
        case 82: {                                                         // R
          const el = nodes.get(num()), name = str()
          if (kept(el, name)) break
          if (name === "value") el.value = ""
          else if (name === "checked" || name === "selected") el[name] = false
          el.removeAttribute(name)
          break
        }
        case 84: nodes.get(num()).data = str(); break                      // T
        case 73: {                                                         // I
          const parent = nodes.get(num()), child = nodes.get(num()), before = num()
          parent.insertBefore(child, before ? nodes.get(before) : null)
          break
        }
        case 68: {                                                         // D
          const n = nodes.get(num())
          if (n) { n.remove(); forget(n) }
          break
        }
        case 76: {                                                         // L
          const el = nodes.get(num()), type = str(), mods = str()
          ;(el.__mods || (el.__mods = {}))[type] = mods
          el.addEventListener(type, onEvent)
          if (el.__kept && (type === "input" || type === "change")) setTimeout(() => el.dispatchEvent(new Event(type, { bubbles: true })), 0)
          break
        }
        case 85: {                                                         // U
          const el = nodes.get(num())
          el.removeEventListener(str(), onEvent)
          break
        }
        case 77: {                                                         // M
          const id = num(), ms = num(), rep = num()
          const fire = () => send("t" + id + ",")
          timers.set(id, rep ? setInterval(fire, ms) : setTimeout(() => { timers.delete(id); fire() }, ms))
          break
        }
        case 67: {                                                         // C
          const id = num()
          clearTimeout(timers.get(id)); clearInterval(timers.get(id))
          timers.delete(id)
          break
        }
        case 80: {                                                         // P
          const el = nodes.get(num()), w = num(), h = num(), px = bytes()
          if (el && el.getContext && px.length === w * h * 4) {
            if (el.width !== w) el.width = w
            if (el.height !== h) el.height = h
            el.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0)
          }
          break
        }
        case 70: { const el = nodes.get(num()); if (el && el.focus) el.focus(); break }   // F
        case 90: { const s = str(); if (snapshotWait) snapshotWait(s); break }            // Z
        case 87: { copyText(str()); break }                                               // W
        case 74: {                                                                         // J
          const id = num(), name = str(), arg = str()
          const fn = (window.__UI_FNS__ || {})[name] || builtins[name]
          if (!fn) { console.error("caju-ui: ui.call: no page function " + name + " (window.__UI_FNS__)"); break }
          const g = gen       // a reply after a hot reload is not for the new program
          const reply = (v) => { if (g === gen) send("c" + id + "," + S(String(v))) }
          try {
            const r = fn(arg, reply)
            if (r && typeof r.then === "function") r.then((v) => { if (v !== undefined) reply(v) }, (e) => console.error(e))
            else if (r !== undefined) reply(r)
          } catch (e) { console.error(e) }
          break
        }
        case 33: { const s = str(); console.error(s); overlay(s); break }                 // !
        default: throw new Error("caju-ui: unknown patch op " + op + " at " + (p - 1))
      }
    }
  }

  // ---- the program ---------------------------------------------------------------------------
  // what the server put in the page (ui.page): the components' state and the data for ui.data()
  const json = (id) => { const el = document.getElementById(id); return el ? el.textContent : "" }
  const pageData = json("__ui_data")
  const ssrValues = json("__ui_ssr")

  function start(url, state) {
    const sab = new SharedArrayBuffer(8 + BOX)
    ctl = new Int32Array(sab, 0, 2)
    box = new Uint8Array(sab, 8)
    queue = []
    seq = 0
    answered = 0
    gen++
    worker = new Worker(cfg.worker || "__ui/worker.js", { type: "module" })
    worker.onmessage = (m) => {
      const d = m.data
      switch (d.t) {
        case "patch": {
          const t0 = performance.now()
          try { apply(d.data) } catch (e) { console.error(e); overlay(String(e.stack || e)) }
          // opt-in timing: set window.__UI_STATS__ = [] to collect it
          if (window.__UI_STATS__) window.__UI_STATS__.push({ at: t0, apply: performance.now() - t0, bytes: d.data.length })
          break
        }
        case "ack": pump(); break
        case "out": console.log(d.s); break
        case "err": console.error(d.s); if (/panic|error/i.test(d.s)) overlay(d.s); break
        case "exit": if (d.code !== 0) overlay("The program exited with code " + d.code + " (see the console)."); break
        case "crash": console.error(d.s); overlay(d.s); break
      }
    }
    worker.onerror = (e) => overlay("worker: " + (e.message || e))
    worker.postMessage({ t: "start", url: new URL(url, location.href).href, sab })
    // a hot reload loads fresh data instead of the server's (ssrValues are for the first start)
    send("i" + S(state || "") + S(pageData) + S(hotStart ? "" : ssrValues))
  }

  function stop() {
    for (const abort of fetches.values()) abort("canceled")
    fetches.clear()
    if (worker) worker.terminate()
    worker = null
    ctl = null
    for (const t of timers.values()) { clearTimeout(t); clearInterval(t) }
    timers.clear()
    nodes.clear()
  }

  function snapshot() {
    return new Promise((resolve) => {
      if (!worker) return resolve("")
      const done = setTimeout(() => { snapshotWait = null; resolve("") }, 1000)
      snapshotWait = (s) => { clearTimeout(done); snapshotWait = null; resolve(s) }
      send("s")
    })
  }

  // ---- development: hot reload and the error overlay -----------------------------------------
  let box_ = null
  function overlay(text) {
    if (!cfg.dev) return
    if (!box_) {
      box_ = document.createElement("div")
      box_.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(20,10,10,.92);color:#ffd7cc;" +
        "font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:28px;overflow:auto;white-space:pre-wrap"
      box_.onclick = () => hide()
      document.body.appendChild(box_)
    }
    box_.textContent = "caju-ui\n\n" + text + "\n\n(click to dismiss)"
  }
  function hide() { if (box_) { box_.remove(); box_ = null } }
  function fatal(text) { console.error(text); cfg.dev = true; overlay(text) }

  async function hot(v) {
    const t0 = performance.now()
    const state = await snapshot()
    stop()
    hide()
    hotStart = true
    start(cfg.wasm + "?v=" + v, state)
    console.info("[caju-ui] hot reload v" + v + " in " + Math.round(performance.now() - t0) + " ms")
  }

  function reloadCss() {
    for (const l of document.querySelectorAll("link[rel=stylesheet]")) {
      const u = new URL(l.href)
      u.searchParams.set("v", Date.now())
      l.href = u.href
    }
  }

  async function poll() {
    try {
      const r = await fetch("/__ui/poll?v=" + cfg.v, { cache: "no-store" })
      const j = await r.json()
      if (j.sid !== cfg.sid) return location.reload()
      if (j.v > cfg.v) {
        cfg.v = j.v
        if (j.kind === "full") return location.reload()
        if (j.kind === "css") reloadCss()
        else await hot(j.v)
      }
      if (j.error) {
        overlay(j.error)
        if (box_) box_.dataset.build = "1"
      } else if (box_ && box_.dataset.build) {
        hide()
      }
    } catch (e) {}
    setTimeout(poll, 250)
  }

  start(cfg.wasm || "__ui/app.wasm", json("__ui_state"))
  if (cfg.dev) poll()
})()
