export default function (pi) {
  pi.on("session_start", (_event, ctx) => { ctx.ui.setStatus("startup", "启动 😀\nFull startup detail"); });
  pi.registerCommand("bridge-test-update", {
    description: "Local status observer compatibility test (no model)",
    handler: async (_args, ctx) => { ctx.ui.setStatus("startup", "Command detail"); },
  });
  pi.registerCommand("bridge-test-clear", {
    description: "Local status removal compatibility test (no model)",
    handler: async (_args, ctx) => { ctx.ui.setStatus("startup", undefined); },
  });
}
