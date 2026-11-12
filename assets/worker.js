// caju-ui worker: runs the Caju program (WebAssembly) off the page's main thread, with the
// Linux system calls of caju-host.mjs. The program talks to the page through the virtual device
// /dev/ui: writing to it sends a batch of DOM patches (postMessage), reading from it blocks until
// the page has events (a SharedArrayBuffer mailbox, Atomics.wait). See ui.caju for the protocol.
import { runModule } from "./caju-host.mjs"

const dec = new TextDecoder()
const ENOENT = 2

self.onmessage = async (m) => {
  if (!m.data || m.data.t !== "start") return
  const { url, sab } = m.data
  const ctl = new Int32Array(sab, 0, 2)        // [0]: 1 when the mailbox is full, [1]: its length
  const box = new Uint8Array(sab, 8)

  const fsys = {
    cwd: () => "/",
    stat: () => { throw { errno: ENOENT } },
    open: (path) => {
      if (path !== "/dev/ui") throw { errno: ENOENT }
      return { buf: null }
    },
    // lseek(SEEK_END): os.read_file asks the size first, so this is where the program waits
    size: (h) => {
      if (h.buf) return h.buf.length
      while (Atomics.load(ctl, 0) === 0) Atomics.wait(ctl, 0, 0)
      const n = Atomics.load(ctl, 1)
      h.buf = box.slice(0, n)
      Atomics.store(ctl, 0, 0)
      self.postMessage({ t: "ack" })
      return n
    },
    read: (h, u8, pos) => {
      if (!h.buf) return 0
      const k = Math.min(u8.length, h.buf.length - pos)
      if (k <= 0) return 0
      u8.set(h.buf.subarray(pos, pos + k))
      return k
    },
    write: (h, data) => {
      const n = data.length          // read it before the transfer detaches the buffer
      self.postMessage({ t: "patch", data }, [data.buffer])
      return n
    },
    close: () => {},
    chmod: () => {},
  }

  const lines = (kind) => {
    let rest = ""
    return (b) => {
      rest += dec.decode(b, { stream: true })
      const parts = rest.split("\n")
      rest = parts.pop()
      for (const p of parts) self.postMessage({ t: kind, s: p })
    }
  }

  try {
    const mod = await WebAssembly.compileStreaming(fetch(url))
    const code = await runModule(mod, { args: ["app"], env: [], fsys, stdout: lines("out"), stderr: lines("err") })
    self.postMessage({ t: "exit", code })
  } catch (e) {
    self.postMessage({ t: "crash", s: String((e && e.stack) || e) })
  }
}
