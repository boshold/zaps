class TerminalOperationError extends Error {
  public override readonly name = "TerminalOperationError";
  public readonly code: "backend_unavailable" | "terminal_busy" | "cancelled";
  public readonly launched: boolean;

  public constructor(
    code: TerminalOperationError["code"],
    launched = false,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.code = code;
    this.launched = launched;
  }
}

export { TerminalOperationError };
