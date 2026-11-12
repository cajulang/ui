// caju-ui vs React: the js-framework-benchmark operations, timed the same way in the same
// headless Chromium.
//
//   cd bench && npm install && node run.mjs [--runs 10]
//
// Each operation is timed from the click until the DOM shows the result and the next frame has
// started (requestAnimationFrame + setTimeout 0: layout and paint included). For caju-ui that
// includes the round trip to the worker. Each operation runs on a fresh page, with one warm-up
// run that is not counted; the table shows the median and the spread (min–max).
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { join, extname, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { build } from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 10
const CAJU = process.env.CAJU || "caju"
const CAJU_UI = process.env.CAJU_UI || join(here, "../build/caju-ui")

// ---- build both -------------------------------------------------------------------------------
console.log("building React (esbuild, production, minified)...")
mkdirSync(join(here, "react/dist"), { recursive: true })
await build({
  entryPoints: [join(here, "react/main.jsx")], bundle: true, minify: true, outfile: join(here, "react/dist/main.js"),
  define: { "process.env.NODE_ENV": '"production"' }, jsx: "automatic", logLevel: "warning",
})
writeFileSync(join(here, "react/dist/index.html"), readFileSync(join(here, "react/index.html")))
console.log("building caju-ui (caju-ui build)...")
execFileSync(CAJU_UI, ["build"], { cwd: join(here, "caju"), env: { ...process.env, CAJU }, stdio: "inherit" })

// ---- serve both (same headers) ----------------------------------------------------------------
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css" }
const css = readFileSync(join(here, "style.css"))
function serve(dir) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, "http://x").pathname)
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp")
      if (p === "/style.css") { res.setHeader("Content-Type", "text/css"); return res.end(css) }
      try {
        const f = join(dir, p === "/" ? "index.html" : p)
        const body = readFileSync(f)
        res.setHeader("Content-Type", types[extname(f)] || "application/octet-stream")
        res.end(body)
      } catch { res.statusCode = 404; res.end() }
    })
    s.listen(0, "127.0.0.1", () => resolve({ url: "http://127.0.0.1:" + s.address().port + "/", close: () => s.close() }))
  })
}
for (const d of ["react/dist", "caju/dist"]) {
  const f = join(here, d, "index.html")
  writeFileSync(f, readFileSync(f, "utf8").replace("</head>", '<link rel="stylesheet" href="/style.css"></head>').replace(/(<link rel="stylesheet" href="\/style.css">)+/, '<link rel="stylesheet" href="/style.css">'))
}
const apps = { React: await serve(join(here, "react/dist")), "caju-ui": await serve(join(here, "caju/dist")) }

// ---- the operations ---------------------------------------------------------------------------
const rows = "document.querySelectorAll('#tbody > tr')"
const cell = (i, c) => `(${rows}[${i}] && ${rows}[${i}].children[${c}].textContent)`
const ops = [
  { name: "create 1,000 rows", setup: [], click: "#run", until: `${rows}.length === 1000` },
  { name: "replace all 1,000 rows", setup: ["#run"], click: "#run", until: `${cell(0, 0)} !== PREV`, prev: cell(0, 0) },
  { name: "partial update (every 10th)", setup: ["#run"], click: "#update", until: `${cell(990, 1)}.endsWith(' !!!')` },
  { name: "select row", setup: ["#run"], click: `${rows}[1].children[1].firstChild`, js: true, until: `${rows}[1].className === 'danger'` },
  { name: "swap rows", setup: ["#run"], click: "#swaprows", until: `${cell(1, 0)} === PREV`, prev: cell(998, 0) },
  { name: "remove row", setup: ["#run"], click: `${rows}[4].children[2].firstChild`, js: true, until: `${rows}.length === 999` },
  { name: "create 10,000 rows", setup: [], click: "#runlots", until: `${rows}.length === 10000` },
  { name: "append 1,000 to 1,000", setup: ["#run"], click: "#add", until: `${rows}.length === 2000` },
  { name: "clear 1,000 rows", setup: ["#run"], click: "#clear", until: `${rows}.length === 0` },
  { name: "compute (Mandelbrot 600×400×1000, CPU)", setup: ["#clear"], click: "#compute", until: "document.querySelector('#result').textContent !== '0'", reset: true },
]

// runs in the page: clicks, waits for the condition and the next frame, returns the time in ms
const measure = async ({ click, js, until, prev }) => {
  const PREV = prev ? (0, eval)(prev) : null
  const cond = new Function("PREV", "return " + until)
  const target = js ? (0, eval)(click) : document.querySelector(click)
  // the main thread's long tasks (> 50 ms) while the operation runs: the page is frozen then
  let longest = 0
  const lt = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration) })
  lt.observe({ type: "longtask" })
  const t0 = performance.now()
  target.click()
  await new Promise((resolve) => {
    if (cond(PREV)) return resolve()
    const mo = new MutationObserver(() => { if (cond(PREV)) { mo.disconnect(); resolve() } })
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  })
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  const t = performance.now() - t0
  await new Promise((r) => setTimeout(r, 20))
  for (const e of lt.takeRecords()) longest = Math.max(longest, e.duration)
  lt.disconnect()
  return { t, longest }
}

