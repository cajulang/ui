// The js-framework-benchmark table in React 18 (the keyed "react-hooks" implementation's design:
// useReducer, a memoized Row, dispatch passed down).
import React, { memo, useReducer } from "react"
import { createRoot } from "react-dom/client"

const A = "pretty large big small tall short long handsome plain quaint clean elegant easy angry crazy helpful mushy odd unsightly adorable important inexpensive cheap expensive fancy".split(" ")
const C = "red yellow blue green pink brown purple brown white black orange".split(" ")
const N = "table chair house bbq desk car pony cookie sandwich burger pizza mouse keyboard".split(" ")

let seed = 1
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
let nextId = 1
const build = (count) => {
  const out = new Array(count)
  for (let i = 0; i < count; i++) out[i] = { id: nextId++, label: A[rnd(A.length)] + " " + C[rnd(C.length)] + " " + N[rnd(N.length)] }
  return out
}

const initial = { data: [], selected: 0, result: 0 }

// CPU-bound work: how many points of a 600×400 grid are in the Mandelbrot set (1,000 iterations)
function compute() {
  let inside = 0
  for (let py = 0; py < 400; py++) {
    const y0 = py / 200 - 1
    for (let px = 0; px < 600; px++) {
      const x0 = px / 200 - 2
      let x = 0, y = 0, i = 0
      while (i < 1000 && x * x + y * y <= 4) {
        const xt = x * x - y * y + x0
        y = 2 * x * y + y0
        x = xt
        i++
      }
      if (i === 1000) inside++
    }
  }
  return inside
}
function reducer(state, action) {
  const { data, selected } = state
  switch (action.type) {
    case "RUN": return { ...state, data: build(1000), selected: 0 }
    case "RUN_LOTS": return { ...state, data: build(10000), selected: 0 }
    case "ADD": return { ...state, data: data.concat(build(1000)) }
    case "UPDATE": {
      const d = data.slice(0)
      for (let i = 0; i < d.length; i += 10) d[i] = { ...d[i], label: d[i].label + " !!!" }
      return { ...state, data: d }
    }
    case "CLEAR": return { ...state, data: [], selected: 0 }
    case "SWAP_ROWS": {
      if (data.length <= 998) return state
      const d = data.slice(0); const t = d[1]; d[1] = d[998]; d[998] = t
      return { ...state, data: d }
    }
    case "REMOVE": {
      const i = data.findIndex((x) => x.id === action.id)
      return { ...state, data: [...data.slice(0, i), ...data.slice(i + 1)] }
    }
    case "SELECT": return { ...state, selected: action.id }
    case "COMPUTE": return { ...state, result: compute() }
  }
  return state
}

const Row = memo(({ item, selected, dispatch }) => (
  <tr className={selected ? "danger" : ""}>
    <td className="col-md-1">{item.id}</td>
    <td className="col-md-4"><a onClick={() => dispatch({ type: "SELECT", id: item.id })}>{item.label}</a></td>
    <td className="col-md-1"><a onClick={() => dispatch({ type: "REMOVE", id: item.id })}><span className="remove">x</span></a></td>
    <td className="col-md-6"></td>
  </tr>
), (a, b) => a.selected === b.selected && a.item === b.item)

const Button = ({ id, cb, title }) => (
  <div className="col-sm-6 smallpad">
    <button type="button" className="btn btn-primary btn-block" id={id} onClick={cb}>{title}</button>
  </div>
)

function Main() {
  const [{ data, selected, result }, dispatch] = useReducer(reducer, initial)
  return (
    <div className="container">
      <div className="jumbotron"><div className="row">
        <div className="col-md-6"><h1>React</h1></div>
        <div className="col-md-6"><div className="row">
          <Button id="run" title="Create 1,000 rows" cb={() => dispatch({ type: "RUN" })} />
          <Button id="runlots" title="Create 10,000 rows" cb={() => dispatch({ type: "RUN_LOTS" })} />
          <Button id="add" title="Append 1,000 rows" cb={() => dispatch({ type: "ADD" })} />
          <Button id="update" title="Update every 10th row" cb={() => dispatch({ type: "UPDATE" })} />
          <Button id="clear" title="Clear" cb={() => dispatch({ type: "CLEAR" })} />
          <Button id="swaprows" title="Swap Rows" cb={() => dispatch({ type: "SWAP_ROWS" })} />
          <Button id="compute" title="Compute" cb={() => dispatch({ type: "COMPUTE" })} />
        </div></div>
      </div></div>
      <p id="result">{result}</p>
      <table className="table table-hover table-striped test-data"><tbody id="tbody">
        {data.map((item) => <Row key={item.id} item={item} selected={selected === item.id} dispatch={dispatch} />)}
      </tbody></table>
    </div>
  )
}

createRoot(document.getElementById("main")).render(<Main />)
