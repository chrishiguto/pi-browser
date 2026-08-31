export const ENABLE_TOOL = "browser_enable";
export const CURRENT_WORKING_TOOLS = ["browser_open", "browser_run", "browser_fill", "browser_screenshot", "browser_close"] as const;
export const ALL_BROWSER_TOOLS = [
  ENABLE_TOOL,
  ...CURRENT_WORKING_TOOLS,
] as const;

const STATE_ENTRY = "pi-browser-state";

interface ActivationApi {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data?: unknown): void;
}

interface BranchEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface PersistedBrowserState {
  version: 1;
  enabled: boolean;
  headed?: boolean;
}

function validState(data: unknown): data is PersistedBrowserState {
  return Boolean(
    data
    && typeof data === "object"
    && (data as { version?: unknown }).version === 1
    && typeof (data as { enabled?: unknown }).enabled === "boolean"
    && ((data as { headed?: unknown }).headed === undefined || typeof (data as { headed?: unknown }).headed === "boolean"),
  );
}

export class BrowserState {
  enabled = false;
  headed = false;

  restore(branch: readonly unknown[]): void {
    this.enabled = false;
    this.headed = false;
    for (const candidate of branch) {
      if (!candidate || typeof candidate !== "object") continue;
      const entry = candidate as BranchEntry;
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && validState(entry.data)) {
        this.enabled = entry.data.enabled;
        this.headed = entry.data.headed ?? false;
      }
    }
  }

  reconcile(pi: Pick<ActivationApi, "getActiveTools" | "setActiveTools">): void {
    const owned = new Set<string>(ALL_BROWSER_TOOLS);
    const active = pi.getActiveTools().filter((name) => !owned.has(name));
    active.push(ENABLE_TOOL);
    if (this.enabled) active.push(...CURRENT_WORKING_TOOLS);
    pi.setActiveTools([...new Set(active)]);
  }

  setEnabled(pi: ActivationApi, enabled: boolean): void {
    this.enabled = enabled;
    this.reconcile(pi);
    this.persist(pi);
  }

  setHeaded(pi: ActivationApi, headed: boolean): void {
    this.headed = headed;
    this.persist(pi);
  }

  private persist(pi: Pick<ActivationApi, "appendEntry">): void {
    pi.appendEntry(STATE_ENTRY, { version: 1, enabled: this.enabled, headed: this.headed });
  }
}
