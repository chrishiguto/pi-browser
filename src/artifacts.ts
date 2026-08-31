import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ArtifactStoreOptions {
  baseRoot?: string;
  pid?: number;
}

export class ArtifactStore {
  readonly root: string;

  constructor(options: ArtifactStoreOptions = {}) {
    this.root = join(options.baseRoot ?? join(tmpdir(), "pi-browser"), String(options.pid ?? process.pid));
  }

  async allocate(extension = ".png"): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return join(this.root, `${randomUUID()}${extension}`);
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
