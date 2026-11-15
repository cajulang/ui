// Checks the page runtime's wallet bridge (assets/ui.js: ui.eth.providers, ui.eth.request,
// ui.eth.subscribe and page events) in node, without a browser: a fake window with EIP-6963
// wallets and a window.ethereum, and a fake worker that sends J ops and reads the messages the
// page puts in the mailbox.
//
//   node tools/eth-check.mjs
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

// ---- a fake page ---------------------------------------------------------------------------
const listeners = new Map()
const win = {
  __UI__: { worker: "w.js", wasm: "a.wasm" },
  crossOriginIsolated: true,
  addEventListener(type, f) { (listeners.get(type) || listeners.set(type, []).get(type)).push(f) },
  dispatchEvent(ev) { for (const f of listeners.get(ev.type) || []) f(ev); return true },
}
class Event { constructor(type) { this.type = type } }
class CustomEvent extends Event { constructor(type, init) { super(type); this.detail = init && init.detail } }

// an EIP-1193 provider whose answers the test sets
function provider(name, extra) {
  const on = new Map()
  return Object.assign({
    calls: [],
    answers: {},
    request(req) {
      this.calls.push(req)
      const a = this.answers[req.method]
      if (a instanceof Error || (a && a.code)) return Promise.reject(a)
      return Promise.resolve(typeof a === "function" ? a(req) : a)
    },
    on(type, f) { (on.get(type) || on.set(type, []).get(type)).push(f) },
    fire(type, data) { for (const f of on.get(type) || []) f(data) },
    count(type) { return (on.get(type) || []).length },
  }, extra)
}
const mm = provider("MetaMask", { isMetaMask: true })
const rabby = provider("Rabby")
const legacy = provider("Legacy", { isMetaMask: true })

// the wallets answer requestProvider (MetaMask also announces once on load, before the runtime)
const announce = (uuid, name, rdns, p) => win.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
  detail: Object.freeze({ info: { uuid, name, icon: "data:image/svg+xml,<svg/>", rdns }, provider: p }),
}))
win.addEventListener("eip6963:requestProvider", () => {
  announce("uuid-mm", "MetaMask", "io.metamask", mm)
  announce("uuid-rabby", "Rabby Wallet", "io.rabby", rabby)
})

// the worker: the page posts "start" with the SharedArrayBuffer; we answer with patch batches
let worker = null
class Worker {
  constructor() { worker = this; this.inbox = [] }
  postMessage(m) { if (m.t === "start") { this.ctl = new Int32Array(m.sab, 0, 2); this.box = new Uint8Array(m.sab, 8) } }
  terminate() {}
  // takes what the page put in the mailbox, as the program's read of /dev/ui would
  read() {
    if (Atomics.load(this.ctl, 0) !== 1) return ""
    const s = new TextDecoder().decode(this.box.slice(0, Atomics.load(this.ctl, 1)))
    Atomics.store(this.ctl, 0, 0)
    this.onmessage({ data: { t: "ack" } })
    return s
  }
  patch(s) { this.onmessage({ data: { t: "patch", data: new TextEncoder().encode(s) } }) }
}

const S = (s) => Buffer.byteLength(s) + ":" + s
const ctx = {
  window: win, self: win, Event, CustomEvent, Worker, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder,
  URL, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, console,
  location: { href: "http://localhost/" },
  performance: { now: () => 0 },
  document: { getElementById: () => null, querySelector: () => null },
  navigator: {},
}
vm.createContext(ctx)

// all the messages the page sent since the last call
let got = ""
async function drain(ms) {
  await sleep(ms || 5)
  for (let i = 0; i < 20; i++) { got += worker.read(); await sleep(1) }
  const s = got
  got = ""
  return s
}
// the replies "c<id>,<len>:<text>" in a batch of messages
function replies(s) {
  const out = {}
  const re = /c(\d+),(\d+):/g
  let m
  while ((m = re.exec(s))) {
    const n = Number(m[2])
    out[m[1]] = s.substr(m.index + m[0].length, n)   // ASCII in these checks
    re.lastIndex = m.index + m[0].length + n
  }
  return out
}
const call = (id, name, arg) => worker.patch("Q0,J" + id + "," + S(name) + S(arg))

// MetaMask announces before the runtime loads (it is missed; the runtime asks again)
announce("uuid-early", "Early", "x.early", provider("Early"))
vm.runInContext(code, ctx)
check(worker && worker.ctl, "the runtime starts the program")
await drain()                                         // the init message

// ---- providers -------------------------------------------------------------------------------
call(1, "ui.eth.providers", "")
let r = replies(await drain(80))
let list = JSON.parse(r[1] || "[]")
check(list.map((p) => p.id).join() === "uuid-mm,uuid-rabby", "EIP-6963 providers, without a legacy entry: " + r[1])
check(list[0].rdns === "io.metamask" && list[0].is_metamask && list[0].icon.startsWith("data:"), "the provider's info")

