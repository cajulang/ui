// Where caju-ui's time goes for each operation: in the worker (from the click until the patches
// arrive: the event's trip, the Caju code, the patches' trip back) and on the page (applying the
// patches to the DOM). Run node run.mjs first (it builds caju/dist).
import { chromium } from "playwright"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { join, extname, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const dir = join(dirname(fileURLToPath(import.meta.url)), "caju/dist")
const types = { ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html" }
const s = createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp")
  try {
    const f = join(dir, p === "/" ? "index.html" : p)
    res.setHeader("Content-Type", types[extname(f)] || "")
    res.end(readFileSync(f))
  } catch { res.statusCode = 404; res.end() }
}).listen(5180)

const b = await chromium.launch()
const p = await b.newPage()
await p.goto("http://127.0.0.1:5180/")
await p.waitForSelector("#run")
for (const [sel, n] of [["#run", 1000], ["#run", 1000], ["#update", 1000], ["#add", 2000], ["#clear", 0], ["#runlots", 10000]]) {
  const r = await p.evaluate(async ([sel, n]) => {
    window.__UI_STATS__ = []
    const t0 = performance.now()
    document.querySelector(sel).click()
    while (document.querySelectorAll("#tbody > tr").length !== n || !window.__UI_STATS__.some((x) => x.apply)) await new Promise((r) => setTimeout(r, 1))
    const st = window.__UI_STATS__.filter((x) => x.apply)
    return { total: performance.now() - t0, worker: st[0].at - t0, dom: st.reduce((a, x) => a + x.apply, 0), patchKB: st.reduce((a, x) => a + x.bytes, 0) / 1024 }
  }, [sel, n])
  console.log(sel.padEnd(10), String(n).padStart(5), Object.entries(r).map(([k, v]) => k + "=" + v.toFixed(1)).join("  "))
}
await b.close()
s.close()
