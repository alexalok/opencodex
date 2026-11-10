import { isLoopbackHostname } from "../auth-cors";
import { isClaudeInterceptedPath } from "../../claude/intercept/listener";

export type ServerIngress = "public" | "unauthenticated-loopback" | "hub-management" | "claude-intercept" | "hub-link" | "local-control";

export function trustedLoopbackForIngress(ingress: ServerIngress, hostname: string): boolean {
  return ingress === "unauthenticated-loopback" || ingress === "local-control" // IPv4 loopback aliases are local for management only; API keys still apply.
    || (ingress === "public" && (isLoopbackHostname(hostname) || /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname.trim())));
}

/**
 * Routes the Claude intercept TLS listener may reach. Everything else on that socket is relayed
 * to the real upstream by the listener itself, so a request that lands here with another path
 * is a bug, not a client — refuse it.
 */
export function claudeInterceptRouteAllowed(url: URL, req: Request): boolean {
  return isClaudeInterceptedPath(url.pathname, req.method);
}
