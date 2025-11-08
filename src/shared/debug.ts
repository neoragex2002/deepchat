export const DEBUG = {
  // ThreadPresenter audit logs: log only phase boundaries and key actions.
  // Keep logs concise: single-line JSON with { ts, tag, msgId, where, rev? }.
  TP_AUDIT_LOG: true
}

// Minimal legacy debug guard used by a few UI/Main debug prints.
// Keep default off to avoid noisy logs.
export const DEBUG_ROLLBACK_MIN = false
