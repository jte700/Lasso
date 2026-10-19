const DEFAULT_INTERVAL_MS = 2000;
const LAUNCHD_PID = 1;

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

/**
 * The desktop app starts this server as a child process. When the app crashes
 * or is force-quit, macOS hands the server to launchd and it would keep the
 * preferred port and the database open, so the next app launch would start a
 * second server beside it. Report that moment so the orphan can shut down.
 *
 * A Node launcher that forks rather than execs sits between the app and this
 * server, so the app's own process is checked as well as this server's parent.
 *
 * @param {{ expectedParentPid: number, onOrphaned: () => void, currentParentPid?: () => number,
 *   parentIsAlive?: (pid: number) => boolean, intervalMs?: number }} options
 * @returns {() => void} stops watching
 */
export function watchParent({ expectedParentPid, onOrphaned, currentParentPid = () => process.ppid,
  parentIsAlive = processIsAlive, intervalMs = DEFAULT_INTERVAL_MS }) {
  // A server started from a terminal has no app to outlive.
  if (!Number.isInteger(expectedParentPid) || expectedParentPid <= LAUNCHD_PID) return () => {};
  const timer = setInterval(() => {
    if (currentParentPid() !== LAUNCHD_PID && parentIsAlive(expectedParentPid)) return;
    clearInterval(timer);
    onOrphaned();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
