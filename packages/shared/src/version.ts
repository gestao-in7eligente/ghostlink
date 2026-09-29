/** True when the client's protocol version is inside the server's [min, max] range (spec §5.1). */
export function negotiateProtocol(clientProtocol: number, server: { min: number; max: number }): boolean {
  return Number.isInteger(clientProtocol) && clientProtocol >= server.min && clientProtocol <= server.max;
}
