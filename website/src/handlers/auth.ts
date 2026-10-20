/**
 * Shared server-to-server authentication: constant-time comparison of the
 * dedicated integration secret. Used by create, cancel and verify handlers so
 * the check cannot drift between them.
 */

import { constantTimeEqual } from "../domain/tokens";
import { unauthorized } from "../domain/errors";
import { CheckoutLogger, nullLogger } from "../domain/log";
import { HandlerRequest } from "./http";

export async function requireBotAuth(
  botApiSecret: string,
  req: HandlerRequest,
  logger?: CheckoutLogger,
): Promise<void> {
  const expected = req.authorization ?? "";
  const scheme = expected.slice(0, 7).toLowerCase();
  const provided = scheme === "bearer " ? expected.slice(7) : "";
  if (
    provided.length === 0 ||
    botApiSecret.length === 0 ||
    !(await constantTimeEqual(provided, botApiSecret))
  ) {
    (logger ?? nullLogger).log("auth_rejected", {
      path_kind: "server_to_server",
      client_ip: req.clientIp,
    });
    throw unauthorized();
  }
}
