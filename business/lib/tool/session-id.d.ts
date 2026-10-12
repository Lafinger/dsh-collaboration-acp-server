/**
 * Reading the current session id off a tool execution (ADR-0014).
 *
 * The chain is `exec.agent.session.id`, where `session.id` is a synchronous getter over the
 * session's durable header. Verified against the installed build: DSH itself reads
 * `agent.session.id` this way in 43 production call sites (the ACP server uses it to tag every
 * notification).
 *
 * This lives in one place because a second copy is a second chance to get the chain wrong —
 * and getting it wrong is not a loud failure: `undefined` would simply mean "no session",
 * which silently disables the identity check that the whole feature rests on.
 *
 * Read defensively rather than by type assertion: the plugin is loaded into a host whose runtime
 * objects are not ours, so every link is checked instead of assumed.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
export declare function sessionIdOf(exec: ToolRunContext): string | null;
