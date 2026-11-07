/** The twin registry's answer for a lock: the id of the lock, the vaults it knows (a hint), and the receiver's acceptance contract. */
export interface LockParts { lockId: string; vaults?: string[]; acceptance?: string }

/** The registry refused the lock: 409 is a receiver that has not accepted twins; any other refusal is its own message. */
export class LockRefused extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export interface RegistryAdapter {
  lockParts(a: { receiver: string; ref: string }): Promise<LockParts>;
}

/** `POST <registry>/twin/v1/lock-parts`. The registry holds no key and writes nothing; the payer checks the lock id itself. */
export function registryClient(baseUrl: string, fetcher: typeof fetch = fetch): RegistryAdapter {
  return {
    async lockParts(a) {
      let res: Response;
      try {
        res = await fetcher(`${baseUrl}/twin/v1/lock-parts`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(a) });
      } catch {
        throw new LockRefused("The twin registry cannot be reached right now.", 0);
      }
      if (res.status === 409) throw new LockRefused("The receiver has not accepted twins yet. Its Canton party must accept twins once before a lock can be made for it.", 409);
      const body = (await res.json().catch(() => null)) as (Partial<LockParts> & { error?: string }) | null;
      if (!res.ok || !body || typeof body.lockId !== "string") throw new LockRefused(typeof body?.error === "string" ? body.error : "The twin registry did not give the parts of the lock.", res.status);
      return { lockId: body.lockId, vaults: body.vaults, acceptance: body.acceptance };
    },
  };
}
