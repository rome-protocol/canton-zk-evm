/** A value that must never be printed, logged or sent: it shows as "[hidden]" however it is turned into text, and is read only by `reveal()`. */
export class Secret {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString(): string { return "[hidden]"; }
  toJSON(): string { return "[hidden]"; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return "[hidden]"; }
}
