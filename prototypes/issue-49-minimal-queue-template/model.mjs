export const initialState = Object.freeze({
  phase: "idle",
  head: "abc1234",
  openTickets: 2,
  completedTickets: 0,
  finalFixUsed: false,
  nextDispatch: null,
  note: "等待维护者首次人工 dispatch"
});

export function transition(state, action) {
  if (action === "dispatch" && ["idle", "waiting"].includes(state.phase)) {
    return { ...state, phase: "ticket", nextDispatch: null, note: "远端 frontier 选择最小 issue；本 run 只处理这一票" };
  }

  if (action === "ticket-success" && state.phase === "ticket") {
    const openTickets = Math.max(0, state.openTickets - 1);
    return {
      ...state,
      phase: openTickets === 0 ? "final-review" : "continuation-ready",
      head: advanceHead(state.head),
      openTickets,
      completedTickets: state.completedTickets + 1,
      nextDispatch: openTickets === 0 ? "final-review" : "continue",
      note: openTickets === 0 ? "队列已清空，接力到首次 final review" : "发布完成事实后，接力到新的有界 run"
    };
  }

  if (action === "continue" && state.phase === "continuation-ready") {
    return { ...state, phase: "ticket", nextDispatch: null, note: "后继 run 从 GitHub 远端事实重新计算 frontier" };
  }

  if (action === "review-needs-fix" && state.phase === "final-review") {
    return { ...state, phase: "final-fix", nextDispatch: "final-fix", note: "首次 review 只授权当前 HEAD 的唯一一次 fix" };
  }

  if (action === "review-pass" && ["final-review", "final-rereview"].includes(state.phase)) {
    return { ...state, phase: "complete", nextDispatch: null, note: "HEAD 未变且 Queue 仍为空，执行链完成" };
  }

  if (action === "fix-success" && state.phase === "final-fix" && !state.finalFixUsed) {
    return {
      ...state,
      phase: "final-rereview",
      head: advanceHead(state.head),
      finalFixUsed: true,
      nextDispatch: "final-rereview",
      note: "fix 产生新 HEAD，只能进入独立复审"
    };
  }

  if (action === "waiting" && !["complete", "failed"].includes(state.phase)) {
    return { ...state, phase: "waiting", nextDispatch: null, note: "仍有未完成 Ticket 但 frontier 为空；成功暂停，不轮询" };
  }

  if (action === "fail") {
    return { ...state, phase: "failed", nextDispatch: null, note: "事实冲突、失败或不确定：fail closed，不自动接力" };
  }

  return { ...state, note: `动作 ${action} 在 ${state.phase} 阶段无效；状态未推进` };
}

function advanceHead(head) {
  const number = Number.parseInt(head.slice(0, 3), 16) + 1;
  return `${number.toString(16).padStart(3, "0")}${head.slice(3)}`;
}
