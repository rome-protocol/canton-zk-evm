// What the live check may sign: only the Bridge's own request. These tell a signing screen from a connection or a chain screen, and the Bridge's request from any other.

/** Says whether a wallet's signing screen shows the Bridge's request: the typed data's domain name or the start of its statement. */
export const bridgeRequestMatcher = (domainName: string, statement: string) => {
  const marks = [domainName, statement.slice(0, 40)].map((s) => s.toLowerCase());
  return (text: string): boolean => marks.some((m) => text.toLowerCase().includes(m));
};

/** A pop-up that asks for a signature (a message or typed data), as opposed to a connection, a chain or a switch. */
export const asksForSignature = (text: string): boolean => /signature request|sign typed data|sign message|sign this message|personal sign|sign-in request|requesting your signature/i.test(text);

/** The live check's decision about one pop-up: sign (or approve, if it is not a signature) only the Bridge's request; refuse any other signature request. */
export const decide = (text: string, showsBridge: (t: string) => boolean): "approve" | "refuse" => (asksForSignature(text) && !showsBridge(text) ? "refuse" : "approve");
