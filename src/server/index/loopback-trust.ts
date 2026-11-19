import { isIPv4 } from "node:net";
import { isLoopbackHostname } from "../auth-cors";
import type { ServerIngress } from "./serve-options";

export function trustedLoopbackForIngress(ingress: ServerIngress, hostname: string): boolean {
  // Management locality follows the bound socket, including all IPv4 loopback
  // aliases. Keep this separate from the data-plane auth exemption: deployments
  // may deliberately bind 127.0.0.2 behind a reverse proxy to require API keys.
  const boundHost = hostname.trim();
  const ipv4Loopback = isIPv4(boundHost) && boundHost.startsWith("127.");
  return ingress === "unauthenticated-loopback" || ingress === "local-control"
    || (ingress === "public" && (isLoopbackHostname(hostname) || ipv4Loopback));
}
