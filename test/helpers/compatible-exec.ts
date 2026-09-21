import { AGENT_BROWSER_VERSION, type PiExecutor } from "../../src/agent-browser.ts";

// Every engine request gates on a version probe, so tests that care about
// some other invocation would each have to model that probe themselves.
export const withCompatibleCli = (exec: PiExecutor): PiExecutor => (command, args, options) => args[0] === "--version"
  ? Promise.resolve({ code: 0, stdout: AGENT_BROWSER_VERSION, stderr: "", killed: false })
  : exec(command, args, options);
