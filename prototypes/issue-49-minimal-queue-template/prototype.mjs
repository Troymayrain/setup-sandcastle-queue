import { initialState, transition } from "./model.mjs";

const actions = new Map([
  ["d", "dispatch"],
  ["t", "ticket-success"],
  ["e", "continue"],
  ["r", "review-needs-fix"],
  ["p", "review-pass"],
  ["f", "fix-success"],
  ["w", "waiting"],
  ["x", "fail"]
]);

let state = { ...initialState };
const interactive = process.stdin.isTTY;

function render() {
  if (interactive) console.clear();
  const bold = interactive ? "\x1b[1m" : "";
  const dim = interactive ? "\x1b[2m" : "";
  const reset = interactive ? "\x1b[0m" : "";

  console.log(`${bold}PROTOTYPE — 最小 Queue Template 运行流程${reset}`);
  console.log(`${dim}Project-controlled template + upstream Sandcastle + GitHub remote facts${reset}\n`);
  console.log(`${bold}phase${reset}:            ${state.phase}`);
  console.log(`${bold}integration HEAD${reset}: ${state.head}`);
  console.log(`${bold}open tickets${reset}:     ${state.openTickets}`);
  console.log(`${bold}completed tickets${reset}:${state.completedTickets}`);
  console.log(`${bold}final fix used${reset}:   ${state.finalFixUsed}`);
  console.log(`${bold}next dispatch${reset}:    ${state.nextDispatch ?? "none"}`);
  console.log(`${bold}note${reset}:             ${state.note}\n`);
  console.log(`${bold}[d]${reset} dispatch/resume  ${bold}[t]${reset} ticket success  ${bold}[e]${reset} continuation`);
  console.log(`${bold}[r]${reset} review needs fix ${bold}[f]${reset} fix success     ${bold}[p]${reset} review pass`);
  console.log(`${bold}[w]${reset} waiting          ${bold}[x]${reset} fail closed     ${bold}[q]${reset} quit`);
}

render();

process.stdin.setEncoding("utf8");
if (interactive) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

process.stdin.on("data", chunk => {
  for (const key of chunk) {
    if (key === "q" || key === "") process.exit(0);
    const action = actions.get(key);
    if (action) state = transition(state, action);
    render();
  }
});
