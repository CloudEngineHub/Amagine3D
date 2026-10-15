import { cadArtifactVersion } from './cad-run-evidence.ts';

/** Serialize report refreshes; stop drains the queue so no old turn can publish late. */
export async function watchCadArtifacts(
  workspace: string,
  onChange: () => Promise<void>,
  isActive: () => boolean,
  intervalMs = 750,
): Promise<{ refresh: (force?: boolean) => void; stop: () => Promise<void> }> {
  let stopped = false;
  let version = await cadArtifactVersion(workspace);
  let pending = Promise.resolve();
  let queued = false;
  let forcePending = false;
  const refresh = (force = false) => {
    if (stopped || !isActive()) return;
    forcePending ||= force;
    if (queued) return;
    queued = true;
    pending = pending.then(async () => {
      try {
        const next = await cadArtifactVersion(workspace);
        const forced = forcePending;
        forcePending = false;
        if (!stopped && isActive() && (forced || next !== undefined && next !== version)) {
          await onChange();
          version = next;
        }
      } catch { /* A transient report read must not replace the CAD/model outcome. */ }
      finally { queued = false; }
    });
  };
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  return { refresh, stop: async () => { stopped = true; clearInterval(timer); await pending; } };
}
