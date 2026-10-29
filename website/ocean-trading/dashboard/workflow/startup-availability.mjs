// A physical preflight failure cannot grant execution authority. This narrow
// fallback keeps authenticated projections available until an operator fixes
// the pin and starts a new process; there is no in-process upgrade to READY.
export const OPTIONAL_PHYSICAL_READINESS_ERRORS = Object.freeze(['OPERATIONAL_TELEMETRY_MODULE_HASH_CONFLICT']);

const isRead = route => /^(?:readiness|session|me|status|view\/dashboard)$/.test(route)
  || /^view\/strategies(?:\/page\/\d+|\/[A-Za-z0-9_.:-]+)?$/.test(route)
  || /^vwap-improvement-monitor\/reports\/[a-z_]+$/.test(route);

function latchReadOnly(backend, error) {
  const blocker = Object.freeze({ code: error.code,
    message: error.code }); // Do not expose arbitrary exception details or paths.
  const availability = Object.freeze({ state: 'DEGRADED_READ_ONLY', read_only: true,
    mutations_enabled: false, physical_readiness: Object.freeze({ state: 'BLOCKED', blocker, latched: true }) });
  backend.workflowAvailability = availability;
  backend.stopMaintenance?.();
  backend.operationalCandidateEvaluator?.stop();
  backend.operationalResearch?.stop();
  backend.operationalLearning?.stop();
  backend.onboardingBrain?.stop();
  // No Paperclip interactions GET: that provider route expires interactions.
  delete backend.environment.OCEAN_PAPERCLIP_INTERACTION_CONFIG;
  const handle = backend.handle.bind(backend);
  backend.handle = async (request, response, url) => {
    const route = url.pathname.slice('/api/workflow/'.length);
    const authenticationOnly = request.method === 'POST' && ['session', 'session/logout'].includes(route);
    if (!(request.method === 'GET' && isRead(route)) && !authenticationOnly) {
      try {
        backend.auth.authenticate(request, request.method !== 'GET');
        response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: blocker, workflow_availability: availability }));
      } catch (authError) {
        response.writeHead(authError.status || 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: { code: authError.code || 'AUTHENTICATION_FAILED' } }));
      }
      return true;
    }
    // Let the existing handler retain all origin, session, role, path and query
    // checks. Decorate only its JSON projections, never attachment bytes.
    if (!route.startsWith('vwap-improvement-monitor/reports/')) {
      const end = response.end;
      response.end = function (chunk, ...args) {
        if (typeof chunk === 'string' && (response.statusCode || 200) === 200) {
          try {
            const body = JSON.parse(chunk);
            body.workflow_availability = availability;
            if (route === 'readiness') {
              body.state = availability.state;
              body.execution = 'READ_ONLY';
              body.workflow = { ...body.workflow, ...availability };
            }
            chunk = JSON.stringify(body);
          } catch { /* Non-JSON responses keep their original bytes. */ }
        }
        return end.call(this, chunk, ...args);
      };
    }
    return handle(request, response, url);
  };
  return backend;
}

export function initializeAvailableWorkflow({ environment, python, createBackend, reconcile }) {
  const binding = environment.OCEAN_OPERATIONAL_LEARNING_PHYSICAL_BINDING_FILE;
  // Constructors start workers immediately. Hold them before construction,
  // avoiding an in-flight publication/dispatch before the synchronous preflight.
  const heldEnvironment = binding ? { ...environment, OCEAN_ONBOARDING_BRAIN_SYNC: '0',
    OCEAN_OPERATIONAL_LEARNING_ENABLED: '0' } : environment;
  const backend = createBackend(heldEnvironment, python);
  if (!backend || !binding) return backend;
  try {
    reconcile(backend, binding);
    for (const key of ['OCEAN_ONBOARDING_BRAIN_SYNC', 'OCEAN_OPERATIONAL_LEARNING_ENABLED']) {
      if (Object.hasOwn(environment, key)) backend.environment[key] = environment[key];
      else delete backend.environment[key];
    }
    backend.onboardingBrain.enabled = environment.OCEAN_ONBOARDING_BRAIN_SYNC !== '0';
    backend.operationalLearning.enabled = environment.OCEAN_OPERATIONAL_LEARNING_ENABLED === '1';
    backend.config.onboarding_brain_sync.enabled = backend.onboardingBrain.enabled;
    backend.config.operational_learning.enabled = backend.operationalLearning.enabled;
    backend.onboardingBrain.start();
    backend.operationalCandidateEvaluator.start();
    backend.operationalLearning.start();
    return backend;
  } catch (error) {
    if (OPTIONAL_PHYSICAL_READINESS_ERRORS.includes(error.code)) return latchReadOnly(backend, error);
    backend.close();
    throw error;
  }
}