// clicks a setup button and waits for the table to settle
const settle = async (page, sel) => {
  await page.evaluate(async (sel) => {
    const before = document.querySelectorAll("#tbody > tr").length + ":" + (document.querySelector("#tbody > tr td") || {}).textContent
    document.querySelector(sel).click()
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 5))
      const now = document.querySelectorAll("#tbody > tr").length + ":" + (document.querySelector("#tbody > tr td") || {}).textContent
      if (now !== before) break
    }
    await new Promise((r) => setTimeout(r, 50))
  }, sel)
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }

const browser = await chromium.launch()
const results = {}
const blocked = {}
for (const [name, app] of Object.entries(apps)) {
  results[name] = {}
  blocked[name] = {}
  // startup: navigation to the first rendered button
  const starts = []
  for (let i = 0; i < 5; i++) {
    const page = await browser.newPage()
    await page.goto(app.url)
    await page.waitForSelector("#run")
    starts.push(await page.evaluate(() => performance.now()))
    await page.close()
  }
  results[name]["startup (load to first render)"] = starts.slice(1)
  for (const op of ops) {
    const page = await browser.newPage()
    await page.goto(app.url)
    await page.waitForSelector("#run")
    const times = []
    const longs = []
    for (let i = 0; i <= RUNS; i++) {
      // an operation whose result stays on the page runs on a fresh load each time
      if (op.reset && i > 0) {
        await page.reload()
        await page.waitForSelector("#run")
        await page.waitForTimeout(100)
      }
      if (op.setup.length === 0) await settle(page, "#clear")
      for (const s of op.setup) await settle(page, s)
      const m = await page.evaluate(measure, op)
      if (i > 0) { times.push(m.t); longs.push(m.longest) }
    }
    results[name][op.name] = times
    blocked[name][op.name] = longs
    process.stdout.write(`  ${name.padEnd(8)} ${op.name.padEnd(30)} ${median(times).toFixed(1)} ms\n`)
    await page.close()
  }
}
await browser.close()
for (const a of Object.values(apps)) a.close()

// ---- sizes ------------------------------------------------------------------------------------
const size = (files) => {
  let raw = 0, gz = 0
  for (const f of files) { const b = readFileSync(f); raw += b.length; gz += gzipSync(b, { level: 9 }).length }
  return { raw, gz }
}
const cajuFiles = readdirSync(join(here, "caju/dist/__ui")).map((f) => join(here, "caju/dist/__ui", f))
const sizes = { React: size([join(here, "react/dist/main.js")]), "caju-ui": size(cajuFiles) }

// ---- report -----------------------------------------------------------------------------------
const kb = (n) => (n / 1024).toFixed(0) + " KB"
const names = Object.keys(results)
let md = `# caju-ui vs React\n\n${new Date().toISOString().slice(0, 10)} · headless Chromium (Playwright ${JSON.parse(readFileSync(join(here, "node_modules/playwright/package.json"))).version}) · React 18.3.1 production build · ${RUNS} runs per operation (median, min–max), after one warm-up run · lower is better\n\n`
md += `| operation | ${names.join(" | ")} | caju-ui / React |\n|---|${names.map(() => "--:").join("|")}|--:|\n`
for (const op of Object.keys(results.React)) {
  const cells = names.map((n) => { const t = results[n][op]; return `${median(t).toFixed(1)} ms <sub>(${Math.min(...t).toFixed(0)}–${Math.max(...t).toFixed(0)})</sub>` })
  const ratio = median(results["caju-ui"][op]) / median(results.React[op])
  md += `| ${op} | ${cells.join(" | ")} | ${ratio.toFixed(2)}× |\n`
}
md += `\nThe longest task on the page's main thread during each operation (the time the page cannot react to input; tasks under 50 ms are not reported by the browser, shown as "< 50"):\n\n| operation | ${names.join(" | ")} |\n|---|${names.map(() => "--:").join("|")}|\n`
for (const op of Object.keys(blocked.React)) {
  md += `| ${op} | ${names.map((n) => { const v = median(blocked[n][op]); return v < 50 ? "< 50 ms" : v.toFixed(0) + " ms" }).join(" | ")} |\n`
}
md += `\n| size | ${names.join(" | ")} |\n|---|${names.map(() => "--:").join("|")}|\n`
md += `| code shipped (raw) | ${names.map((n) => kb(sizes[n].raw)).join(" | ")} |\n`
md += `| code shipped (gzip) | ${names.map((n) => kb(sizes[n].gz)).join(" | ")} |\n`
writeFileSync(join(here, "RESULTS.md"), md)
writeFileSync(join(here, "results.json"), JSON.stringify({ results, blocked, sizes }, null, 1))
console.log("\n" + md)