win.ethereum = legacy
call(2, "ui.eth.providers", "{\"wait_ms\":0}")
list = JSON.parse(replies(await drain(20))[2] || "[]")
check(list.length === 3 && list[2].id === "injected" && list[2].is_metamask === true && list[2].name === "Injected (window.ethereum)", "window.ethereum is listed as injected when no 6963 provider is it")

win.ethereum = mm
call(3, "ui.eth.providers", "{\"wait_ms\":0}")
list = JSON.parse(replies(await drain(20))[3] || "[]")
check(list.length === 2, "window.ethereum that is an announced provider is not listed twice")

// ---- request ---------------------------------------------------------------------------------
mm.answers.eth_requestAccounts = ["0xd8da6bf26964af9d7eed9e03e53415d37aa96045"]
call(4, "ui.eth.request", JSON.stringify({ id: "uuid-mm", method: "eth_requestAccounts", params: [] }))
r = replies(await drain())
check(r[4] === "{\"result\":[\"0xd8da6bf26964af9d7eed9e03e53415d37aa96045\"]}", "a request's result: " + r[4])
check(JSON.stringify(mm.calls[0]) === "{\"method\":\"eth_requestAccounts\",\"params\":[]}", "the provider got {method, params}")

mm.answers.personal_sign = { code: 4001, message: "User rejected the request.", data: { x: 1 } }
call(5, "ui.eth.request", JSON.stringify({ id: "uuid-mm", method: "personal_sign", params: ["0x68", "0xd8da"] }))
r = replies(await drain())
check(r[5] === "{\"error\":{\"code\":4001,\"message\":\"User rejected the request.\",\"data\":{\"x\":1}}}", "an EIP-1193 error: " + r[5])

rabby.answers.wallet_switchEthereumChain = { code: -32603, message: "Unrecognized chain", data: { originalError: { code: 4902 } } }
call(6, "ui.eth.request", JSON.stringify({ id: "uuid-rabby", method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] }))
r = replies(await drain())
check(JSON.parse(r[6] || "{}").error.code === 4902, "a 4902 wrapped in -32603 is 4902")

rabby.answers.eth_chainId = () => { throw new Error("boom") }
call(7, "ui.eth.request", JSON.stringify({ id: "uuid-rabby", method: "eth_chainId" }))
r = replies(await drain())
check(r[7] === "{\"error\":{\"code\":-32603,\"message\":\"boom\",\"data\":null}}", "a thrown Error: " + r[7])
check(!("params" in rabby.calls[1]), "no params when the program gives none")

call(8, "ui.eth.request", JSON.stringify({ id: "nope", method: "eth_chainId" }))
r = replies(await drain())
check(JSON.parse(r[8] || "{}").error.code === 4900, "an unknown provider id")

win.ethereum = legacy
legacy.answers.eth_chainId = "0x1"
call(9, "ui.eth.request", JSON.stringify({ id: "injected", method: "eth_chainId", params: [] }))
check(replies(await drain())[9] === "{\"result\":\"0x1\"}", "the injected provider answers")

// ---- events ----------------------------------------------------------------------------------
call(10, "ui.eth.subscribe", JSON.stringify({ id: "uuid-mm" }))
call(11, "ui.eth.subscribe", JSON.stringify({ id: "uuid-mm" }))
r = replies(await drain())
check(r[10] === "{\"ok\":true}" && mm.count("accountsChanged") === 1, "subscribing twice listens once")
mm.fire("accountsChanged", ["0xabc"])
mm.fire("chainChanged", "0x89")
mm.fire("connect", { chainId: "0x1" })
mm.fire("disconnect", { code: 4900, message: "gone" })
const ev = await drain()
const want = "v" + S("ui.eth.accountsChanged") + S("{\"id\":\"uuid-mm\",\"data\":[\"0xabc\"]}") +
  "v" + S("ui.eth.chainChanged") + S("{\"id\":\"uuid-mm\",\"data\":\"0x89\"}") +
  "v" + S("ui.eth.connect") + S("{\"id\":\"uuid-mm\",\"data\":{\"chain_id\":\"0x1\"}}") +
  "v" + S("ui.eth.disconnect") + S("{\"id\":\"uuid-mm\",\"data\":{\"code\":4900,\"message\":\"gone\",\"data\":null}}")
check(ev === want, "the provider's events reach the program as page events: " + ev)

win.__UI_EMIT__("app.thing", "{\"n\":1}")
check(await drain() === "v" + S("app.thing") + S("{\"n\":1}"), "the app's page code sends its own page events")

console.log(failed ? failed + " failed" : "all passed")
process.exit(failed ? 1 : 0)
