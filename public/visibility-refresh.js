// Scheduled UI refreshes run only while their surface is visible. Explicit
// startup loads and resume events share the same single request.
export function createVisibilityRefresh({ load, apply, onError, visible = true, interval = 5000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let projectId = null;
  let timer = null;
  let flight = null;
  let revision = 0;

  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    clearScheduled();
    if (!visible || !projectId || flight) return;
    timer = setTimer(() => {
      timer = null;
      void refresh({ silent: true });
    }, interval);
  }

  function refresh({ silent = false } = {}) {
    clearScheduled();
    const requestedProject = projectId;
    const requestedRevision = revision;
    if (!requestedProject) return Promise.resolve();
    if (flight) {
      if (flight.projectId === requestedProject && !flight.controller.signal.aborted) return flight.promise;
      return flight.promise.then(() => {
        if (requestedRevision !== revision || requestedProject !== projectId) return;
        return refresh({ silent });
      });
    }
    const controller = new AbortController();
    const request = { projectId: requestedProject, controller, promise: null };
    flight = request;
    request.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return load(requestedProject, controller.signal);
    }).then(result => {
      if (!controller.signal.aborted && requestedRevision === revision && requestedProject === projectId) {
        apply(result, requestedProject);
      }
    }).catch(error => {
      const cancelled = controller.signal.aborted;
      controller.abort();
      if (!cancelled && !silent) onError?.(error);
    }).finally(() => {
      if (flight === request) flight = null;
      schedule();
    });
    return request.promise;
  }

  return {
    refresh,
    setProject(nextProjectId) {
      if (nextProjectId === projectId) return;
      revision += 1;
      projectId = nextProjectId;
      flight?.controller.abort();
      schedule();
    },
    setVisible(nextVisible) {
      if (visible === nextVisible) return;
      visible = nextVisible;
      clearScheduled();
      if (!visible) {
        revision += 1;
        flight?.controller.abort();
      }
      else if (projectId) void refresh({ silent: true });
    },
  };
}
