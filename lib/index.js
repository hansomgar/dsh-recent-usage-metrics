/**
 * Host half of dsh-recent-usage-metrics.
 *
 * Everything the plugin shows is derived in the browser from the Chat snapshot the
 * Conversation layer already maintains: each settled assistant step carries its
 * `timing` (step start, first token, completion) and the provider `usage`. No Host
 * service, projection, or session event is added, so this row only makes the
 * package a Loader entry and publishes `./client` into the boot graph.
 */
export const name = 'dsh-recent-usage-metrics'

export function apply() {}
