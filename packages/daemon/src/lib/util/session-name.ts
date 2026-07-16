/**
 * A fresh, unique session name for the `$new` convention ("a fresh isolated session per
 * fire"). The `new-` prefix is a load-bearing contract in the message delivery path:
 * delivery-manager reclaims `new-*` in-memory session state once idle (they never recur)
 * and routes dead-lettered notices for a `new-*` thread to the mind level instead of a
 * session that will never run another turn. Kept in one place so the call sites that mint
 * these names (message delivery, system events) can't drift on the format.
 */
export function newEphemeralSession(): string {
  return `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
