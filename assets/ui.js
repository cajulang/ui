// caju-ui page runtime: starts the program in a worker (worker.js), applies the DOM patches it
// sends, forwards DOM events and timers back to it and, in development, hot reloads it when the
// code changes (keeping the components' state). See ui.caju for the protocol.
(() => {
  "use strict"
  const cfg = window.__UI__ || {}
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
        case 33: { const s = str(); console.error(s); overlay(s); break }                 // !
        default: throw new Error("caju-ui: unknown patch op " + op + " at " + (p - 1))
      }
    }
  }

  // ---- the program ---------------------------------------------------------------------------
  // what the server put in the page (ui.page): the components' state and the data for ui.data()
  const json = (id) => { const el = document.getElementById(id); return el ? el.textContent : "" }
  const pageData = json("__ui_data")

  function start(url, state) {
    const sab = new SharedArrayBuffer(8 + BOX)
    ctl = new Int32Array(sab, 0, 2)
    box = new Uint8Array(sab, 8)
    queue = []
    seq = 0
    answered = 0
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
    send("i" + S(state || "") + S(pageData))
  }

  function stop() {
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
