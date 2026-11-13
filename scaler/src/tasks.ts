import { CloudTasksClient } from "@google-cloud/tasks";
import type { ReconcileRequest, RerunRequest, TasksPort } from "./ports.js";

const ALREADY_EXISTS = 6; // gRPC status code

export class CloudTasksQueue implements TasksPort {
  private readonly client = new CloudTasksClient();

  constructor(
    private readonly queue: string,
    private readonly invokerServiceAccount: string,
    private readonly audience: string,
  ) {}

  enqueueReconcile(name: string, body: ReconcileRequest, scheduleAt: Date, baseUrl: string): Promise<boolean> {
    return this.enqueue("reconcile", name, body, scheduleAt, baseUrl);
  }

  enqueueRerun(name: string, body: RerunRequest, scheduleAt: Date, baseUrl: string): Promise<boolean> {
    return this.enqueue("rerun", name, body, scheduleAt, baseUrl);
  }

  private async enqueue(path: string, name: string, body: unknown, scheduleAt: Date, baseUrl: string): Promise<boolean> {
    try {
      await this.client.createTask({
        parent: this.queue,
        task: {
          name: `${this.queue}/tasks/${name}`,
          scheduleTime: { seconds: Math.floor(scheduleAt.getTime() / 1000) },
          // Match the Cloud Run request timeout (terraform/scaler.tf): a full multi-region stockout
          // sweep can outlast the 10-minute default.
          dispatchDeadline: { seconds: 900 },
          httpRequest: {
            httpMethod: "POST",
            url: `${baseUrl}/${path}`,
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify(body)).toString("base64"),
            oidcToken: { serviceAccountEmail: this.invokerServiceAccount, audience: this.audience },
          },
        },
      });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === ALREADY_EXISTS) return false;
      throw err;
    }
  }
}
