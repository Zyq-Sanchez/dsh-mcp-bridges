/**
 * Permission policy for ACP reverse requests.
 *
 * Mirrors the semantics of `subagent-mcp`'s `_reject_permission` (MIT):
 * prefer an explicit `reject_once` / `reject_always` option, otherwise cancel.
 * Everything is fail-closed — the agent never gets a silent "allow".
 */

const REJECT_KINDS = ['reject_once', 'reject_always'];

export function chooseRejectOption(options = []) {
  for (const kind of REJECT_KINDS) {
    const option = options.find(
      (entry) => entry && entry.kind === kind && typeof entry.optionId === 'string',
    );
    if (option) return option;
  }
  return null;
}

/**
 * Answer a `session/request_permission` request.
 *
 * @param {object} params  ACP request params, including `options`.
 * @param {{ allow?: boolean, reason?: string }} [policy]
 * @returns {{ outcome: { outcome: string, optionId?: string } }}
 */
export function answerPermission(params, policy = {}) {
  const options = Array.isArray(params?.options) ? params.options : [];

  if (policy.allow === true) {
    const allow = options.find(
      (entry) => entry && /^allow/.test(entry.kind ?? '') && typeof entry.optionId === 'string',
    );
    if (!allow) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  }

  const reject = chooseRejectOption(options);
  if (reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}

/** Router for every reverse request the agent may send. */
export function createReverseHandler({ allowPermission = false } = {}) {
  return (method, params) => {
    if (method === 'session/request_permission') {
      return answerPermission(params, { allow: allowPermission });
    }
    return { __methodNotFound: true };
  };
}
